import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatPriceRange,
  midpoint,
  PRICE_DISCLAIMER,
  PRICE_SNAPSHOT_INTERVAL_DAYS,
  priceTimelineWithStages,
  quarterHint,
  withCommas,
  type PriceSnapshotRow,
} from "./price-snapshot.ts";

// ─── 价格展示 ───────────────────────────────────────────────────────────

test("千分位：不依赖 toLocaleString（服务端与浏览器的 ICU 结果可能不同）", () => {
  assert.equal(withCommas(3800), "3,800");
  assert.equal(withCommas(1234567), "1,234,567");
  assert.equal(withCommas(0), "0");
  assert.equal(withCommas(-3800), "-3,800");
});

test("区间展示：上下限不同才显示两个数", () => {
  assert.equal(formatPriceRange(3800, 4500), "¥3,800 – ¥4,500");
  assert.equal(formatPriceRange(3800, 3800), "¥3,800");
  assert.equal(formatPriceRange(100, 200, "USD"), "$100 – $200");
});

test("中位价 = 区间中点（用来算涨跌）", () => {
  assert.equal(midpoint({ low: 3800, high: 4500 }), 4150);
});

// ─── 「按季度」的提醒 ────────────────────────────────────────────────────

test("季度提醒：距上次不到 90 天给个提示，但不拦", () => {
  const now = new Date("2026-10-25T00:00:00.000Z");
  const recent = quarterHint("2026-10-01", now);
  assert.equal(recent.daysSinceLast, 24);
  assert.equal(recent.tooSoon, true);
  assert.match(recent.text, /24 天/);

  const old = quarterHint("2026-01-01", now);
  assert.equal(old.tooSoon, false);
  assert.match(old.text, /距上次/);
});

test("季度提醒：从来没录过", () => {
  const h = quarterHint(null);
  assert.equal(h.daysSinceLast, null);
  assert.equal(h.tooSoon, false);
  assert.match(h.text, /还没有录过/);
});

test("季度间隔常量是 90 天", () => {
  assert.equal(PRICE_SNAPSHOT_INTERVAL_DAYS, 90);
});

// ─── 价格与站长线对照 ────────────────────────────────────────────────────

const snap = (
  id: string,
  snapshotDate: string,
  low: number,
  high: number,
): PriceSnapshotRow => ({
  id,
  teaId: "t1",
  snapshotDate,
  low,
  high,
  currency: "CNY",
  sourceLabel: "东和",
  note: null,
});

test("每条快照带上「当时站长线的阶段」", () => {
  const entries = priceTimelineWithStages(
    [snap("s1", "2025-01-01", 3800, 4500), snap("s2", "2025-07-01", 3000, 3600)],
    [
      { createdAt: "2024-06-01T00:00:00.000Z", stage: "peak" },
      { createdAt: "2025-03-01T00:00:00.000Z", stage: "drinking" },
      { createdAt: "2025-09-01T00:00:00.000Z", stage: "declining" },
    ],
  );

  assert.equal(entries.length, 2);
  // 2025-01-01 之前最近的一条是 2024-06-01 的 peak
  assert.equal(entries[0].stageAtThatTime, "peak");
  assert.equal(entries[0].stageLabel, "巅峰期");
  // 2025-07-01 之前最近的一条是 2025-03-01 的 drinking（不是 9 月那条）
  assert.equal(entries[1].stageAtThatTime, "drinking");
  assert.equal(entries[1].stageLabel, "适饮期");
});

test("快照按日期排序，涨跌与上一条比", () => {
  const entries = priceTimelineWithStages(
    [snap("s2", "2025-07-01", 3000, 3600), snap("s1", "2025-01-01", 3800, 4500)],
    [],
  );
  assert.equal(entries[0].snapshot.id, "s1", "按日期升序");
  assert.equal(entries[0].changePct, null, "第一条没有上一条可比");
  // 中位价 4150 → 3300，跌了 20.5%
  assert.equal(entries[1].changePct, -20.5);
});

test("没有站长线记录时，阶段就是空（不编）", () => {
  const entries = priceTimelineWithStages([snap("s1", "2025-01-01", 3800, 4500)], []);
  assert.equal(entries[0].stageAtThatTime, null);
  assert.equal(entries[0].stageLabel, null);
});

test("免责声明是一句固定的话", () => {
  assert.match(PRICE_DISCLAIMER, /不构成投资建议/);
});
