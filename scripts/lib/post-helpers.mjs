/**
 * post-helpers.mjs — Shared pipeline for auto-post.mjs & auto-convert.mjs
 *
 * Exports the DeepSeek (content rewrite) + ffmpeg (slideshow video) + SQL
 * (article insert) pipeline so both daily-posting and note-conversion use one
 * implementation. Extracted from auto-post.mjs.
 *
 * generateVideo uses mkdtemp (per-call unique temp dir) so the two scripts can
 * run concurrently without clobbering each other's temp files.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DB_URL = process.env.DATABASE_URL;
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions";
export const VIDEO_DIR = "/app/public/uploads/videos";
export const EVERNOTE_DIR = "/app/public/uploads/evernote";

export const BOARDS = [
  { id: "169748e7-123e-40f5-b283-b016c83f9c32", slug: "puer", name: "普洱醇香" },
  { id: "c4effe75-3bf6-4bb7-b021-6d67b0d8b6f4", slug: "heicha", name: "黑茶雅韵" },
  { id: "7688ac15-8a4a-4f65-9f64-d50c15fbc8b8", slug: "knowledge", name: "习茶问道" },
  { id: "807a7beb-048a-460f-bdc0-14abbb5c6db3", slug: "water", name: "茶水人生" },
  { id: "1ede5a08-5715-46d8-8a24-657bc303e1ca", slug: "teacup", name: "茶器清心" },
  { id: "b78addc2-ad7c-4a1c-ae22-47ebfcd78ed5", slug: "trade", name: "茶市风云" },
];

// Content style templates for variety
export const STYLES = [
  "以资深茶友的第一人称视角，用轻松聊天的口吻写",
  "以茶艺师的专业视角，用优雅文艺的语言写",
  "以新手的发现视角，用惊喜好奇的口吻写",
  "以收藏家的视角，用沉稳内行的语气写",
  "以茶农/茶山来客的视角，用朴实真挚的口吻写",
  "以茶会分享的视角，用互动讨论的口吻写",
];

// ── Helpers ─────────────────────────────────────────────────────────

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function sql(query) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await client.query(query);
  } finally {
    await client.end();
  }
}

export async function sqlSingle(query) {
  return (await sql(query)).rows;
}

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ── Slideshow video (ffmpeg) ────────────────────────────────────────

export function generateVideo(images) {
  // Pick 5-8 images, keep only those that exist on disk
  const shuffled = shuffleArray(images);
  const available = [];
  for (const img of shuffled) {
    const imgPath = img.replace("/uploads/evernote/", `${EVERNOTE_DIR}/`);
    if (existsSync(imgPath)) available.push(img);
    if (available.length >= 8) break;
  }
  if (available.length < 4) {
    throw new Error(`Only ${available.length} images available on disk (need 4+)`);
  }

  // Per-call unique temp dir (mkdtemp) so concurrent runs don't collide
  const tmp = mkdtempSync(join(tmpdir(), "auto-post-"));

  for (let i = 0; i < available.length; i++) {
    const imgPath = available[i].replace("/uploads/evernote/", `${EVERNOTE_DIR}/`);
    const ext = imgPath.split(".").pop() || "jpg";
    execSync(`cp "${imgPath}" "${tmp}/img${String(i).padStart(3, "0")}.${ext}"`);
  }

  const videoId = randomUUID();
  const outputPath = `${VIDEO_DIR}/${videoId}.mp4`;
  const duration = available.length * 3; // 3s per image

  let concatContent = "";
  for (let i = 0; i < available.length; i++) {
    const ext = available[i].split(".").pop() || "jpg";
    concatContent += `file '${tmp}/img${String(i).padStart(3, "0")}.${ext}'\n`;
    concatContent += `duration 3\n`;
  }
  const lastExt = available[available.length - 1].split(".").pop() || "jpg";
  concatContent += `file '${tmp}/img${String(available.length - 1).padStart(3, "0")}.${lastExt}'\n`;
  writeFileSync(`${tmp}/concat.txt`, concatContent);

  const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i ${tmp}/concat.txt \
    -vf "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p" \
    -c:v libx264 -preset fast -crf 30 -r 20 \
    -t ${duration} \
    -movflags +faststart \
    ${outputPath} 2>/dev/null`;

  log(`Generating video: ${available.length} images, ${duration}s`);
  execSync(ffmpegCmd, { stdio: "pipe" });

  rmSync(tmp, { recursive: true });

  // First-frame thumbnail alongside the video
  const thumbPath = `${VIDEO_DIR}/${videoId}.jpg`;
  try {
    execSync(
      `ffmpeg -y -i "${outputPath}" -vframes 1 -q:v 2 -vf "scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black" "${thumbPath}" 2>/dev/null`,
      { timeout: 10000 }
    );
  } catch (e) {
    log(`Thumbnail extraction failed: ${e.message.split("\n")[0]}`);
  }

  const videoUrl = `/uploads/videos/${videoId}.mp4`;
  log(`Video created: ${videoUrl}`);
  return videoUrl;
}

// ── DeepSeek content rewrite ────────────────────────────────────────

export async function generateContent(note) {
  const scores = [];
  if (note.appearance) scores.push(`外形 ${note.appearance}/5`);
  if (note.color) scores.push(`汤色 ${note.color}/5`);
  if (note.aroma) scores.push(`香气 ${note.aroma}/5`);
  if (note.taste) scores.push(`滋味 ${note.taste}/5`);
  if (note.aftertaste) scores.push(`余韵 ${note.aftertaste}/5`);

  const style = pickRandom(STYLES);
  const plainContent = note.content ? note.content.replace(/<[^>]*>/g, "").slice(0, 800) : "";

  const prompt = `你是一个普洱茶社区的资深茶友。请根据以下品鉴笔记，${style}一篇论坛帖子。

茶品信息：${note.brand || ""} ${note.tea_name || ""} ${note.year || ""}年 ${note.tea_type === "raw" ? "生茶" : note.tea_type === "ripe" ? "熟茶" : ""}
评分：${scores.join("、") || "无"}
${note.brewMethod ? `冲泡方式：${note.brewMethod}` : ""}
${note.waterTemp ? `水温：${note.waterTemp}℃` : ""}
${note.teaWeight ? `投茶量：${note.teaWeight}` : ""}
${note.steepCount ? `耐泡度：${note.steepCount}泡` : ""}
原始品鉴记录（供参考，需改写）：
${plainContent}

要求：
1. 标题要吸引人但不夸张，15-30字
2. 正文200-500字，不要照抄原文，要有自己的风格和见解
3. 可以加入一些个人感受、冲泡体验、存茶建议等
4. 不要提这是自动生成的或改写的
5. 正文使用简单HTML格式（<b>加粗</b>、<i>斜体</i>等）

请严格按以下JSON格式返回（不要markdown代码块）：
{"title": "帖子标题", "content": "帖子正文HTML"}`;

  const response = await fetch(DEEPSEEK_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 1000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error ${response.status}: ${await response.text()}`);
  }

  const text = (await response.json()).choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(text);
    return { title: parsed.title, content: parsed.content };
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { title: parsed.title, content: parsed.content };
    }
    throw new Error("Failed to parse DeepSeek response as JSON");
  }
}

// ── Insert article ──────────────────────────────────────────────────

export async function insertPost({ title, content, videoUrl, boardId, userId, noteId }) {
  const id = randomUUID();
  const summary = content.replace(/<[^>]*>/g, "").slice(0, 200);
  // Marker carries the source noteId for dedup (<!--auto-post:{noteId}-->).
  // Old posts use bare <!--auto-post-->; LIKE '%auto-post%' matches both.
  const marker = noteId ? `<!--auto-post:${noteId}-->` : `<!--auto-post-->`;

  await sql(`
    INSERT INTO articles (
      id, type, title, content, summary,
      "boardId", "authorId", "videoUrl",
      "isPinned", "isEssence", "replyCount", "viewCount",
      "upvotes", "downvotes", status, flair,
      tags, images, "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'discussion', '${escapeSql(title)}', '${escapeSql(content)}${marker}', '${escapeSql(summary)}',
      '${boardId}', '${userId}', '${videoUrl}',
      false, false, 0, 0,
      0, 0, 'published', 'share',
      ARRAY['品鉴', '茶友分享']::varchar[], ARRAY[]::varchar[],
      NOW(), NOW()
    )
  `);

  await sql(`UPDATE users SET karma = karma + 2 WHERE id = '${userId}'`);
  log(`Post created: ${id} by user ${userId} in board ${boardId} (note ${noteId || "n/a"})`);
  return id;
}
