import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addStorageEpochSchema,
  addTastingSchema,
  createCellarItemSchema,
  createTeaRequestSchema,
  dimsSchema,
  reviewTeaRequestSchema,
  storageSchema,
  updateCellarItemSchema,
  zodMessage,
} from "./cellar-schemas.ts";

// ─── 仓储评分 ─────────────────────────────────────────────────────────────

test("仓储评分接受 45–60 的整数，拒绝越界", () => {
  assert.equal(storageSchema.safeParse({ storageScore: 45 }).success, true);
  assert.equal(storageSchema.safeParse({ storageScore: 60 }).success, true);
  assert.equal(storageSchema.safeParse({ storageScore: 44 }).success, false);
  assert.equal(storageSchema.safeParse({ storageScore: 61 }).success, false);
  assert.equal(storageSchema.safeParse({ storageScore: 47.5 }).success, false);
});

test("仓储三项都可跳过", () => {
  assert.equal(storageSchema.safeParse({}).success, true);
});

// ─── 四维 ─────────────────────────────────────────────────────────────────

test("四维接受 1–10 的整数", () => {
  assert.equal(dimsSchema.safeParse({ aroma: 7, flavor: 8 }).success, true);
  assert.equal(dimsSchema.safeParse({ aroma: 0 }).success, false);
  assert.equal(dimsSchema.safeParse({ aroma: 11 }).success, false);
  assert.equal(dimsSchema.safeParse({ aroma: 7.5 }).success, false);
});

test("四维拒绝未知键（拼错不能静默吞掉）", () => {
  const r = dimsSchema.safeParse({ water_path: 6 });
  assert.equal(r.success, false);
});

test("四维不能是空对象", () => {
  assert.equal(dimsSchema.safeParse({}).success, false);
});

// ─── 新建条目 ─────────────────────────────────────────────────────────────

test("新建条目：teaId 与自建申请二选一", () => {
  assert.equal(createCellarItemSchema.safeParse({ teaId: "t1" }).success, true);
  assert.equal(
    createCellarItemSchema.safeParse({ teaRequest: { name: "自建茶" } }).success,
    true,
  );
  assert.equal(createCellarItemSchema.safeParse({}).success, false);
  assert.equal(createCellarItemSchema.safeParse({ name: "只有名字" }).success, false);
});

test("新建条目：代录的 targetUserId 只能由管理员传（权限在路由层判）", () => {
  const r = createCellarItemSchema.safeParse({ teaId: "t1", targetUserId: "u2" });
  assert.equal(r.success, true, "schema 不拦，路由层按权限拦");
});

test("新建条目：拒绝未知字段", () => {
  assert.equal(
    createCellarItemSchema.safeParse({ teaId: "t1", remiindEveryMonths: 6 }).success,
    false,
  );
});

test("新建条目：acquiredAt 必须是 ISO 时间", () => {
  assert.equal(
    createCellarItemSchema.safeParse({ teaId: "t1", acquiredAt: "2026-01-02" }).success,
    false,
  );
  assert.equal(
    createCellarItemSchema.safeParse({
      teaId: "t1",
      acquiredAt: "2026-01-02T00:00:00.000Z",
    }).success,
    true,
  );
});

// ─── 改条目 / 换仓 ────────────────────────────────────────────────────────

test("改条目：字段都可空（清空用 null）", () => {
  assert.equal(updateCellarItemSchema.safeParse({ name: null }).success, true);
  assert.equal(updateCellarItemSchema.safeParse({ qtyNote: "还剩半饼" }).success, true);
  assert.equal(updateCellarItemSchema.safeParse({ remindEveryMonths: 0 }).success, false);
  assert.equal(updateCellarItemSchema.safeParse({ remindEveryMonths: 61 }).success, false);
});

test("换仓：评分越界被拒", () => {
  assert.equal(addStorageEpochSchema.safeParse({ storageScore: 50 }).success, true);
  assert.equal(addStorageEpochSchema.safeParse({ storageScore: 44 }).success, false);
  assert.equal(addStorageEpochSchema.safeParse({ city: "昆明" }).success, true);
});

// ─── 品鉴 ─────────────────────────────────────────────────────────────────

test("品鉴：阶段与对照只接受词表里的值", () => {
  assert.equal(addTastingSchema.safeParse({ stage: "peak" }).success, true);
  assert.equal(addTastingSchema.safeParse({ stage: "young" }).success, false);
  assert.equal(addTastingSchema.safeParse({ deltaVsPrev: "better" }).success, true);
  assert.equal(addTastingSchema.safeParse({ deltaVsPrev: "same" }).success, true);
  assert.equal(addTastingSchema.safeParse({ deltaVsPrev: "worse" }).success, true);
  assert.equal(addTastingSchema.safeParse({ deltaVsPrev: "更好" }).success, false);
});

test("品鉴：描述词有数量与长度上限", () => {
  assert.equal(
    addTastingSchema.safeParse({ descriptors: ["蜜香", "水路细"] }).success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({ descriptors: Array(21).fill("蜜香") }).success,
    false,
  );
  assert.equal(
    addTastingSchema.safeParse({ descriptors: ["x".repeat(41)] }).success,
    false,
  );
});

test("品鉴：耗时秒数不能为负", () => {
  assert.equal(addTastingSchema.safeParse({ elapsedSeconds: 22 }).success, true);
  assert.equal(addTastingSchema.safeParse({ elapsedSeconds: -1 }).success, false);
});

test("品鉴：图片最多 9 张", () => {
  assert.equal(
    addTastingSchema.safeParse({ images: Array(9).fill("https://x.test/a.jpg") }).success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({ images: Array(10).fill("https://x.test/a.jpg") }).success,
    false,
  );
});

// ─── 申请与审核 ───────────────────────────────────────────────────────────

test("自建茶品申请：名称必填，生熟二选一", () => {
  assert.equal(createTeaRequestSchema.safeParse({ name: "某山头 2015" }).success, true);
  assert.equal(createTeaRequestSchema.safeParse({ name: "" }).success, false);
  assert.equal(createTeaRequestSchema.safeParse({ name: "x", type: "fermented" }).success, false);
  assert.equal(createTeaRequestSchema.safeParse({ name: "x", type: "ripe" }).success, true);
});

test("审核：通过必须指定并入的茶品，退回可以不填理由", () => {
  assert.equal(
    reviewTeaRequestSchema.safeParse({ action: "approve", mergedTeaId: "t1" }).success,
    true,
  );
  assert.equal(reviewTeaRequestSchema.safeParse({ action: "approve" }).success, false);
  assert.equal(reviewTeaRequestSchema.safeParse({ action: "reject" }).success, true);
});

// ─── 错误信息 ─────────────────────────────────────────────────────────────

test("zod 错误能压成一句带字段名的人话", () => {
  const r = storageSchema.safeParse({ storageScore: 70 });
  assert.equal(r.success, false);
  if (!r.success) {
    const msg = zodMessage(r.error);
    assert.match(msg, /仓储评分/);
    assert.match(msg, /60/);
  }
});
