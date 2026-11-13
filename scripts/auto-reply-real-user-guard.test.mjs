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
import vm from "node:vm";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const src = read("scripts/auto-reply.mjs");

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
  const doc = read("scripts/KILL_SWITCHES.md");
  assert.ok(doc.includes("排除真实用户") || doc.includes("真实用户保护"),
    "开关文档要写清「回复只落在自动化内容」这条口径，否则下次没人知道有这道闸");
});

// ── 2026-11-13 追加：新帖优先 + 加量（站长反馈「新帖没回复、量太少」）──────

test("新帖优先：三个分支都带 recency 插值，且近窗选不到会放宽到全库", () => {
  assert.ok(src.includes("INTERVAL '7 days'"), "近窗是 7 天");
  const uses = src.match(/\$\{recency\} \$\{exclusion\}/g) ?? [];
  assert.equal(uses.length, 3, "三个选帖分支都要带 recency/exclusion 插值");
  assert.match(src, /buildPickQuery\(rand, true, excludeIds\)/, "先查近 7 天");
  assert.match(src, /buildPickQuery\(rand, false, excludeIds\)/,
    "近窗为空时放宽全库 —— 注意自动化门在 buildPickQuery 内部，两次都带");
});

test("选中分支耗尽：继续查通用自动化帖，不提前结束整次运行", async () => {
  const fn = src.match(/async function pickPost\(excludeIds = new Set\(\)\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "pickPost 保持可用 vm 单独加载的纯查询选择边界");
  const calls = [];
  const pickPost = vm.runInNewContext(`(${fn[0]})`, {
    Math: { random: () => 0.5 }, // 固定落在低回复分支
    buildPickQuery: (rand, recent, excludeIds) => ({ rand, recent, excludeIds }),
    sqlRows: async (query) => {
      calls.push(query);
      // 原分支近窗/全库都空，通用分支近窗也空，只有通用全库还有帖子。
      return query.rand === 1 && !query.recent ? [{ id: "fallback-post" }] : [];
    },
  });
  const picked = new Set(["already-picked"]);
  const post = await pickPost(picked);
  assert.equal(post?.id, "fallback-post", "原分支为空不等于全库没有合规帖子");
  assert.deepEqual(calls.map((q) => [q.rand, q.recent]), [
    [0.5, true],
    [0.5, false],
    [1, true],
    [1, false],
  ]);
  assert.ok(calls.every((q) => q.excludeIds === picked), "每次回退都保留同跑去重集合");
});

test("同一次运行内不重复回复同一帖", () => {
  assert.match(src, /pickPost\(pickedIds\)/, "选帖要带上本次已选集合");
  assert.match(src, /pickedIds\.add\(post\.id\)/, "选中的帖子要登记");
  assert.ok(src.includes('a.id NOT IN'), "SQL 层排除已选帖子");
});

test("回复量：默认 12，AUTO_REPLY_PER_RUN 可覆盖且由 cron 包装层 export", () => {
  assert.match(src, /parseReplyCount\(process\.env\.AUTO_REPLY_PER_RUN, log\)/,
    "主循环使用有边界测试的统一解析函数");
  const wrapper = read("scripts/cron-task.sh");
  assert.match(wrapper, /AUTO_REPLY_PER_RUN=\$\(grep/, "从 .env 读覆盖值");
  assert.match(wrapper, /export AUTO_REPLY_PER_RUN=/,
    "必须 export —— 漏了 .env 覆盖就是死的且不报错");
});

test("回复量解析：空值默认 12，显式输入取整并夹到 1-50，非法值告警", () => {
  const fn = src.match(/function parseReplyCount\(raw, warn[\s\S]*?\n\}/);
  assert.ok(fn, "回复量解析要有可执行测试，而不只检查源码里有没有 || 12");
  const parseReplyCount = vm.runInNewContext(`(${fn[0]})`);
  const cases = [
    [undefined, 12], ["", 12], ["   ", 12], ["bad", 12],
    ["0", 1], ["-2", 1], ["1", 1], ["1.5", 1],
    ["12", 12], ["50", 50], ["51", 50],
  ];
  for (const [raw, want] of cases) {
    assert.equal(parseReplyCount(raw), want, `AUTO_REPLY_PER_RUN=${String(raw)}`);
  }
  let warnings = 0;
  assert.equal(parseReplyCount("bad", () => { warnings++; }), 12);
  assert.equal(warnings, 1, "非法覆盖值必须留可见日志，不能静默加量");
});

test("crontab 正本：自动回复每天 3 跑（北京 09:37 / 13:37 / 20:37）", () => {
  const active = read("scripts/crontab.txt")
    .split("\n")
    .filter((l) => /^\d+ \d+ .*cron-task\.sh auto-reply/.test(l));
  assert.equal(active.length, 3, "生效的 auto-reply 行应为 3 条");
});
