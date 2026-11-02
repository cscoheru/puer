/**
 * 转化档案可见性分级 —— 钉住「摘要公开，正文要登录」（站长 2026-11-02 定的口径）。
 *
 * 最重要的一条：**匿名访客拿到的 content 必须是空串**。这不是「显示上隐藏」——
 * 服务端把 content 传给客户端组件就等于进了 RSC payload，view-source 里就有全文。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveTier,
  canEditArchive,
  canViewArchiveBody,
  canViewArchiveImages,
  canViewNoteBody,
  gateArchiveContent,
  WALL_PREVIEW_COUNT,
} from "./archive-visibility.ts";

const IMAGES = Array.from({ length: 20 }, (_, i) => `/uploads/tea/x${i}.jpg`);

test("匿名 → public 档", () => {
  assert.equal(archiveTier(null), "public");
  assert.equal(archiveTier(undefined), "public");
  assert.equal(archiveTier({}), "public");
});

test("登录 → member 档；管理员 → staff 档", () => {
  assert.equal(archiveTier({ userId: "u1" }), "member");
  assert.equal(archiveTier({ isPaidMember: true }), "member");
  assert.equal(archiveTier({ userId: "u1", isAdmin: true }), "staff");
});

test("摘要公开：public 档也能看正文吗？——不能", () => {
  assert.equal(canViewArchiveBody("public"), false);
  assert.equal(canViewArchiveBody("member"), true);
  assert.equal(canViewArchiveBody("staff"), true);
});

test("图片跟正文同档", () => {
  assert.equal(canViewArchiveImages("public"), false);
  assert.equal(canViewArchiveImages("member"), true);
  assert.equal(canViewArchiveImages("staff"), true);
});

test("只有 staff 能编辑", () => {
  assert.equal(canEditArchive("public"), false);
  assert.equal(canEditArchive("member"), false);
  assert.equal(canEditArchive("staff"), true);
});

test("匿名访客拿不到正文（SSR 里也不能有）", () => {
  const gated = gateArchiveContent("public", "这是站长的完整笔记正文……", IMAGES);
  assert.equal(gated.content, "");
  assert.equal(gated.locked, true);
  // 图片只给前几张，其余 URL 不下发
  assert.equal(gated.images.length, WALL_PREVIEW_COUNT);
  assert.ok(gated.images.length < IMAGES.length);
});

test("登录用户拿到全文与全部图片", () => {
  const gated = gateArchiveContent("member", "全文正文", IMAGES);
  assert.equal(gated.content, "全文正文");
  assert.equal(gated.images.length, IMAGES.length);
  assert.equal(gated.locked, false);
});

test("管理员同样拿到全文（编辑要看到原文）", () => {
  const gated = gateArchiveContent("staff", "全文正文", IMAGES);
  assert.equal(gated.content, "全文正文");
  assert.equal(gated.locked, false);
});

test("作者本人永远看得到自己的笔记", () => {
  assert.equal(canViewNoteBody("public", { userId: "u1" }, "u1"), true);
  assert.equal(canViewNoteBody("public", { userId: "u2" }, "u1"), false);
  assert.equal(canViewNoteBody("member", { userId: "u2" }, "u1"), true);
});
