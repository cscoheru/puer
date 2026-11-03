/**
 * AI 回复的「来源标注」链路（2026-11-03）。
 *
 * 恢复自动回复的前提是**读者能分清哪些评论是 AI 写的**：
 *
 *   脚本写 comments.origin='ai_autonomous'
 *     → 评论列表放行带标注的评论（合成账号写的未标注评论仍然隐藏）
 *     → 前台打「AI 回复」徽章
 *     → 指标仍然只算真人（真实计数按 REAL_AUTHOR 过滤）
 *
 * 任何一环断了，自动回复就变成「白烧模型配额、读者什么也看不见」——
 * 而且不会报错（合成账号的评论被过滤掉是**静默**的）。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("auto-reply 插入的评论带 origin='ai_autonomous' 标注", () => {
  const src = read("scripts/auto-reply.mjs");
  assert.match(src, /ai_autonomous/, "脚本必须写明 AI 标注值");
  // INSERT 语句本身要带上 origin 列（只在别处出现 ai_autonomous 不够）
  assert.match(
    src,
    /INSERT INTO comments[\s\S]{0,400}?origin\)/,
    "INSERT 语句必须把 origin 列写进去",
  );
  assert.match(
    src,
    /INSERT INTO comments[\s\S]{0,600}?'ai_autonomous'/,
    "INSERT 的 VALUES 必须带上 ai_autonomous",
  );
});

test("cron 包装层必须 export AUTO_REPLY_ENABLED（漏了开关就是死的且不报错）", () => {
  const src = read("scripts/cron-task.sh");
  assert.match(
    src,
    /AUTO_REPLY_ENABLED=\$\(grep/,
    "必须从 .env 里读出 AUTO_REPLY_ENABLED",
  );
  assert.match(
    src,
    /export AUTO_REPLY_ENABLED=/,
    "必须 export 下去 —— 脚本读的是 === '1'，不 export 就等于开关是死的",
  );
});

test("评论列表放行带 AI 标注的评论（但未标注的机器人评论仍隐藏）", () => {
  const src = read("src/app/api/comments/route.ts");
  assert.match(src, /AI_COMMENT_ORIGINS/, "必须用共享的标注词汇");
  assert.match(src, /origin: \{ in:/, "必须按 origin 放行 AI 标注的评论");
  assert.match(src, /REAL_AUTHOR/, "真人作者过滤必须保留");
});

test("crontab 正本：自动回复有一行，auto-vote 仍标注为停用", () => {
  const src = read("scripts/crontab.txt");
  assert.match(src, /cron-task\.sh auto-reply/, "正本里必须有自动回复这一行");
  assert.match(
    src,
    /auto-vote —— R28-removed/,
    "auto-vote 仍是停用状态（PRD §12：自动投票一律停止）",
  );
});

test("KILL_SWITCHES.md 记录了 auto-reply 的新状态", () => {
  const doc = read("scripts/KILL_SWITCHES.md");
  assert.match(doc, /AUTO_REPLY_ENABLED=1/);
  assert.match(doc, /ai_autonomous/, "要写清标注方式，否则没人知道读者怎么分辨");
});
