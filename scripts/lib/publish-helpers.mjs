// publish-helpers.mjs — shared logic for auto-publishing site videos to
// YouTube (resumable upload) and Facebook (Graph API file_url).
// Runs inside the app container (has DB, DeepSeek, fs access to /uploads/videos).
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DEEPSEEK_API_KEY, log, sql, sqlSingle, escapeSql } from "./post-helpers.mjs";

// re-export log so the cron scripts can import it from here
export { log };

const DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash"; // API migrated from "deepseek-chat" to v4
const SITE = "https://puer.im";

// ---- env (set in container .env during Phase B) ----
export const YT = {
  clientId: process.env.YT_CLIENT_ID,
  clientSecret: process.env.YT_CLIENT_SECRET,
  refreshToken: process.env.YT_REFRESH_TOKEN,
};
export const FB = {
  pageId: process.env.FB_PAGE_ID,
  pageToken: process.env.FB_PAGE_ACCESS_TOKEN,
};
export const DRY_RUN = process.env.DRY_RUN === "1";
export const VIDEO_CONTAINER_DIR = "/app/public/uploads/videos";

// ---- candidate selection: essence + video + not yet published to platform ----
export async function pickCandidate(platform) {
  const rows = await sqlSingle(`
    SELECT a.id, a.title, a.summary, a.content, a."videoUrl"
    FROM articles a
    WHERE a.status = 'published'
      AND a.visibility = 'public'
      AND a."videoUrl" IS NOT NULL
      AND a."isEssence" = true
      AND NOT EXISTS (
        SELECT 1 FROM external_publishes ep
        WHERE ep."articleId" = a.id AND ep.platform = '${escapeSql(platform)}' AND ep.status = 'published'
      )
    ORDER BY a.upvotes DESC
    LIMIT 5
  `);
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

// ---- DeepSeek copy generation (mirrors src/lib/xhs-content.ts pattern) ----
async function deepseek(prompt) {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set");
  const res = await fetch(DEEPSEEK_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 900,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const text = (await res.json()).choices?.[0]?.message?.content?.trim() || "";
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("DeepSeek JSON parse failed");
  }
}

function plain(article) {
  return (article.content || "")
    .replace(/<[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .slice(0, 800);
}

// Read the music sidecar (written by generateVideo) → CC-BY attribution line.
async function musicAttribution(videoUrl) {
  if (!videoUrl) return "";
  try {
    const base = videoUrl.split("/").pop().replace(/\.[^.]+$/, "");
    const m = JSON.parse(await readFile(`/app/public/uploads/videos/${base}.music.json`, "utf-8"));
    if (m && m.track) {
      const lic = m.license ? ` [${m.license}, Jamendo]` : " [Jamendo]";
      const url = m.url ? ` ${m.url}` : "";
      return `\n🎵 背景音乐:${m.track} - ${m.artist || "未知"}${lic}${url}`;
    }
  } catch {}
  return "";
}

export async function genYoutubeCopy(article) {
  const prompt = `你是 YouTube 视频运营,擅长普洱茶内容。把下面论坛精华帖改写成一条 YouTube 视频的发布文案(中文)。
原帖标题:${article.title}
原帖内容(参考,需改写不要照抄):
${plain(article)}
严格按以下 JSON 返回(不要 markdown 代码块、不要解释):
{"title":"100字以内视频标题,含具体茶品/口感/年份等有信息量的词","description":"200-400字描述,口语化介绍视频内容,结尾单独一行写:更多普洱茶内容见 ${SITE}","tags":["3到5个YouTube搜索关键词,中文,不带#号"]}`;
  const c = await deepseek(prompt);
  if (!c.title || !c.description) throw new Error("YT copy incomplete");
  const attribution = await musicAttribution(article.videoUrl);
  return {
    title: String(c.title).slice(0, 100),
    description: String(c.description).slice(0, 4000) + attribution,
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 8).map(String) : [],
  };
}

export async function genFbCopy(article) {
  const prompt = `你是 Facebook 主页运营,擅长普洱茶内容。把下面论坛精华帖改写成一条 FB 视频发布文案(中文)。
原帖标题:${article.title}
原帖内容(参考):
${plain(article)}
严格按以下 JSON 返回(不要 markdown 代码块、不要解释):
{"title":"60字以内标题","caption":"100-200字口语正文,结尾单独一行写:${SITE}"}`;
  const c = await deepseek(prompt);
  if (!c.caption) throw new Error("FB copy incomplete");
  const attribution = await musicAttribution(article.videoUrl);
  return {
    title: String(c.title || article.title).slice(0, 100),
    caption: String(c.caption).slice(0, 3000) + attribution,
  };
}

// ---- YouTube: OAuth2 refresh + resumable upload (raw fetch, no SDK) ----
export async function getYoutubeAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT.clientId,
      client_secret: YT.clientSecret,
      refresh_token: YT.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`YT token refresh ${res.status}: ${t.slice(0, 160)}`);
    err.tokenFailed = true;
    throw err;
  }
  return (await res.json()).access_token;
}

export async function uploadYoutube({ filePath, title, description, tags }) {
  const token = await getYoutubeAccessToken();
  const buf = await readFile(filePath);
  const size = buf.length;

  // 1. initiate resumable session → Location header
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({
        snippet: { title, description, tags, categoryId: "24", defaultLanguage: "zh", defaultAudioLanguage: "zh" },
        status: { privacyStatus: "public", embeddable: true, selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!init.ok) {
    const err = new Error(`YT init ${init.status}: ${(await init.text()).slice(0, 200)}`);
    err.platform = "youtube";
    throw err;
  }
  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new Error("YT upload: no Location session URL");

  // 2. PUT file bytes (single chunk; these slideshow videos are small)
  const up = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
    body: buf,
  });
  if (!up.ok) {
    const err = new Error(`YT upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
    err.platform = "youtube";
    throw err;
  }
  const data = await up.json();
  if (!data.id) throw new Error(`YT upload: no video id in response`);
  return { id: data.id, url: `https://www.youtube.com/watch?v=${data.id}` };
}

// ---- Facebook: Graph API, FB fetches the public video URL ----
export async function uploadFacebook({ fileUrl, title, description }) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${FB.pageId}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: FB.pageToken,
      file_url: fileUrl,
      title,
      description,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.id) {
    const msg = data.error ? `${data.error.code}: ${data.error.message}` : `FB ${res.status}`;
    const err = new Error(`FB upload: ${msg}`.slice(0, 200));
    err.platform = "facebook";
    if (data.error && /access token|expire|190/i.test(data.error.message || "")) err.tokenFailed = true;
    throw err;
  }
  return { id: String(data.id), url: `https://www.facebook.com/${FB.pageId}/videos/${data.id}` };
}

// ---- record outcome (upsert so retries update the same row) ----
export async function recordPublish({ articleId, platform, externalId, externalUrl, title, status, error }) {
  const eid = externalId ? `'${escapeSql(externalId)}'` : "NULL";
  const eurl = externalUrl ? `'${escapeSql(externalUrl)}'` : "NULL";
  const ttl = title ? `'${escapeSql(title)}'` : "NULL";
  const err = error ? `'${escapeSql(String(error).slice(0, 300))}'` : "NULL";
  const pub = status === "published" ? "NOW()" : "NULL";
  await sql(`
    INSERT INTO external_publishes (id, "articleId", platform, "externalId", "externalUrl", title, status, error, "publishedAt")
    VALUES ('${randomUUID()}', '${escapeSql(articleId)}', '${escapeSql(platform)}', ${eid}, ${eurl}, ${ttl}, '${escapeSql(status)}', ${err}, ${pub})
    ON CONFLICT ("articleId", platform) DO UPDATE SET
      "externalId" = EXCLUDED."externalId",
      "externalUrl" = EXCLUDED."externalUrl",
      title = EXCLUDED.title,
      status = EXCLUDED.status,
      error = EXCLUDED.error,
      "publishedAt" = EXCLUDED."publishedAt"
  `);
}
