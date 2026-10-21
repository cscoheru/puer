#!/usr/bin/env node

/**
 * reader-baseline.mjs — 真实读者基线报表（PRD v0.3 §12「真实读者基线报表：
 * 用 article_views 去重并剔除爬虫，输出匿名真实读者数与来源渠道，并核对
 * viewCount 双轨」）。
 *
 * ## 为什么有两个数据源
 *
 *  `Article.viewCount`（轨 1）：SSR 页面每渲染一次 +1。含爬虫、含刷新、
 *  含站长自己看自己的帖。它衡量的是「热度」，用来做相对排序。
 *
 *  `article_views`（轨 2）：客户端 beacon 触发，只在浏览器执行 JS 时才有，
 *  按 (文章, 访客, 天) 去重，剔除爬虫 UA、剔除管理员与作者本人。它衡量
 *  的是「有多少真人读过」。
 *
 *  2026-10-22 之前轨 2 **从未工作过**：/api/views 往一张从未创建的表写，
 *  异常被吞掉且仍返回 200。所以「今天之前的历史基线」只能从 nginx 访问
 *  日志回溯 —— 日志里有 IP、UA、Referer，够算出同一口径的数。
 *
 * ## 口径
 *
 *  爬虫判定：UA 命中爬虫特征词（与 /api/views 的 BOT_RE 同一套词表）。
 *  真人判定：非爬虫 UA，且请求的是**页面**（不是 /api/、不是静态资源、
 *  不是 socket.io 长轮询），且状态码是 2xx/3xx。
 *  匿名真人：按 IP+UA 指纹去重（不存原始 IP，只用指纹计数）。
 *  来源渠道：Referer 的 host；无 Referer = 直接访问/书签。
 *
 * Run:
 *   node --import tsx scripts/reader-baseline.mjs            # 读日志 + DB
 *   node --import tsx scripts/reader-baseline.mjs --log-only  # 只读日志
 *   node --import tsx scripts/reader-baseline.mjs --days 7   # 近 7 天日志
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client.js";

const LOG_ONLY = process.argv.includes("--log-only");
const DAYS = (() => {
  const i = process.argv.indexOf("--days");
  const n = i >= 0 ? parseInt(process.argv[i + 1], 10) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
})();

// 与 src/app/api/views/route.ts 的 BOT_RE 保持同一套爬虫特征词。
// 注意：刻意不匹配 MicroMessenger（微信内置浏览器是真人）。
const BOT_RE =
  /bot|spider|crawl|archiver|googlebot|baidu|bingbot|slurp|duckduckbot|yandexbot|semrush|ahrefsbot|facebookexternalhit|twitterbot|linkedinbot|python-requests|curl|wget|headless|lighthouse|siteaudit|dataforseo/i;

const LOG_PATH = process.env.READER_BASELINE_LOG || "/var/log/nginx/access.log";

function log(msg) {
  console.log(msg);
}

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * 解析 nginx 的时间戳 `21/Oct/2026:23:35:47 +0000`。
 *
 * 不能用 Date.parse —— 这个格式不是 ISO 也不是 RFC 2822，Date.parse 直接
 * 返回 NaN。NaN 会让「时间早于窗口」的判断把所有行都过滤掉，报表看起来
 * 就是「零访问」。曾经在这上面栽过一次。
 */
function parseNginxTime(raw) {
  const m = /(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2})(\d{2})/.exec(raw);
  if (!m) return NaN;
  const mo = MONTHS[m[2]];
  if (mo === undefined) return NaN;
  const offsetMin = (m[7] === "-" ? -1 : 1) * (parseInt(m[8], 10) * 60 + parseInt(m[9], 10));
  return (
    Date.UTC(
      parseInt(m[3], 10),
      mo,
      parseInt(m[1], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      parseInt(m[6], 10),
    ) - offsetMin * 60000
  );
}

/** nginx combined 格式：IP - - [时间] "请求" 状态 字节 "Referer" "UA" */
function parseLogLine(line) {
  const m = line.match(
    /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) (\S+)" (\d{3}) (\S+) "([^"]*)" "([^"]*)"/,
  );
  if (!m) return null;
  return {
    ip: m[1],
    time: m[2],
    method: m[3],
    path: m[4],
    status: Number(m[6]),
    bytes: m[7],
    referer: m[8],
    ua: m[9],
  };
}

/** 是不是「人读的页面」——排除接口、静态资源、长轮询。 */
function isPageRequest(pathname) {
  const p = pathname.split("?")[0];
  if (!p.startsWith("/")) return false;
  if (p.startsWith("/api/")) return false;
  if (p.startsWith("/_next/")) return false;
  if (p.startsWith("/uploads/")) return false;
  if (p.startsWith("/socket.io/")) return false;
  if (/\.(js|css|map|png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|txt|xml|json|pdf|mp4|webm|mov)$/i.test(p)) {
    return false;
  }
  return true;
}

/** Referer 的 host（规范化）。空串 = 直接访问。 */
function refererHost(ref) {
  if (!ref || ref === "-") return "";
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 把来源渠道归到大类，便于读数。 */
function channelOf(host) {
  if (!host) return "直接访问";
  if (/google|bing|baidu|duckduckgo|yandex|sogou|so\.com|naver/.test(host)) return "搜索引擎";
  if (/weixin|wechat|qq\.com/.test(host)) return "微信/QQ";
  if (/weibo|douban|xiaohongshu|zhihu|tieba|instagram|twitter|x\.com|facebook|reddit|telegram|youtube|bilibili/.test(host))
    return "社交/论坛";
  if (host === "puer.im" || host.endsWith(".puer.im")) return "站内";
  return "外部站点";
}

// ── 1. 日志口径 ────────────────────────────────────────────────────────
function reportFromLog() {
  if (!existsSync(LOG_PATH)) {
    log(`  日志不存在：${LOG_PATH}（跳过日志口径）`);
    return null;
  }
  const mtime = statSync(LOG_PATH).mtime;
  const raw = readFileSync(LOG_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  const cutoff = Date.now() - DAYS * 86400_000;
  let total = 0;
  let bots = 0;
  let nonPage = 0;
  let notOk = 0;
  const humanFingerprints = new Set(); // 匿名真人：IP+UA 指纹
  const channelCounts = new Map();
  const topPaths = new Map();
  let earliest = null;
  let latest = null;

  for (const line of lines) {
    const r = parseLogLine(line);
    if (!r) continue;
    const ts = parseNginxTime(r.time);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    total++;
    if (earliest === null || ts < earliest) earliest = ts;
    if (latest === null || ts > latest) latest = ts;

    if (BOT_RE.test(r.ua)) {
      bots++;
      continue;
    }
    if (!isPageRequest(r.path)) {
      nonPage++;
      continue;
    }
    if (r.status < 200 || r.status >= 400) {
      notOk++;
      continue;
    }
    // 匿名真人指纹：IP + UA。不存原始 IP，只用来数「有多少个不同的人」。
    humanFingerprints.add(`${r.ip}|${r.ua}`);
    const ch = channelOf(refererHost(r.referer));
    channelCounts.set(ch, (channelCounts.get(ch) || 0) + 1);
    const p = r.path.split("?")[0];
    topPaths.set(p, (topPaths.get(p) || 0) + 1);
  }

  return {
    total,
    bots,
    nonPage,
    notOk,
    uniqueHumans: humanFingerprints.size,
    channels: channelCounts,
    topPaths,
    from: earliest,
    to: latest,
  };
}

// ── 2. DB 口径 ─────────────────────────────────────────────────────────
async function reportFromDb(prisma) {
  const since = new Date(Date.now() - DAYS * 86400_000);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.articleView.findMany({
    where: { day: { gte: since } },
    select: {
      visitorKey: true,
      refererHost: true,
      landingPath: true,
      isLoggedIn: true,
      day: true,
    },
  });

  const anon = new Set();
  const logged = new Set();
  const channels = new Map();
  const landings = new Map();
  const byDay = new Map();

  for (const r of rows) {
    if (r.isLoggedIn) logged.add(r.visitorKey);
    else anon.add(r.visitorKey);
    const ch = channelOf(r.refererHost || "");
    channels.set(ch, (channels.get(ch) || 0) + 1);
    if (r.landingPath) landings.set(r.landingPath, (landings.get(r.landingPath) || 0) + 1);
    const d = r.day.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }

  return {
    rows: rows.length,
    uniqueAnon: anon.size,
    uniqueLogged: logged.size,
    channels,
    landings,
    byDay,
  };
}

function topOf(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  log("═".repeat(68));
  log(" 真实读者基线报表（PRD v0.3 §12）");
  log(` 口径窗口：近 ${DAYS} 天`);
  log("═".repeat(68));

  // ── 日志口径 ──
  const lg = reportFromLog();
  log("");
  log("【一】nginx 访问日志口径（回溯历史，article_views 修好前的唯一来源）");
  if (lg) {
    if (lg.from && lg.to) {
      log(
        `  日志范围：${new Date(lg.from).toISOString().slice(0, 16)} ~ ${new Date(lg.to).toISOString().slice(0, 16)} UTC`,
      );
    }
    log(`  请求总数        ${lg.total}`);
    log(`  ├ 爬虫 UA      ${lg.bots}`);
    log(`  ├ 非页面请求    ${lg.nonPage}`);
    log(`  └ 非 2xx/3xx   ${lg.notOk}`);
    log(`  匿名真实读者（IP+UA 去重）  ${lg.uniqueHumans}`);
    log("");
    log("  来源渠道：");
    for (const [ch, n] of topOf(lg.channels)) {
      log(`    ${ch.padEnd(10, " ")} ${String(n).padStart(6)} 次`);
    }
    log("");
    log("  热门页面：");
    for (const [p, n] of topOf(lg.topPaths, 6)) {
      log(`    ${String(n).padStart(5)}  ${p}`);
    }
  }

  // ── DB 口径 ──
  let db = null;
  if (!LOG_ONLY) {
    if (!process.env.DATABASE_URL) {
      log("");
      log("【二】article_views 口径：跳过（缺 DATABASE_URL）");
    } else {
      const prisma = new PrismaClient();
      try {
        db = await reportFromDb(prisma);
        log("");
        log("【二】article_views 口径（修复后持续积累，去重 + 剔除爬虫）");
        log(`  视图记录总数    ${db.rows}`);
        log(`  匿名真实读者    ${db.uniqueAnon}`);
        log(`  登录读者        ${db.uniqueLogged}`);
        if (db.rows > 0) {
          log("");
          log("  来源渠道：");
          for (const [ch, n] of topOf(db.channels)) {
            log(`    ${ch.padEnd(10, " ")} ${String(n).padStart(6)} 次`);
          }
        } else {
          log("  （暂无数据 —— 该表 2026-10-22 才建好并开始积累）");
        }
      } catch (e) {
        log("");
        log(`【二】article_views 口径：查询失败 ${e?.message || e}`);
      } finally {
        await prisma.$disconnect();
      }
    }
  }

  // ── 双轨核对 ──
  if (!LOG_ONLY && process.env.DATABASE_URL) {
    const prisma = new PrismaClient();
    try {
      const agg = await prisma.article.aggregate({
        _sum: { viewCount: true },
        _count: { _all: true },
      });
      const withViews = await prisma.article.count({ where: { viewCount: { gt: 0 } } });
      const totalViews = agg._sum.viewCount || 0;
      log("");
      log("【三】viewCount 双轨核对");
      log(`  轨 1  Article.viewCount 合计   ${totalViews}  （SSR 每渲染 +1，含爬虫与刷新）`);
      if (db) {
        const ratio = db.uniqueAnon > 0 ? (totalViews / db.uniqueAnon).toFixed(1) : "—";
        log(`  轨 2  article_views 去重真人   ${db.uniqueAnon}  （含爬虫的视图记录会被剔除）`);
        log(`  倍数：轨 1 是轨 2 的 ${ratio} 倍`);
      }
      log(`  有 viewCount 的文章 ${withViews} / ${agg._count._all}`);
      log("  结论：viewCount 只能当热度指标（相对排序），不能当「有多少人读过」；");
      log("        后者必须看 article_views。");
    } catch (e) {
      log("");
      log(`【三】双轨核对失败：${e?.message || e}`);
    } finally {
      await prisma.$disconnect();
    }
  }

  log("");
  log("═".repeat(68));
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
