/**
 * F4 复饮提醒跑批的**结构性**断言。
 *
 * 这个脚本最要命的不是逻辑，是**幂等**：认领、推进、插通知三步一旦有一步
 * 写错，表现是「天天重复提醒」或「提醒一次就永远沉默」或「提醒被吞掉」，
 * 而且**都不会报错** —— 单测全绿，用户被骚扰一个月才发现。
 *
 * 这些断言直接读源码，把「必须带双守卫」「必须在一个事务里」钉死。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("./cellar-reminders.mjs", import.meta.url),
  "utf8",
);

/** 去掉注释 —— 断言要看的是代码，不是解释这件事的注释。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const CODE = stripComments(SRC);

test("推进 nextRemindAt 的 UPDATE 必须带**双守卫**", () => {
  // 少了「nextRemindAt <= now」：已经推后的条目会被反复推、反复提醒；
  // 少了「lastRemindedAt」那一段：并发跑批会各插一条通知。
  const advance = CODE.match(/const ADVANCE_SQL = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.ok(advance, "找不到 ADVANCE_SQL");
  assert.match(
    advance,
    /"nextRemindAt"\s*<=\s*\$1/,
    "推进时必须还满足「仍然到期」",
  );
  assert.match(
    advance,
    /"lastRemindedAt" IS NULL OR "lastRemindedAt" < "nextRemindAt"/,
    "推进时必须还满足「这一轮还没提醒过」—— 少了它就会天天重复提醒",
  );
  assert.match(advance, /RETURNING id/);
});

test("认领用 FOR UPDATE OF ... SKIP LOCKED（并发跑批各拿各的）", () => {
  const claim = CODE.match(/const CLAIM_SQL = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.match(claim, /FOR UPDATE OF ci SKIP LOCKED/);
  assert.match(
    claim,
    /"remindEveryMonths" > 0/,
    "关了提醒（0）的条目不该被挑中",
  );
  assert.match(claim, /"banStatus" = 'active'/);
  assert.match(claim, /"isSynthetic" = false/);
});

test("认领、推进、插通知必须在**同一个事务**里", () => {
  // 分开做的话，UPDATE 成功而 INSERT 失败 → 提醒被永久吞掉。
  assert.match(CODE, /client\.query\("BEGIN"\)/);
  assert.match(CODE, /client\.query\("COMMIT"\)/);
  assert.match(CODE, /client\.query\("ROLLBACK"\)/);
  const begin = CODE.indexOf('client.query("BEGIN")');
  const insert = CODE.indexOf("INSERT_NOTIFICATION_SQL,");
  // 空批次那支也有一次 COMMIT，所以取**最后一次**。
  const commit = CODE.lastIndexOf('client.query("COMMIT")');
  assert.ok(begin !== -1 && insert !== -1 && commit !== -1);
  assert.ok(begin < insert, "插通知必须在 BEGIN 之后");
  assert.ok(insert < commit, "插通知必须在 COMMIT 之前");
});

test("插通知必须显式给全 id / read / createdAt", () => {
  // notifications.id 是 text NOT NULL 且**数据库层没有默认值**
  // （默认值在 Prisma 客户端侧）—— 裸 INSERT 漏了 id 直接报错。
  const insert = CODE.match(/const INSERT_NOTIFICATION_SQL = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.ok(insert, "找不到 INSERT_NOTIFICATION_SQL");
  assert.match(
    insert,
    /INSERT INTO notifications \(id, "userId", type, content, link, read, "createdAt"\)/,
  );
  assert.match(insert, /'reminder'/);
});

test("dry-run 一个字都不写（连 nextRemindAt 都不能推进）", () => {
  const dryIdx = CODE.indexOf("if (DRY_RUN) {");
  const advanceIdx = CODE.indexOf("ADVANCE_SQL,");
  assert.ok(dryIdx !== -1, "应该有 dry-run 分支");
  assert.ok(advanceIdx !== -1);
  assert.ok(
    dryIdx < advanceIdx,
    "dry-run 的判断必须在推进 nextRemindAt 之前 —— 否则 dry-run 会改库",
  );
  const dryBlock = CODE.slice(dryIdx, advanceIdx);
  assert.match(dryBlock, /continue;/, "dry-run 分支必须跳过写库");
});

test("默认 dry-run，要写库必须显式 --apply", () => {
  assert.match(CODE, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(CODE, /const DRY_RUN = !APPLY;/);
});

test("暂停开关在最前面：主动停用退 0，不该触发 cron 告警", () => {
  const pauseIdx = CODE.indexOf("CELLAR_REMINDERS_PAUSED");
  assert.ok(pauseIdx !== -1, "应该有暂停开关");
  const connectIdx = CODE.indexOf("client.connect()");
  assert.ok(pauseIdx < connectIdx, "暂停判断必须在连库之前");
  const importIdx = CODE.indexOf("await import(\"../src/lib/cellar-reminder.ts\")");
  assert.ok(pauseIdx < importIdx, "暂停判断必须在 import 之前");
  assert.match(CODE, /已暂停/);
  assert.match(CODE, /process\.exit\(0\)/);
});

test("可见性用现成的纯函数，不自己重写白名单", () => {
  assert.match(CODE, /cellarVisibleTo/);
  assert.ok(
    !/CELLAR_UIDS\.split|EDITOR_AUTHOR_UIDS\.split/.test(CODE),
    "白名单解析只能用 cellarVisibleTo —— 两份口径必然漂",
  );
});

test("报告里要有计数（跳过与失败必须落到日志）", () => {
  assert.match(CODE, /status=ok/);
  assert.match(CODE, /sent=/);
  assert.match(CODE, /skipped\(invisible\)/);
  assert.match(CODE, /skipped\(user-cap\)/);
  assert.match(CODE, /errors=/);
});
