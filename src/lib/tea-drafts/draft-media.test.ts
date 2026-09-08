import { test } from "node:test";
import assert from "node:assert/strict";
import { planVideoSync, validateDraftImages, MAX_DRAFT_IMAGES } from "./draft-media.ts";

test("planVideoSync: identical arrays → keep", () => {
  const imgs = ["/uploads/forum/a.jpg", "/uploads/forum/b.jpg"];
  assert.equal(planVideoSync(imgs, [...imgs]), "keep");
});

test("planVideoSync: same set different order → not keep (order matters)", () => {
  const a = ["/uploads/1.jpg", "/uploads/2.jpg", "/uploads/3.jpg", "/uploads/4.jpg"];
  assert.notEqual(planVideoSync(a, [...a].reverse()), "keep");
  assert.equal(planVideoSync(a, [...a].reverse()), "regenerate");
});

test("planVideoSync: changed with >=4 images → regenerate", () => {
  const cur = ["/uploads/1.jpg", "/uploads/2.jpg", "/uploads/3.jpg", "/uploads/4.jpg"];
  const next = cur.slice(1); // still 4 after adding one elsewhere
  next.push("/uploads/5.jpg");
  assert.equal(planVideoSync(cur, next), "regenerate");
});

test("planVideoSync: changed with <4 images → clear", () => {
  const cur = ["/uploads/1.jpg", "/uploads/2.jpg", "/uploads/3.jpg", "/uploads/4.jpg"];
  assert.equal(planVideoSync(cur, cur.slice(0, 3)), "clear");
  assert.equal(planVideoSync(cur, []), "clear");
});

test("planVideoSync: delete then re-add same content in same order → keep", () => {
  const cur = ["/uploads/1.jpg", "/uploads/2.jpg"];
  assert.equal(planVideoSync(cur, ["/uploads/1.jpg", "/uploads/2.jpg"]), "keep");
});

test("planVideoSync: tolerate null-ish current", () => {
  assert.equal(planVideoSync(null as unknown as string[], [1, 2, 3, 4].map(i => `/uploads/${i}.jpg`)), "regenerate");
});

test("validateDraftImages: accepts site /uploads/ and https URLs", () => {
  const r = validateDraftImages(["/uploads/forum/a.jpg", "https://cdn.example.com/b.png"]);
  assert.ok(r.ok);
  assert.deepEqual(r.images, ["/uploads/forum/a.jpg", "https://cdn.example.com/b.png"]);
});

test("validateDraftImages: rejects dangerous schemes", () => {
  for (const bad of [
    "data:text/html,<script>",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://insecure.example.com/a.jpg",
    "/etc/passwd",
    "/uploads/../secrets",
  ]) {
    const r = validateDraftImages([bad]);
    assert.ok(!r.ok, `expected reject: ${bad}`);
  }
});

test("validateDraftImages: rejects non-array / non-string / oversize", () => {
  assert.ok(!validateDraftImages("nope").ok);
  assert.ok(!validateDraftImages(["ok.png", 42]).ok);
  assert.ok(!validateDraftImages(new Array(MAX_DRAFT_IMAGES + 1).fill("/uploads/a.jpg")).ok);
});
