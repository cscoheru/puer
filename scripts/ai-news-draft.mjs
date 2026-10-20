#!/usr/bin/env node

/**
 * ai-news-draft.mjs — PentAGI 每周检索成果 → 论坛草稿（R29）。
 *
 * 流程：
 *   1. 从 pentagi-vps 拉取 `/opt/pentagi-artifacts/` 下的最新时间戳目录
 *      （B 拉 A，不是 A 推 B：天然幂等、A 无需知道本服务存在、失败只需重跑 B）；
 *   2. 解析成果包里的素材（`raw/02-search-results.md` 市场动态主源、
 *      `raw/03-tavily-answers.md` 品鉴/综述主源）；
 *   3. 质量闸过滤 + 版块路由（茶市风云 / 普洱醇香 / 习茶问道）；
 *   4. 逐条 AI 忠实改写（数字接地校验在改写层，不通过就丢弃该条）；
 *   5. 写库为 `status='draft'`，进 /admin/drafts 等人工审核。**绝不直接发布。**
 *
 * 幂等：主键 `news-draft_<hash(sourceKey)>` 固定，重复跑撞 PK（P2002）即跳过。
 * 所以「每周重跑」不会灌出重复帖，「上周失败这周重试」也不会产生两份。
 *
 * 失败与降级（每一条都记日志，禁止静默降级）：
 *   - 拉不到某个成果目录 → 跳过该目录，继续处理其余；
 *   - 素材不过质量闸 → 记拒绝原因分布，不生成空草稿；
 *   - AI 改写失败 → 跳过该条，不写半成品；
 *   - DB 不可用 / 缺 env → fail-fast，退出码非 0。
 *
 * Environment:
 *   DATABASE_URL                 — PostgreSQL 连接（cron-task.sh 提供）
 *   MINIMAX_API_KEY              — MiniMax key（cron-task.sh 提供）
 *   NEWS_AUTHOR_USERNAME         — 专用资讯账号 username（默认 puer-news）
 *   PENTAGI_ARTIFACT_HOST        — pentagi-vps SSH 目标（默认 pentagi-vps）
 *   PENTAGI_ARTIFACT_DIR         — 成果目录（默认 /opt/pentagi-artifacts）
 *   NEWS_ARTIFACT_LOCAL_DIR      — 本地落地目录（默认 /opt/puer-hub/rag-data/news-artifacts）
 *   NEWS_ARTIFACT_MAX_AGE_DAYS   — 只处理这个天数内的新成果（默认 21）
 *   NEWS_DRAFT_LIMIT             — 单次最多生成多少草稿（默认 0 = 不限）
 *
 * Run:
 *   node --import tsx scripts/ai-news-draft.mjs --dry-run   # 只统计不写库（默认）
 *   node --import tsx scripts/ai-news-draft.mjs --apply      # 写库
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  parseTavilyAnswers,
  parseSearchResults,
  routeBoard,
  isPublishable,
  draftId,
} from "../src/lib/news-draft/plan.ts";
import { rewriteNews } from "../src/lib/news-draft/rewrite.ts";

// ── argv / env ──────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const AUTHOR_USERNAME = process.env.NEWS_AUTHOR_USERNAME || "puer-news";
const ARTIFACT_HOST = process.env.PENTAGI_ARTIFACT_HOST || "pentagi-vps";
const ARTIFACT_DIR = process.env.PENTAGI_ARTIFACT_DIR || "/opt/pentagi-artifacts";
const LOCAL_DIR = process.env.NEWS_ARTIFACT_LOCAL_DIR || "/opt/puer-hub/rag-data/news-artifacts";
const MAX_AGE_DAYS = Number(process.env.NEWS_ARTIFACT_MAX_AGE_DAYS || 21);
const LIMIT = Number(process.env.NEWS_DRAFT_LIMIT || 0);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: missing required env ${name}. Set it before running.`);
    process.exit(1);
  }
  return v;
}

function makePrisma() {
  const url = required("DATABASE_URL");
  return new PrismaClient({ datasources: { db: { url } } });
}

// ── 成果包拉取 ──────────────────────────────────────────────────────

/**
 * 列出 pentagi-vps 上最新的成果目录名。
 *
 * 只认「符合时间戳目录名」的那些：`YYYY-MM-DDTHH-MM-SSZ__<flow>-<topic>`。
 * 目录名本身就是产出时间，比 mtime 可靠（rsync 保留 mtime，但人工改动会污染）。
 *
 * 拉取本身在 `pullArtifactDir`（rsync，退化到 scp）。
 */
function listRemoteArtifactDirs() {
  let listing;
  try {
    listing = execFileSync(
      "ssh",
      [ARTIFACT_HOST, `ls -1 ${ARTIFACT_DIR} 2>/dev/null || true`],
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch (e) {
    log(`ERROR: 无法列出 ${ARTIFACT_HOST}:${ARTIFACT_DIR} — ${e.message.split("\n")[0]}`);
    return [];
  }

  const dirs = listing
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__/.test(s));

  if (dirs.length === 0) {
    log(`WARN: ${ARTIFACT_HOST}:${ARTIFACT_DIR} 下没有符合命名的时间戳目录`);
    return [];
  }

  // 只取最近的若干个（按目录名里的时间戳倒序），避免一次拉几年的历史。
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
  const fresh = dirs
    .filter((d) => {
      // 目录名时间戳是 `YYYY-MM-DDTHH-MM-SSZ`（冒号在文件名里不安全，用了 -），
      // 转成可解析的 ISO 串 `YYYY-MM-DDTHH:MM:SSZ`。只替换时间部分的两个连字符，
      // 不能碰日期里的连字符。
      const ts = d.slice(0, 20).replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
      const t = Date.parse(ts);
      return Number.isFinite(t) ? t >= cutoff : false;
    })
    .sort()
    .reverse();

  log(`远端成果目录 ${dirs.length} 个，其中 ${fresh.length} 个在 ${MAX_AGE_DAYS} 天内`);
  return fresh;
}

/**
 * 用 rsync 拉取一个成果目录（比 tar-over-ssh 稳，且支持断点续传）。
 *
 * 服务器上没装 rsync 时退回 scp -r。单目录失败不阻塞其余——一个成果包坏了
 * 不该让整批停摆。
 */
function pullArtifactDir(dir) {
  const local = join(LOCAL_DIR, dir);
  try {
    execFileSync(
      "rsync",
      ["-az", "--timeout=120", `${ARTIFACT_HOST}:${ARTIFACT_DIR}/${dir}/`, `${local}/`],
      { encoding: "utf8", timeout: 300_000 },
    );
    return true;
  } catch {
    try {
      execFileSync(
        "scp",
        ["-r", `${ARTIFACT_HOST}:${ARTIFACT_DIR}/${dir}`, LOCAL_DIR],
        { encoding: "utf8", timeout: 300_000 },
      );
      return true;
    } catch (e) {
      log(`WARN: 拉取 ${dir} 失败: ${e.message.split("\n")[0]}`);
      return false;
    }
  }
}

// ── 素材抽取 ────────────────────────────────────────────────────────

/** 从一个成果目录里抽出全部素材。 */
function extractFromDir(dir) {
  const base = join(LOCAL_DIR, dir, "raw");
  const materials = [];
  const searchResults = join(base, "02-search-results.md");
  const tavilyAnswers = join(base, "03-tavily-answers.md");
  if (existsSync(searchResults)) {
    try {
      materials.push(...parseSearchResults(readFileSync(searchResults, "utf8")));
    } catch (e) {
      log(`WARN: 解析 ${dir}/raw/02-search-results.md 失败: ${e.message.split("\n")[0]}`);
    }
  }
  if (existsSync(tavilyAnswers)) {
    try {
      materials.push(...parseTavilyAnswers(readFileSync(tavilyAnswers, "utf8")));
    } catch (e) {
      log(`WARN: 解析 ${dir}/raw/03-tavily-answers.md 失败: ${e.message.split("\n")[0]}`);
    }
  }
  return materials;
}

/** 本地已有的成果目录（用于「上次的也再处理一次」的场景）。 */
function listLocalDirs() {
  if (!existsSync(LOCAL_DIR)) return [];
  return readdirSync(LOCAL_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  // Fail fast on missing env before touching the network or the DB.
  required("DATABASE_URL");
  required("MINIMAX_API_KEY");
  const prisma = makePrisma();

  try {
    // 1. 取成果目录：先拉新的，再把本地的也列上（拉取失败的目录若本地已有旧版
    //    也能继续处理，不让一次网络抖动毁掉整批）。
    mkdirSync(LOCAL_DIR, { recursive: true });
    for (const dir of listRemoteArtifactDirs()) {
      if (existsSync(join(LOCAL_DIR, dir, "raw"))) {
        log(`跳过已存在的成果目录 ${dir}`);
        continue;
      }
      pullArtifactDir(dir);
    }
    const dirs = listLocalDirs();
    if (dirs.length === 0) {
      log("WARN: 没有可用的成果目录，本轮不生成任何草稿");
      return;
    }
    log(`处理 ${dirs.length} 个成果目录: ${dirs.join(", ")}`);

    // 2. 抽素材 + 质量闸。
    const seenKeys = new Set();
    const rejected = {};
    const candidates = [];
    for (const dir of dirs) {
      for (const m of extractFromDir(dir)) {
        if (seenKeys.has(m.sourceKey)) continue;
        seenKeys.add(m.sourceKey);
        const verdict = isPublishable(m);
        if (!verdict.ok) {
          rejected[verdict.reason] = (rejected[verdict.reason] || 0) + 1;
          continue;
        }
        candidates.push(m);
      }
    }
    log(`抽取素材 ${seenKeys.size} 条，过闸 ${candidates.length} 条`);
    log(`拒绝原因分布: ${JSON.stringify(rejected)}`);

    // 3. 版块路由统计。
    const byRoute = { trade: 0, puer: 0, knowledge: 0 };
    for (const m of candidates) byRoute[routeBoard(m)]++;
    log(`版块分布: ${JSON.stringify(byRoute)}`);

    if (LIMIT > 0 && candidates.length > LIMIT) {
      log(`按 NEWS_DRAFT_LIMIT=${LIMIT} 截断`);
      candidates.length = LIMIT;
    }

    // 4. 查作者与版块（都按名字查，不硬编码 id——生产库有 7 个版块，
    //    `scripts/lib/post-helpers.mjs` 里那张硬编码表只有 6 个且已过时）。
    const author = await prisma.user.findUnique({
      where: { username: AUTHOR_USERNAME },
      select: { id: true, username: true, nickname: true, role: true, level: true },
    });
    if (!author) {
      log(`ERROR: 资讯账号 ${AUTHOR_USERNAME} 不存在，无法署名。先建号再跑本脚本。`);
      process.exitCode = 1;
      return;
    }
    log(`署名账号: ${author.username} (${author.nickname || "无昵称"}) role=${author.role}`);

    const boards = await prisma.board.findMany({
      select: { id: true, slug: true, name: true },
    });
    const boardBySlug = new Map(boards.map((b) => [b.slug, b]));
    for (const slug of ["trade", "puer", "knowledge"]) {
      if (!boardBySlug.has(slug)) {
        log(`ERROR: 版块 ${slug} 不存在，无法路由。`);
        process.exitCode = 1;
        return;
      }
    }

    // 5. 逐条改写 → 写库。
    let created = 0;
    let skippedExisting = 0;
    let rewriteFailed = 0;
    const failures = [];
    // 429 配额熔断：账户额度耗尽时对每条素材再打 2 发必败请求纯属浪费，
    // 且会拖长整批运行时间。命中一次 429 就停掉后面的模型调用（已抽取/已
    // 过闸的统计照常打印，方便恢复后只补改写）。
    let quotaExhausted = false;

    for (const m of candidates) {
      if (quotaExhausted) break;
      const slug = routeBoard(m);
      const board = boardBySlug.get(slug);
      const id = draftId(m.sourceKey);

      // 已存在就跳过（幂等）。这里查一次，避免白跑一次模型调用。
      const existing = await prisma.article.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (existing) {
        skippedExisting++;
        continue;
      }

      const rewritten = await rewriteNews({ material: m });
      if (!rewritten.ok) {
        rewriteFailed++;
        failures.push({ title: m.title.slice(0, 30), reason: rewritten.reason });
        log(`改写失败，跳过: ${m.title.slice(0, 30)} — ${rewritten.reason}`);
        if (/\b429\b|rate_limit|用量上限|额度|积分/.test(rewritten.reason)) {
          quotaExhausted = true;
          log("检测到配额/限流错误，熔断本轮后续模型调用（已抽取的素材保留，恢复后重跑即可）");
        }
        continue;
      }

      if (DRY_RUN) {
        log(`[dry-run] 将创建 ${id} → ${board.name} | ${rewritten.title}`);
        created++;
        continue;
      }

      try {
        await prisma.article.create({
          data: {
            id,
            type: "discussion",
            title: rewritten.title,
            content: rewritten.content,
            summary: rewritten.summary,
            boardId: board.id,
            authorId: author.id,
            // 资讯帖不关联茶品：关联了会在发布时镜像出一条品鉴笔记，
            // 而资讯稿没有对应的品鉴事实。
            teaId: null,
            tags: ["资讯", board.name],
            images: [],
            visibility: "public",
            status: "draft",
            // 不写 aiOriginal：资讯稿一次成型，没有「AI 原版 vs 人工改后」的
            // 双轨需求；写了反而会让后台的「⚠ 待重写」徽章逻辑误判。
          },
        });
        created++;
        log(`已创建草稿 ${id} → ${board.name} | ${rewritten.title}`);
      } catch (e) {
        // P2002 = 主键冲突 = 并发或上一轮已创建，按幂等跳过。
        if (e?.code === "P2002") {
          skippedExisting++;
          continue;
        }
        rewriteFailed++;
        failures.push({ title: m.title.slice(0, 30), reason: `db: ${e.message.split("\n")[0]}` });
        log(`写库失败，跳过: ${m.title.slice(0, 30)} — ${e.message.split("\n")[0]}`);
      }
    }

    log(
      `本批统计: 抽取 ${seenKeys.size} / 过闸 ${candidates.length} / ` +
        `新建 ${created} / 已存在跳过 ${skippedExisting} / 改写失败 ${rewriteFailed}`,
    );
    if (failures.length > 0) {
      log(`失败明细: ${JSON.stringify(failures.slice(0, 10))}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
