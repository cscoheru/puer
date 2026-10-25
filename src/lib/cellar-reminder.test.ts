import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addMonths,
  computeNextRemindAt,
  monthsSince,
  remindIntervalLabel,
  reminderAdvice,
  reminderNotificationText,
  REMINDER_TEXT_MAX,
} from "./cellar-reminder.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ─── addMonths：月末夹取 + 全程 UTC ──────────────────────────────────────

test("加月：普通情况", () => {
  assert.equal(
    iso(addMonths(new Date("2026-01-15T00:00:00.000Z"), 6)!),
    "2026-07-15",
  );
});

test("加月：月末要夹到目标月最后一天（JS setMonth 会溢出成 3 月 3 日）", () => {
  assert.equal(
    iso(addMonths(new Date("2026-01-31T00:00:00.000Z"), 1)!),
    "2026-02-28",
    "1 月 31 日 + 1 个月 = 2 月 28 日，不是 3 月 3 日",
  );
  assert.equal(
    iso(addMonths(new Date("2026-03-31T00:00:00.000Z"), 1)!),
    "2026-04-30",
  );
});

test("加月：闰年", () => {
  assert.equal(
    iso(addMonths(new Date("2024-01-31T00:00:00.000Z"), 1)!),
    "2024-02-29",
  );
});

test("加月：跨年", () => {
  assert.equal(
    iso(addMonths(new Date("2026-12-31T00:00:00.000Z"), 1)!),
    "2027-01-31",
  );
  assert.equal(
    iso(addMonths(new Date("2026-12-15T00:00:00.000Z"), 2)!),
    "2027-02-15",
  );
});

test("加月：0 个月原样返回；非法月数返回 null", () => {
  const base = new Date("2026-05-20T08:30:00.000Z");
  assert.equal(addMonths(base, 0)!.toISOString(), base.toISOString());
  assert.equal(addMonths(base, -1), null);
  assert.equal(addMonths(base, 1.5), null);
  assert.equal(addMonths(base, 61), null);
  assert.equal(addMonths(base, 60)!.getUTCFullYear(), 2031);
});

test("加月：不受时区影响（输入带 +08:00，输出按 UTC 夹取）", () => {
  // 2026-01-31T08:00:00+08:00 = 2026-01-31T00:00:00Z
  const r = addMonths(new Date("2026-01-31T08:00:00+08:00"), 1)!;
  assert.equal(r.toISOString().slice(0, 10), "2026-02-28");
  assert.equal(r.getUTCHours(), 0, "时分秒按 UTC 原样保留");
});

// ─── computeNextRemindAt ────────────────────────────────────────────────

test("提醒时刻 = 锚点 + N 个月", () => {
  const r = computeNextRemindAt({
    remindEveryMonths: 6,
    anchor: new Date("2026-01-15T00:00:00.000Z"),
  })!;
  assert.equal(iso(r), "2026-07-15");
});

test("间隔为 0 → 不提醒（返回 null）", () => {
  assert.equal(
    computeNextRemindAt({
      remindEveryMonths: 0,
      anchor: new Date("2026-01-15T00:00:00.000Z"),
    }),
    null,
  );
});

test("非法间隔 → null（负数 / 非整数 / 超上限）", () => {
  const anchor = new Date("2026-01-15T00:00:00.000Z");
  assert.equal(computeNextRemindAt({ remindEveryMonths: -1, anchor }), null);
  assert.equal(computeNextRemindAt({ remindEveryMonths: 61, anchor }), null);
  assert.equal(computeNextRemindAt({ remindEveryMonths: 1.5, anchor }), null);
});

test("锚点在未来 → 夹到现在（不许把提醒排到未来以外）", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");
  const r = computeNextRemindAt({
    remindEveryMonths: 6,
    anchor: new Date("2027-01-01T00:00:00.000Z"),
    now,
  })!;
  assert.equal(iso(r), "2026-11-01");
});

test("取 max：上次提醒更晚就用上次提醒 + N", () => {
  const r = computeNextRemindAt({
    remindEveryMonths: 6,
    anchor: new Date("2026-01-01T00:00:00.000Z"),
    lastRemindedAt: new Date("2026-03-01T00:00:00.000Z"),
    now: new Date("2026-03-02T00:00:00.000Z"),
  })!;
  assert.equal(iso(r), "2026-09-01", "2026-03-01 + 6 比 2026-01-01 + 6 晚");
});

test("取 max：锚点更晚就用锚点 + N（记了品鉴就重排）", () => {
  const r = computeNextRemindAt({
    remindEveryMonths: 6,
    anchor: new Date("2026-05-01T00:00:00.000Z"),
    lastRemindedAt: new Date("2026-03-01T00:00:00.000Z"),
    now: new Date("2026-05-02T00:00:00.000Z"),
  })!;
  assert.equal(iso(r), "2026-11-01");
});

test("没有锚点 → null（不猜）", () => {
  assert.equal(
    computeNextRemindAt({ remindEveryMonths: 6, anchor: null }),
    null,
  );
});

// ─── reminderAdvice ─────────────────────────────────────────────────────

test("建议：delta=better → 折半", () => {
  const a = reminderAdvice({ deltaVsPrev: "better" }, 6);
  assert.equal(a.tone, "better");
  assert.equal(a.suggestedMonths, 3);
  assert.match(a.text, /更好/);
});

test("建议：delta=worse → 三分之一", () => {
  const a = reminderAdvice({ deltaVsPrev: "worse" }, 6);
  assert.equal(a.tone, "worse");
  assert.equal(a.suggestedMonths, 2);
  assert.match(a.text, /走下坡|尽快/);
});

test("建议：阶段 declining 优先于 delta（阶段是茶本身的状态）", () => {
  // 只有 stage，没有 delta
  const a = reminderAdvice({ stage: "declining" }, 6);
  assert.equal(a.tone, "worse");
  assert.equal(a.suggestedMonths, 2);

  // delta=better 但 stage=declining → 阶段优先
  const b = reminderAdvice({ deltaVsPrev: "better", stage: "declining" }, 6);
  assert.equal(b.tone, "worse", "stage=declining 优先于 delta=better");
  assert.equal(b.suggestedMonths, 2);
});

test("建议：delta=same → 不缩短", () => {
  const a = reminderAdvice({ deltaVsPrev: "same" }, 6);
  assert.equal(a.tone, "neutral");
  assert.equal(a.suggestedMonths, 6);
  assert.equal(a.text, "");
});

test("建议：没品鉴过 → 没有建议", () => {
  const a = reminderAdvice(null, 6);
  assert.equal(a.tone, "neutral");
  assert.equal(a.suggestedMonths, null);
  assert.match(a.text, /品鉴/);
});

test("建议：间隔为 0（关了提醒）→ 退回 6 个月是错的", () => {
  const a = reminderAdvice({ deltaVsPrev: "better" }, 0);
  assert.equal(a.suggestedMonths, null, "关了提醒就不该建议「每 6 个月」");
  assert.match(a.text, /关闭/);
});

test("建议：下限是 1 个月", () => {
  assert.equal(reminderAdvice({ deltaVsPrev: "better" }, 1).suggestedMonths, 1);
  assert.equal(reminderAdvice({ deltaVsPrev: "worse" }, 2).suggestedMonths, 1);
});

test("建议：间隔已经是最短时不谎称「要缩短」", () => {
  const a = reminderAdvice({ deltaVsPrev: "worse" }, 1);
  assert.equal(a.suggestedMonths, 1);
  assert.ok(!a.text.includes("每 1 个月"), "没变就不该提间隔");
  assert.match(a.text, /尽快/);
});

test("文案不能写成「系统判定」——delta 是用户自己填的", () => {
  for (const d of ["better", "worse", "same"]) {
    const a = reminderAdvice({ deltaVsPrev: d }, 6);
    assert.ok(!a.text.includes("判定"), "不能替用户下判断");
    assert.ok(!a.text.includes("系统认为"));
  }
});

test("「走下坡」是**阶段**的说法，不能用来描述用户选的「更差」", () => {
  // 用户只选了「比上次差」（stage=drinking）时说成「走下坡」= 替他改口。
  const fromDelta = reminderAdvice({ deltaVsPrev: "worse", stage: "drinking" }, 6);
  assert.equal(fromDelta.source, "delta");
  assert.ok(
    !fromDelta.text.includes("走下坡"),
    `自填的对照不该被说成阶段：${fromDelta.text}`,
  );
  assert.match(fromDelta.text, /比上次差/);

  // 阶段 declining → 才是「走下坡」
  const fromStage = reminderAdvice({ deltaVsPrev: "worse", stage: "declining" }, 6);
  assert.equal(fromStage.source, "stage");
  assert.match(fromStage.text, /走下坡/);
});

// ─── monthsSince：通知里的月数必须是**实际**经过的月数 ───────────────────

test("monthsSince：算的是实际经过的月数", () => {
  const now = new Date("2026-10-25T00:00:00.000Z");
  assert.equal(
    monthsSince(new Date("2026-08-25T00:00:00.000Z"), now),
    2,
    "两个月前",
  );
  assert.equal(monthsSince(new Date("2026-10-24T00:00:00.000Z"), now), 0);
  assert.equal(monthsSince(null, now), null, "没有锚点就不知道");
});

test("通知里的月数用实际经过的月数，不用提醒间隔", () => {
  // 提醒间隔是「设置值」，不是事实 —— 两年前入仓从没品鉴的条目，
  // 间隔是 6 个月，实际已经 24 个月没复饮了。
  const t = reminderNotificationText({
    teaName: "2004 年班章",
    monthsSinceLast: 24,
    months: 6,
  });
  assert.match(t, /24 个月没复饮/);
  assert.ok(!t.includes("6 个月"), "不能把提醒间隔当成事实");
});

// ─── 展示文案 ───────────────────────────────────────────────────────────

test("间隔文案", () => {
  assert.equal(remindIntervalLabel(6), "每 6 个月");
  assert.equal(remindIntervalLabel(1), "每 1 个月");
  assert.equal(remindIntervalLabel(0), "已关闭");
  assert.equal(remindIntervalLabel(-3), "已关闭");
});

test("通知文案：带茶名、不超长", () => {
  const t = reminderNotificationText({ teaName: "2004 年班章", months: 6 });
  assert.match(t, /2004 年班章/);
  assert.ok(t.length <= REMINDER_TEXT_MAX, `文案超长：${t.length}`);

  const worse = reminderNotificationText({
    teaName: "2004 年班章",
    months: 6,
    advice: reminderAdvice({ stage: "declining" }, 6),
  });
  assert.match(worse, /走下坡/);
  assert.ok(worse.length <= REMINDER_TEXT_MAX);
});

test("通知文案：茶名很长也要截短", () => {
  const t = reminderNotificationText({
    teaName: "二零零四年勐海班章生茶七子饼茶 ridiculously long name here",
    months: 6,
  });
  assert.ok(t.length <= REMINDER_TEXT_MAX, `文案超长：${t.length}`);
});
