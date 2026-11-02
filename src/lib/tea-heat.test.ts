/**
 * 茶品热度与排序 —— 钉住 2026-11-02「经典普洱列表一直是品鉴数倒序」的修法。
 *
 * 关键性质：
 *   1. 热度**复用热榜公式**（scoreThread），不是另写一套 → 与论坛热榜同口径；
 *   2. 排序**带读者级 + 每小时轮转** → 每次点进来顺序会变（站长明确要这个）；
 *   3. 「最近更新」用 lastActivity，**不是 createdAt**；
 *   4. 纯函数：now 注入，没有隐藏的时钟依赖。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTeaSort,
  sortTeas,
  sortTeasByHeat,
  sortTeasByNotes,
  sortTeasByUpdated,
  teaHeatScore,
  teaSortHref,
  type TeaHeatInput,
} from "./tea-heat.ts";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const HOUR = 3600000;

function tea(over: Partial<TeaHeatInput> & { id: string }): TeaHeatInput {
  return {
    netVotes: 0,
    replyCount: 0,
    realReaders: 0,
    hasMedia: false,
    lastActivity: new Date(NOW - 100 * HOUR),
    ...over,
  };
}

test("排序参数归一化：认得的用它，别的回落热度", () => {
  assert.equal(normalizeTeaSort("heat"), "heat");
  assert.equal(normalizeTeaSort("updated"), "updated");
  assert.equal(normalizeTeaSort("notes"), "notes");
  assert.equal(normalizeTeaSort(undefined), "heat");
  assert.equal(normalizeTeaSort(""), "heat");
  assert.equal(normalizeTeaSort("随便"), "heat");
});

test("排序 URL：默认热度不带 sort 参数，其余带上且不丢已有筛选", () => {
  assert.equal(teaSortHref("heat", {}), "/forum/classics");
  assert.equal(teaSortHref("updated", {}), "/forum/classics?sort=updated");
  assert.equal(teaSortHref("updated", { bar: "dayi", type: "raw" }), "/forum/classics?bar=dayi&type=raw&sort=updated");
  assert.equal(teaSortHref("heat", { bar: "dayi" }), "/forum/classics?bar=dayi");
});

test("热度：赞越多分越高", () => {
  const low = tea({ id: "a", netVotes: 1 });
  const high = tea({ id: "b", netVotes: 50 });
  assert.ok(teaHeatScore(high, NOW) > teaHeatScore(low, NOW));
});

test("热度：回复越多分越高", () => {
  const low = tea({ id: "a", replyCount: 0 });
  const high = tea({ id: "a", replyCount: 30 });
  assert.ok(teaHeatScore(high, NOW) > teaHeatScore(low, NOW));
});

test("热度：真实读者越多分越高（爬虫口径的 viewCount 不参与）", () => {
  const low = tea({ id: "a", realReaders: 0 });
  const high = tea({ id: "a", realReaders: 200 });
  assert.ok(teaHeatScore(high, NOW) > teaHeatScore(low, NOW));
});

test("热度：有图有视频加分（与热榜同一个媒体加成）", () => {
  // 注意：得分是「质量 × 媒体 × 时间」的乘积，**基础分必须非零**才看得出加成
  const plain = tea({ id: "a", netVotes: 10 });
  const media = tea({ id: "a", netVotes: 10, hasMedia: true });
  assert.ok(teaHeatScore(media, NOW) > teaHeatScore(plain, NOW));
});

test("热度：最近活动的分更高（时间只加成不惩罚）", () => {
  const old = tea({ id: "a", netVotes: 10, lastActivity: new Date(NOW - 500 * HOUR) });
  const fresh = tea({ id: "a", netVotes: 10, lastActivity: new Date(NOW - 1 * HOUR) });
  assert.ok(teaHeatScore(fresh, NOW) > teaHeatScore(old, NOW));
});

test("热度排序：互动多的排前面", () => {
  const list = [
    tea({ id: "cold", netVotes: 0, replyCount: 0 }),
    tea({ id: "hot", netVotes: 40, replyCount: 12, realReaders: 80, hasMedia: true }),
    tea({ id: "warm", netVotes: 5, replyCount: 2 }),
  ];
  const ranked = sortTeasByHeat(list, { now: NOW, bucket: 0, sessionUserId: "u1" });
  assert.equal(ranked[0].id, "hot");
  assert.equal(ranked[ranked.length - 1].id, "cold");
});

test("热度排序：同一个时间桶内对同一读者是稳定的", () => {
  const list = Array.from({ length: 12 }, (_, i) =>
    tea({ id: `t${i}`, netVotes: i, lastActivity: new Date(NOW - i * HOUR) }),
  );
  const a = sortTeasByHeat(list, { now: NOW, bucket: 42, sessionUserId: "u1" }).map((t) => t.id);
  const b = sortTeasByHeat(list, { now: NOW, bucket: 42, sessionUserId: "u1" }).map((t) => t.id);
  assert.deepEqual(a, b);
});

test("热度排序：带读者级 + 每小时轮转的抖动（同分时顺序由抖动决定）", () => {
  // 全部同分 → 顺序完全由抖动决定。固定 seed，所以这是确定性断言（不会 flaky）。
  const list = Array.from({ length: 20 }, (_, i) =>
    tea({ id: `t${i}`, netVotes: 5, lastActivity: new Date(NOW - 10 * HOUR) }),
  );
  const readerA = sortTeasByHeat(list, { now: NOW, bucket: 42, sessionUserId: "u1" }).map((t) => t.id);
  const readerB = sortTeasByHeat(list, { now: NOW, bucket: 42, sessionUserId: "u2" }).map((t) => t.id);
  const bucketB = sortTeasByHeat(list, { now: NOW, bucket: 43, sessionUserId: "u1" }).map((t) => t.id);
  assert.notDeepEqual(readerA, readerB);
  assert.notDeepEqual(readerA, bucketB);
});

test("热度排序：明显更热的茶仍然在前（抖动不是随机乱序）", () => {
  const list = [
    ...Array.from({ length: 12 }, (_, i) =>
      tea({ id: `t${i}`, netVotes: 5, lastActivity: new Date(NOW - 10 * HOUR) }),
    ),
    tea({ id: "top", netVotes: 500, lastActivity: new Date(NOW - 10 * HOUR) }),
  ];
  const ranked = sortTeasByHeat(list, { now: NOW, bucket: 42, sessionUserId: "u1" });
  assert.equal(ranked[0].id, "top");
});

test("最近更新：按 lastActivity 倒序，并列时按名字稳定", () => {
  const t0 = new Date(NOW - 10 * HOUR);
  const t1 = new Date(NOW - 1 * HOUR);
  const list = [
    { id: "a", name: "a", lastActivity: t0 },
    { id: "b", name: "b", lastActivity: t1 },
    { id: "c", name: "c", lastActivity: t1 },
  ];
  const ranked = sortTeasByUpdated(list).map((t) => t.id);
  assert.deepEqual(ranked, ["b", "c", "a"]);
});

test("品鉴最多：按笔记数倒序，并列按年份再按名字", () => {
  const list = [
    { id: "a", name: "a", year: 2000, tastingNoteCount: 3 },
    { id: "b", name: "b", year: 2010, tastingNoteCount: 3 },
    { id: "c", name: "c", year: 1999, tastingNoteCount: 9 },
  ];
  const ranked = sortTeasByNotes(list).map((t) => t.id);
  assert.deepEqual(ranked, ["c", "b", "a"]);
});

test("分派：三种口径各走各的", () => {
  const list = [
    { ...tea({ id: "cold", netVotes: 0 }), tastingNoteCount: 10, year: 2000, name: "cold" },
    { ...tea({ id: "hot", netVotes: 90, replyCount: 20 }), tastingNoteCount: 1, year: 2010, name: "hot" },
  ];
  assert.equal(sortTeas(list, "heat", { now: NOW, bucket: 0, sessionUserId: "u1" })[0].id, "hot");
  assert.equal(sortTeas(list, "notes", { now: NOW, bucket: 0, sessionUserId: "u1" })[0].id, "cold");
});
