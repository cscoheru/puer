/**
 * 转化档案可见性分级 —— 钉住「摘要公开、正文/全部图片要付费会员」的口径
 * （站长 2026-11-02 定；P2-R22 的原意就是给付费体系预留的）。
 *
 * 最重要的一条：**未付费档拿到的 content 必须是空串**。这不是「显示上隐藏」——
 * 服务端把 content 传给客户端组件就等于进了 RSC payload，view-source 里就有全文。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveTier,
  canEditArchive,
  canOpenArchiveDetail,
  canViewArchiveBody,
  canViewArchiveImages,
  canViewNoteBody,
  gateArchiveContent,
  WALL_PREVIEW_COUNT,
} from "./archive-visibility.ts";

const IMAGES = Array.from({ length: 20 }, (_, i) => `/uploads/tea/x${i}.jpg`);

test("匿名 → public 档；登录 → member；付费 → paid；管理员 → staff", () => {
  assert.equal(archiveTier(null), "public");
  assert.equal(archiveTier(undefined), "public");
  assert.equal(archiveTier({}), "public");
  assert.equal(archiveTier({ userId: "u1" }), "member");
  assert.equal(archiveTier({ isPaidMember: true }), "paid");
  assert.equal(archiveTier({ userId: "u1", isAdmin: true }), "staff");
  assert.equal(archiveTier({ userId: "u1", isPaidMember: true, isAdmin: true }), "staff");
});

test("正文只有付费会员与管理员看得到（登录不等于看全文）", () => {
  // 2026-11-02 修正：member 档（已登录）**不能**看全文 —— P2-R22 的原意是
  // 「仅付费会员可见」。第一次落地时误把 member 当成「已登录 = 全文」，
  // 等于给全体注册用户开了全文。
  assert.equal(canViewArchiveBody("public"), false);
  assert.equal(canViewArchiveBody("member"), false);
  assert.equal(canViewArchiveBody("paid"), true);
  assert.equal(canViewArchiveBody("staff"), true);
});

test("全部图片跟正文同档；未付费只给前几张", () => {
  assert.equal(canViewArchiveImages("public"), false);
  assert.equal(canViewArchiveImages("member"), false);
  assert.equal(canViewArchiveImages("paid"), true);
  assert.equal(canViewArchiveImages("staff"), true);
});

test("只有 staff 能编辑", () => {
  assert.equal(canEditArchive("public"), false);
  assert.equal(canEditArchive("member"), false);
  assert.equal(canEditArchive("paid"), false);
  assert.equal(canEditArchive("staff"), true);
});

test("匿名打不开详情页（列表卡片对他们不是链接）", () => {
  assert.equal(canOpenArchiveDetail("public"), false);
  assert.equal(canOpenArchiveDetail("member"), true);
  assert.equal(canOpenArchiveDetail("paid"), true);
  assert.equal(canOpenArchiveDetail("staff"), true);
});

test("未付费档拿不到正文（SSR 里也不能有）", () => {
  for (const tier of ["public", "member"] as const) {
    const gated = gateArchiveContent(tier, "这是站长的完整笔记正文……", IMAGES);
    assert.equal(gated.content, "", `${tier} 档不应拿到正文`);
    assert.equal(gated.locked, true);
    // 图片只给前几张，其余 URL 不下发
    assert.equal(gated.images.length, WALL_PREVIEW_COUNT);
    assert.ok(gated.images.length < IMAGES.length);
  }
});

test("付费会员与管理员拿到全文与全部图片", () => {
  for (const tier of ["paid", "staff"] as const) {
    const gated = gateArchiveContent(tier, "全文正文", IMAGES);
    assert.equal(gated.content, "全文正文");
    assert.equal(gated.images.length, IMAGES.length);
    assert.equal(gated.locked, false);
  }
});

test("作者本人永远看得到自己的笔记", () => {
  assert.equal(canViewNoteBody("member", { userId: "u1" }, "u1"), true);
  assert.equal(canViewNoteBody("member", { userId: "u2" }, "u1"), false);
  assert.equal(canViewNoteBody("paid", { userId: "u2" }, "u1"), true);
});
