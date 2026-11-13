/**
 * auto-reply 的真实用户保护（2026-11-13 站长要求：打开自动回复，但排除真实用户）。
 *
 * 三层防线各自钉住：
 *   1. 回复**作者**只能是合成账号（pickUser 主查询与 fallback 都是
 *      isSynthetic=true —— 真人账号不会被冒用发言，F0 起就有，不许回退）。
 *   2. **选帖**只落在自动化内容上：三个分支（低回复 60% / 自动帖 30% /
 *      任意帖 10%）都必须带 AUTOMATED_POST_ONLY 片段。漏掉任何一个分支，
 *      真人帖子就有 10% 概率被 AI 回复，而且不会报错。
 *   3. **嵌套跟帖**的 parent 不能是真人的评论（自动化帖子下也有真人留言）。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const src = readFileSync(path.join(REPO_ROOT, "scripts/auto-reply.mjs"), "utf8");

test("选帖门：自动化判据 = 合成作者 OR AI origin OR auto-post 内联标记", () => {
  const frag = src.match(/const AUTOMATED_POST_ONLY = `([\s\S]*?)`;/);
  assert.ok(frag, "必须定义统一的 AUTOMATED_POST_ONLY 片段（一处实现，三处复用）");
  const body = frag[1];
  assert.ok(body.includes('u."isSynthetic" = true'), "要认合成账号作者");
  assert.ok(body.includes("ai_from_notes") && body.includes("ai_autonomous"),
    "origin 词汇要覆盖茶记（ai_from_notes）与全自动（ai_autonomous）");
  assert.ok(body.includes("<!--auto-post-->"), "origin 回填前的历史内联标记也要认");
  // 站长线账号是真人，它名下的自动茶记帖该被回复 → 三个判据必须是 OR。
  assert.ok(!/isSynthetic" = true\s+AND\s+a\.origin/.test(body),
    "判据之间必须是 OR，AND 会把站长线的自动帖全部排除");
});

test("选帖门：三个分支一个不漏地带上 AUTOMATED_POST_ONLY", () => {
  const branches = src.match(/WHERE a\.status = 'published'/g) ?? [];
  assert.equal(branches.length, 3, "pickPost 应恰好三个选帖分支（60/30/10）");
  const gated = src.match(
    /WHERE a\.status = 'published'[\s\S]{0,300}?\$\{AUTOMATED_POST_ONLY\}/g,
  ) ?? [];
  assert.equal(gated.length, 3,
    "每个分支都必须在 WHERE 里插上门片段 —— 漏一个，真人帖子就会被 AI 回复");
});

test("回复作者池：主查询与 fallback 都只取 isSynthetic=true", () => {
  const poolGuards = src.match(/WHERE "isSynthetic" = true/g) ?? [];
  assert.ok(poolGuards.length >= 2,
    "pickUser 的主查询和 fallback 都要钉住合成池，真人不被冒用");
});

test("嵌套跟帖：parent 评论排除真人作者", () => {
  const parent = src.match(/SELECT c\.id FROM comments c([\s\S]{0,500}?)ORDER BY RANDOM\(\)/);
  assert.ok(parent, "嵌套 parent 查询要保持可按作者过滤的形状");
  assert.ok(parent[1].includes('u."isSynthetic" = true'),
    "parent 必须是合成账号的评论");
  assert.ok(parent[1].includes("ai_autonomous"),
    "或带 AI 标注的评论（自动化帖子下的真人评论不能被 AI 跟帖）");
});

test("KILL_SWITCHES.md 记录真实用户排除口径", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "scripts/KILL_SWITCHES.md"), "utf8");
  assert.ok(doc.includes("排除真实用户") || doc.includes("真实用户保护"),
    "开关文档要写清「回复只落在自动化内容」这条口径，否则下次没人知道有这道闸");
});
