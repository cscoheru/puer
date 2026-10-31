/**
 * 上传 MIME 判定的单测 —— 钉住 2026-10-31「手机端发帖图片上传失败」的根因。
 *
 * 那次事故的形态：客户端手抄了一份比服务端窄的白名单，HEIC/AVIF 被**静默丢弃**
 * （文件不进列表、不发请求、界面上连缩略图都没有），点提交才报「请至少上传一个
 * 文件」；文本帖不走这段代码，所以照常能发。
 *
 * 这些断言的作用是：**以后谁再往客户端塞一份手抄的白名单，这里会红。**
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_UPLOAD_MIMES,
  describeRejectedFiles,
  guessMimeFromName,
  isAllowedUploadMime,
  resolveUploadFile,
} from "./upload-mime.ts";
import { IMAGE_MIMES, VIDEO_MIMES } from "./upload-types.ts";

/** 造一个 File（Node 20+ 有全局 File）。 */
function makeFile(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1700000000000 });
}

test("白名单就是服务端那份（不多不少）", () => {
  assert.deepEqual(
    [...ALLOWED_UPLOAD_MIMES].sort(),
    [...IMAGE_MIMES, ...VIDEO_MIMES].sort(),
  );
});

test("手机相册的格式必须被接受（HEIC / HEIF / AVIF）", () => {
  // iPhone 默认 HEIC，Android 10+ 相机默认 AVIF —— 这两个被丢就是这次的事故。
  for (const mime of ["image/heic", "image/heif", "image/avif"]) {
    assert.ok(isAllowedUploadMime(mime), `${mime} 应当被允许`);
    const r = resolveUploadFile(makeFile("IMG_1234.HEIC", mime));
    assert.ok(r, `${mime} 应当解析成功`);
    assert.equal(r.mime, mime);
    assert.equal(r.isVideo, false);
  }
});

test("浏览器不给 type 时按扩展名救回来（微信/WebView 常见）", () => {
  const r = resolveUploadFile(makeFile("IMG_0001.HEIC", ""));
  assert.ok(r);
  assert.equal(r.mime, "image/heic");
  assert.equal(r.guessed, true);
  // 关键：type 必须写回文件，否则 multipart 的 Content-Type 是空的，
  // 服务端会以「不支持的文件类型」拒绝。
  assert.equal(r.file.type, "image/heic");
  assert.equal(r.file.name, "IMG_0001.HEIC");
  assert.equal(r.file.size, 8);
});

test("application/octet-stream 也按扩展名救", () => {
  const r = resolveUploadFile(makeFile("photo.jpg", "application/octet-stream"));
  assert.ok(r);
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.file.type, "image/jpeg");
});

test("扩展名大小写不影响推断", () => {
  assert.equal(guessMimeFromName("IMG_1.HEIC"), "image/heic");
  assert.equal(guessMimeFromName("IMG_1.HEIF"), "image/heif");
  assert.equal(guessMimeFromName("clip.MOV"), "video/quicktime");
  assert.equal(guessMimeFromName("a.b.jpeg"), "image/jpeg");
});

test("推不出来的就拒绝，不猜", () => {
  assert.equal(guessMimeFromName("noextension"), null);
  assert.equal(guessMimeFromName("archive.zip"), null);
  assert.equal(guessMimeFromName("notes.txt"), null);
  assert.equal(resolveUploadFile(makeFile("notes.txt", "")), null);
});

test("类型不在白名单里就拒绝（真·不支持的格式）", () => {
  assert.equal(resolveUploadFile(makeFile("a.bmp", "image/bmp")), null);
  assert.equal(resolveUploadFile(makeFile("a.svg", "image/svg+xml")), null);
  assert.equal(resolveUploadFile(makeFile("a.pdf", "application/pdf")), null);
});

test("kind 限定：只收图 / 只收视频", () => {
  assert.equal(resolveUploadFile(makeFile("a.mp4", "video/mp4"), "image"), null);
  assert.ok(resolveUploadFile(makeFile("a.mp4", "video/mp4"), "video"));
  assert.equal(resolveUploadFile(makeFile("a.jpg", "image/jpeg"), "video"), null);
  assert.ok(resolveUploadFile(makeFile("a.jpg", "image/jpeg"), "image"));
});

test("视频 MIME 也在同一份白名单里", () => {
  for (const mime of ["video/mp4", "video/webm", "video/quicktime"]) {
    assert.ok(isAllowedUploadMime(mime));
    const r = resolveUploadFile(makeFile("clip.mov", mime));
    assert.ok(r);
    assert.equal(r.isVideo, true);
  }
});

test("白名单之外的 MIME 一律不接受（哪怕大小写像）", () => {
  assert.equal(isAllowedUploadMime("image/jpeg "), false);
  assert.equal(isAllowedUploadMime("IMAGE/JPEG"), false);
  assert.equal(isAllowedUploadMime("image/jpg"), false);
});

test("被跳过的文件要给出人话，而不是静默丢弃", () => {
  const msg = describeRejectedFiles(["a.bmp", "b.tif"]);
  assert.match(msg, /a\.bmp/);
  assert.match(msg, /b\.tif/);
  assert.match(msg, /HEIC/); // 提示里要列出真正支持的格式
  assert.match(msg, /支持 JPG/);
});

test("被跳过的文件很多时要收尾", () => {
  const msg = describeRejectedFiles(["a", "b", "c", "d", "e"]);
  assert.match(msg, /等 5 个文件/);
});
