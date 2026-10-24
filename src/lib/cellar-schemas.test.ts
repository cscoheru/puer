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

test("仓储评分接受中间值（45/50/55/60 是参考点，不是四个取值）", () => {
  // 服务端本来就允许 45–60 的任意整数（DB 的 CHECK 约束同理），
  // 之前只有 UI 把它压成了四个按钮。这条断言钉住「中间值合法」，
  // 免得将来有人把它「修回」枚举。
  for (const score of [47, 52, 58]) {
    assert.equal(storageSchema.safeParse({ storageScore: score }).success, true);
    assert.equal(
      addStorageEpochSchema.safeParse({ storageScore: score }).success,
      true,
      `换仓接口也要接受 ${score}`,
    );
  }
});

test("仓储三项都可跳过", () => {
  assert.equal(storageSchema.safeParse({}).success, true);
});

// ─── 品鉴：按维度归类的描述词 + 视频 ──────────────────────────────────────

test("dimTags 接受四个维度各自的词数组", () => {
  const r = addTastingSchema.safeParse({
    stage: "peak",
    dimTags: { aroma: ["蜜香"], flavor: ["甜", "厚"] },
  });
  assert.equal(r.success, true);
});

test("dimTags 拒绝未知维度（拼错的键不能静默吞掉）", () => {
  const r = addTastingSchema.safeParse({
    stage: "peak",
    dimTags: { water_path: ["细"] },
  });
  assert.equal(r.success, false, "water_path 不是维度名");
});

test("dimTags 拒绝空数组以外的怪东西", () => {
  assert.equal(
    addTastingSchema.safeParse({ stage: "peak", dimTags: { aroma: [] } }).success,
    true,
    "空数组合法（等于没选）",
  );
  assert.equal(
    addTastingSchema.safeParse({ stage: "peak", dimTags: { aroma: "蜜香" } }).success,
    false,
    "值必须是数组",
  );
  assert.equal(
    addTastingSchema.safeParse({ stage: "peak", dimTags: { aroma: ["x".repeat(41)] } }).success,
    false,
    "词太长",
  );
});

test("外站地址一律拒（哪怕路径是 /uploads/ —— 域名不对就是外站）", () => {
  // 之前只查协议与路径前缀、不查域名，https://evil.com/uploads/x.mp4
  // 会被放行 —— 而这些地址是直接渲染成 <img src> / <video src> 的。
  for (const bad of [
    "https://evil.com/uploads/x.mp4",
    "https://evil.com/uploads/x.jpg",
    "//evil.com/uploads/x.jpg",
    "http://puer.im/uploads/x.jpg",
  ]) {
    assert.equal(
      addTastingSchema.safeParse({ stage: "peak", images: [bad] }).success,
      false,
      `图片应拒 ${bad}`,
    );
    assert.equal(
      addTastingSchema.safeParse({ stage: "peak", videos: [bad] }).success,
      false,
      `视频应拒 ${bad}`,
    );
  }
  // 本站绝对地址与站内相对路径都收
  assert.equal(
    addTastingSchema.safeParse({
      stage: "peak",
      images: ["https://puer.im/uploads/tea/a.jpg"],
    }).success,
    true,
  );
});

test("每个维度最多 20 个词（客户端必须先夹住，否则整条记录 400）", () => {
  assert.equal(
    addTastingSchema.safeParse({
      stage: "peak",
      dimTags: { flavor: Array.from({ length: 20 }, (_, i) => `味${i}`) },
    }).success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({
      stage: "peak",
      dimTags: { flavor: Array.from({ length: 21 }, (_, i) => `味${i}`) },
    }).success,
    false,
  );
});

test("图片与视频都只收站内上传的地址", () => {
  const ok = addTastingSchema.safeParse({
    stage: "peak",
    images: ["/uploads/tea/a.jpg"],
    videos: ["/uploads/tea/a.mp4"],
  });
  assert.equal(ok.success, true);

  const external = addTastingSchema.safeParse({
    stage: "peak",
    images: ["https://evil.example/x.jpg"],
  });
  assert.equal(external.success, false, "外部图片地址要拒");

  const externalVideo = addTastingSchema.safeParse({
    stage: "peak",
    videos: ["https://evil.example/x.mp4"],
  });
  assert.equal(externalVideo.success, false, "外部视频地址要拒");

  const notUploads = addTastingSchema.safeParse({
    stage: "peak",
    videos: ["/api/evil"],
  });
  assert.equal(notUploads.success, false, "非 uploads 路径要拒");
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

test("新建条目：targetUserId 被拒（代录已取消，没有「写进别人名下」的口子）", () => {
  // 2026-10-23 站长拍板取消代录。schema 是 strictObject，所以这个字段
  // 直接被判为未知字段 —— 老的调用方传了它会拿到 400，而不是静默写进
  // 调用者自己的茶仓（那会造成「以为记在别人名下、其实记在自己名下」）。
  const r = createCellarItemSchema.safeParse({ teaId: "t1", targetUserId: "u2" });
  assert.equal(r.success, false, "targetUserId 必须被拒");
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
  // 上限 100：四个维度各 20 个词再加通用词，摊平后 20 装不下
  assert.equal(
    addTastingSchema.safeParse({ descriptors: Array(100).fill("蜜香") }).success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({ descriptors: Array(101).fill("蜜香") }).success,
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
  const img = "https://puer.im/uploads/forum/a.jpg";
  assert.equal(
    addTastingSchema.safeParse({ images: Array(9).fill(img) }).success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({ images: Array(10).fill(img) }).success,
    false,
  );
});

test("品鉴：图片只收站内上传的地址（外站地址一律拒）", () => {
  // 站里的图片落地在 /uploads/ 下。外站地址不该进一条声称「仅自己可见」
  // 的记录里 —— 那等于把别人的图片地址存进自己的私有数据。
  assert.equal(
    addTastingSchema.safeParse({ images: ["https://evil.test/x.jpg"] }).success,
    false,
  );
  assert.equal(
    addTastingSchema.safeParse({ images: ["https://puer.im/uploads/tea/a.jpg"] })
      .success,
    true,
  );
  assert.equal(
    addTastingSchema.safeParse({ images: ["javascript:alert(1)"] }).success,
    false,
  );
});

test("品鉴：visibility 不由 API 决定（社区带的同意只有一个开关）", () => {
  // 记录级的 visibility 是第二条同意通道 —— 照它实现就会绕过账号级的
  // share_aggregate 同意，把单条记录发出去。所以 API 层不收它。
  assert.equal(
    addTastingSchema.safeParse({ visibility: "shared" }).success,
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
