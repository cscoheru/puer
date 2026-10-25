import { test } from "node:test";
import assert from "node:assert/strict";

import { createPriceSnapshotSchema } from "./price-snapshot-schemas.ts";

const base = {
  teaId: "t1",
  snapshotDate: "2026-10-25",
  low: 3800,
  high: 4500,
  sourceLabel: "东和",
};

test("正常的一条能过", () => {
  assert.equal(createPriceSnapshotSchema.safeParse(base).success, true);
});

test("来源必填（PRD F5：必须填来源与日期）", () => {
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, sourceLabel: "" }).success,
    false,
  );
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, sourceLabel: "   " }).success,
    true,
    "纯空格在 DB 的 CHECK 里才被挡（zod 这层放行）",
  );
});

test("日期必填且要 YYYY-MM-DD", () => {
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, snapshotDate: "" }).success,
    false,
  );
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, snapshotDate: "2026/10/25" })
      .success,
    false,
  );
});

test("上限不能低于下限", () => {
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, low: 4500, high: 3800 }).success,
    false,
  );
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, low: 3800, high: 3800 }).success,
    true,
    "上下限相同是合法的（就一个价）",
  );
});

test("价格不能是负数或小数", () => {
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, low: -1 }).success,
    false,
  );
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, high: 3800.5 }).success,
    false,
  );
});

test("不认识的字段直接拒（strictObject）", () => {
  assert.equal(
    createPriceSnapshotSchema.safeParse({ ...base, teaName: "偷渡字段" }).success,
    false,
  );
});
