import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv } from "./tasting-corrections.ts";
import {
  CELLAR_EXPORT_CSV_HEADER,
  CELLAR_MAX_DESCRIPTORS,
  CELLAR_MAX_DIM_TAGS,
  DIM_KEYS,
  filterVocab,
  groupVocabByDim,
  latestTastingByCreatedAt,
  buildTastingTags,
  normalizeStorageScore,
  nextTastingDefaults,
  overallScore,
  parseDims,
  storageAnchorOf,
  storageBandLabel,
  storageScalePercent,
  storageScoreLabel,
  suggestRemindMonths,
  nextTastingAllowedAt,
  tastingWaitRemainingMs,
  toggleDimTag,
  formatWaitRemaining,
  formatWaitMessage,
  cellarExportCsv,
  cellarExportJson,
  cellarExportRows,
  cellarCsvCell,
  STORAGE_ANCHORS,
  STORAGE_DEFAULT_SCORE,
  STORAGE_SCORE_MAX,
  STORAGE_SCORE_MIN,
  type ExportItem,
} from "./cellar.ts";

// ─── 仓储评分 ─────────────────────────────────────────────────────────────

test("仓储评分接受 45–60 的整数", () => {
  assert.equal(normalizeStorageScore(45), 45);
  assert.equal(normalizeStorageScore(50), 50);
  assert.equal(normalizeStorageScore(60), 60);
  assert.equal(normalizeStorageScore("55"), 55);
  assert.equal(normalizeStorageScore(" 52 "), 52);
});

test("仓储评分拒绝越界、非整数与非数字", () => {
  assert.equal(normalizeStorageScore(44), null);
  assert.equal(normalizeStorageScore(61), null);
  assert.equal(normalizeStorageScore(47.5), null);
  assert.equal(normalizeStorageScore("偏干"), null);
  assert.equal(normalizeStorageScore(null), null);
  assert.equal(normalizeStorageScore(undefined), null);
  assert.equal(normalizeStorageScore(""), null);
});

test("中间值归到最近的锚点（整数下无平局）", () => {
  assert.equal(storageAnchorOf(45)?.score, 45);
  assert.equal(storageAnchorOf(47)?.score, 45);
  assert.equal(storageAnchorOf(48)?.score, 50);
  assert.equal(storageAnchorOf(52)?.score, 50);
  assert.equal(storageAnchorOf(53)?.score, 55);
  assert.equal(storageAnchorOf(57)?.score, 55);
  assert.equal(storageAnchorOf(58)?.score, 60);
  assert.equal(storageAnchorOf(null), null);
});

test("储仓分档名", () => {
  assert.equal(storageBandLabel(45), "标准偏干");
  assert.equal(storageBandLabel(50), "标准仓");
  assert.equal(storageBandLabel(55), "标准偏湿");
  assert.equal(storageBandLabel(60), "湿仓");
  assert.equal(storageBandLabel(null), "未记录");
});

// ─── 仓储是一条数轴，不是四个档位 ─────────────────────────────────────────

test("中间值是合法评分（45/50/55/60 只是参考点，不是四个取值）", () => {
  assert.equal(normalizeStorageScore(47), 47);
  assert.equal(normalizeStorageScore(52), 52);
  assert.equal(normalizeStorageScore(58), 58);
});

test("标尺位置：最小值在最左、最大值在最右", () => {
  assert.equal(storageScalePercent(STORAGE_SCORE_MIN), 0);
  assert.equal(storageScalePercent(STORAGE_SCORE_MAX), 1);
  assert.equal(storageScalePercent(null), null, "未记录不是「值在端点」");
});

test("标尺位置线性：把 [最小值, 最大值] 映射到 0–1", () => {
  assert.ok(Math.abs(storageScalePercent(50)! - 1 / 3) < 1e-9);
  assert.ok(Math.abs(storageScalePercent(55)! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(storageScalePercent(47)! - 2 / 15) < 1e-9);
});

test("四个锚点在数轴上等距（刻度标签才排得均匀）", () => {
  const gaps = STORAGE_ANCHORS.slice(1).map(
    (a, i) => a.score - STORAGE_ANCHORS[i].score,
  );
  assert.deepEqual(gaps, [5, 5, 5]);
});

test("每个锚点都算得出标尺位置（否则滑块的刻度会少一格）", () => {
  for (const a of STORAGE_ANCHORS) {
    assert.notEqual(
      storageScalePercent(a.score),
      null,
      `锚点 ${a.score} 算不出位置，刻度会整条消失`,
    );
  }
});

test("标尺位置与规整用同一套口径：不合法分一律 null", () => {
  // 「什么算合法仓储分」只有一份定义（normalizeStorageScore）。
  // 标尺函数若宽松一点，就等于悄悄开了第二套标准。
  for (const raw of [44, 61, 47.5, NaN, Infinity, -Infinity]) {
    assert.equal(
      storageScalePercent(raw),
      null,
      `${raw} 不是合法分，标尺位置也该是 null`,
    );
  }
  assert.equal(storageScalePercent(null), null);
  assert.equal(
    storageScalePercent(undefined as unknown as number),
    null,
  );
});

test("最近锚点正好在正中间时取较低的那个", () => {
  assert.equal(storageAnchorOf(47.5)?.score, 45);
});

test("未记录时滑块停在标准仓（不是几何中点）", () => {
  assert.equal(
    STORAGE_ANCHORS.find((a) => a.label === "标准仓")?.score,
    STORAGE_DEFAULT_SCORE,
    "默认停靠点必须就是「标准仓」那个锚点",
  );
  assert.notEqual(
    STORAGE_DEFAULT_SCORE,
    (STORAGE_SCORE_MIN + STORAGE_SCORE_MAX) / 2,
    "几何中点落在「标准偏湿」那边，暗示得比实际更湿",
  );
  assert.ok(
    STORAGE_DEFAULT_SCORE >= STORAGE_SCORE_MIN &&
      STORAGE_DEFAULT_SCORE <= STORAGE_SCORE_MAX,
    "停靠点必须落在数轴内",
  );
});

test("评分展示必须带数字（45 和 47 不能显示成同一个东西）", () => {
  assert.notEqual(storageScoreLabel(45), storageScoreLabel(47));
  assert.match(storageScoreLabel(47), /47/);
  assert.match(storageScoreLabel(47), /标准偏干/);
  assert.equal(storageScoreLabel(null), "未记录");
});

// ─── 四维 ─────────────────────────────────────────────────────────────────

test("四维接受 1–10 的整数", () => {
  const r = parseDims({ aroma: 7, flavor: 8, waterPath: 6, bodyFeel: 7 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.dims, { aroma: 7, flavor: 8, waterPath: 6, bodyFeel: 7 });
});

test("四维拒绝越界值并说明是哪个维度", () => {
  const r = parseDims({ aroma: 11, flavor: 0, waterPath: 6.5 });
  assert.equal(r.dims?.aroma, undefined);
  assert.equal(r.dims?.flavor, undefined);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors.join("；"), /香气/);
  assert.match(r.errors.join("；"), /滋味/);
});

test("四维拒绝未知键（拼错不能静默吞掉）", () => {
  const r = parseDims({ water_path: 6 });
  assert.equal(r.dims, null);
  assert.match(r.errors.join("；"), /water_path/);
});

test("四维部分缺失是允许的，但综合分不给", () => {
  const r = parseDims({ aroma: 7, flavor: 8 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.dims, { aroma: 7, flavor: 8 });
  assert.equal(overallScore(r.dims), null, "缺维度时不给综合分，避免假精度");
});

test("四维齐全时综合分是均值（一位小数）", () => {
  assert.equal(overallScore({ aroma: 7, flavor: 8, waterPath: 6, bodyFeel: 7 }), 7);
  assert.equal(overallScore({ aroma: 7, flavor: 8, waterPath: 6, bodyFeel: 8 }), 7.3);
  assert.equal(overallScore({ aroma: 1, flavor: 2, waterPath: 3, bodyFeel: 4 }), 2.5);
  assert.equal(overallScore(null), null);
});

test("四维的 key 集合固定为四个", () => {
  assert.deepEqual([...DIM_KEYS], ["aroma", "flavor", "waterPath", "bodyFeel"]);
});

// ─── 快速品鉴默认值 ───────────────────────────────────────────────────────

test("可选项默认沿用上次", () => {
  const d = nextTastingDefaults({
    grams: 8,
    vessel: "盖碗",
    descriptors: ["蜜香", "水路细"],
  });
  assert.equal(d.grams, 8);
  assert.equal(d.vessel, "盖碗");
  assert.deepEqual(d.descriptors, ["蜜香", "水路细"]);
});

test("没有上次时默认全空", () => {
  assert.deepEqual(nextTastingDefaults(null), {
    grams: null,
    vessel: null,
    descriptors: [],
  });
  assert.deepEqual(nextTastingDefaults(undefined), {
    grams: null,
    vessel: null,
    descriptors: [],
  });
});

// ─── 提醒间隔 ─────────────────────────────────────────────────────────────

test("提醒间隔按最近一次结果给建议", () => {
  assert.equal(suggestRemindMonths("better", 6), 3, "变好 → 缩短一半");
  assert.equal(suggestRemindMonths("same", 6), 6, "差不多 → 不变");
  assert.equal(suggestRemindMonths("worse", 6), 2, "变差 → 尽快喝");
  assert.equal(suggestRemindMonths(null, 6), 6);
  assert.equal(suggestRemindMonths("better", 1), 1, "下限是 1 个月");
});

// ─── 品鉴间隔（两次至少隔 24 小时）──────────────────────────────────────

test("没有上一次品鉴 → 随时可以记第一条", () => {
  const now = new Date("2026-10-24T00:00:00.000Z");
  assert.equal(tastingWaitRemainingMs(null, now), null);
  assert.equal(tastingWaitRemainingMs(undefined, now), null);
  assert.equal(nextTastingAllowedAt(null), null);
});

test("差一分钟就得等一分钟（23:59 不放行）", () => {
  const now = new Date("2026-10-24T00:00:00.000Z");
  const last = new Date(now.getTime() - (23 * 3_600_000 + 59 * 60_000));
  const remain = tastingWaitRemainingMs(last, now);
  assert.equal(remain, 60_000, "还差 1 分钟");
  assert.equal(formatWaitRemaining(remain!), "不到 1 分钟");
});

test("满 24 小时才放行", () => {
  const now = new Date("2026-10-24T00:00:00.000Z");
  const justUnder = new Date(now.getTime() - (24 * 3_600_000 - 1000));
  assert.notEqual(
    tastingWaitRemainingMs(justUnder, now),
    null,
    "还差 1 秒也不能记",
  );
  const exactly = new Date(now.getTime() - 24 * 3_600_000);
  assert.equal(tastingWaitRemainingMs(exactly, now), null, "满 24 小时放行");
  const later = new Date(now.getTime() - 25 * 3_600_000);
  assert.equal(tastingWaitRemainingMs(later, now), null);
});

test("间隔按服务端 createdAt 算，客户端伪造的 tastedAt 绕不过", () => {
  // 判定只看「上一条记录的 createdAt」——那是数据库写的，客户端碰不到。
  // 客户端能伪造的只有 tastedAt（它甚至不参与判定）。
  const now = new Date("2026-10-24T00:00:00.000Z");
  const createdAnHourAgo = new Date(now.getTime() - 3_600_000);
  assert.equal(
    tastingWaitRemainingMs(createdAnHourAgo, now),
    23 * 3_600_000,
    "哪怕客户端声称这是一年前喝的，间隔仍按 createdAt 算",
  );
});

test("等待时长的提示是人话", () => {
  assert.equal(formatWaitRemaining(0), "现在就可以记");
  assert.equal(formatWaitRemaining(-1), "现在就可以记");
  assert.equal(formatWaitRemaining(30 * 60_000), "还需 30 分钟");
  assert.equal(formatWaitRemaining(3_600_000), "还需 1 小时");
  assert.equal(formatWaitRemaining(12 * 3_600_000), "还需 12 小时");
  assert.equal(formatWaitRemaining(23 * 3_600_000 + 59 * 60_000), "还需 24 小时");
});

test("间隔提示的整句话只有一份（24 这个数字来自常量，不各写一遍）", () => {
  const msg = formatWaitMessage(12 * 3_600_000);
  assert.match(msg, /24 小时/);
  assert.match(msg, /还需 12 小时/);
});

// ─── 上限与组装（客户端必须先夹住，否则整条记录被 400 打回）─────────────

test("一维的词被夹到服务端上限（不然 400 会把整条记录打回）", () => {
  // 词库实际规模：flavor 71、aroma 54、waterPath 37 —— 用户在「更多词」
  // 里很容易就选过 20 个。
  const flavor = Array.from({ length: 71 }, (_, i) => `味${i}`);
  const out = buildTastingTags({ flavor }, []);
  assert.equal(out.dimTags.flavor?.length, CELLAR_MAX_DIM_TAGS);
  assert.equal(out.dimTags.flavor?.length, 20);
});

test("摊平后的 descriptors 不超过服务端上限", () => {
  const perDim = Object.fromEntries(
    DIM_KEYS.map((k) => [
      k,
      Array.from({ length: 40 }, (_, i) => `${k}${i}`),
    ]),
  );
  const out = buildTastingTags(perDim, []);
  // 四个维度各 20 = 80，摊平后仍然是 80（没超上限）
  assert.ok(out.descriptors.length <= CELLAR_MAX_DESCRIPTORS);
  assert.equal(out.descriptors.length, 80);
  // 加上通用词也超不了上限
  const withFree = buildTastingTags(perDim, Array.from({ length: 40 }, (_, i) => `通${i}`));
  assert.ok(withFree.descriptors.length <= CELLAR_MAX_DESCRIPTORS);
});

test("同一个词出现在两个维度里：dimTags 各留各的，descriptors 只留一份", () => {
  const out = buildTastingTags({ aroma: ["甜"], flavor: ["甜"] }, ["甜"]);
  assert.deepEqual(out.dimTags, { aroma: ["甜"], flavor: ["甜"] });
  assert.deepEqual(out.descriptors, ["甜"]);
});

test("空的维度不出现在 dimTags 里（等于没选）", () => {
  const out = buildTastingTags({ aroma: [], flavor: ["厚"] }, []);
  assert.deepEqual(out.dimTags, { flavor: ["厚"] });
  assert.equal("aroma" in out.dimTags, false);
});

test("取消最后一个词时这一维整个消失", () => {
  const s1 = toggleDimTag({ aroma: ["蜜香"] }, "aroma", "蜜香");
  assert.deepEqual(s1, {});
  assert.equal("aroma" in s1, false);
});

test("再点一次同一个词是取消，不是重复添加", () => {
  let s = toggleDimTag({}, "aroma", "蜜香");
  s = toggleDimTag(s, "aroma", "蜜香");
  assert.deepEqual(s, {});
});

test("同一个词可以在两个维度里各自选中", () => {
  let s = toggleDimTag({}, "aroma", "甜");
  s = toggleDimTag(s, "flavor", "甜");
  assert.deepEqual(s, { aroma: ["甜"], flavor: ["甜"] });
});

// ─── 「上一次」取哪一条 ───────────────────────────────────────────────────

test("间隔基准取「创建时刻」最新的一条，不是「品鉴时刻」最新的一条", () => {
  const rows = [
    {
      id: "a",
      tastedAt: "2026-10-24T00:00:00.000Z",
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    {
      id: "b",
      tastedAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-10-24T00:00:00.000Z",
    },
  ];
  // b 的 tastedAt 更早（客户端可以伪造），但 createdAt 更晚 —— 基准必须是 b。
  assert.equal(latestTastingByCreatedAt(rows)?.id, "b");
});

test("没有品鉴记录 → null（随时可以记第一条）", () => {
  assert.equal(latestTastingByCreatedAt([]), null);
});

test("createdAt 坏掉的记录不参与「取最新」（别拿坏时间当基准）", () => {
  const rows = [
    { id: "a", createdAt: "不是日期" },
    { id: "b", createdAt: "2026-10-24T00:00:00.000Z" },
  ];
  assert.equal(latestTastingByCreatedAt(rows)?.id, "b");
});

// ─── 词库按维度分组 ───────────────────────────────────────────────────────

test("词库按维度分组：any 与无维度的词归到通用词", () => {
  const { byDim, free } = groupVocabByDim([
    { tag: "蜜香", dim: "aroma" },
    { tag: "甜", dim: "flavor" },
    { tag: "通用", dim: "any" },
    { tag: "无维", dim: null },
    { tag: "坏维度", dim: "water_path" },
  ]);
  assert.deepEqual(byDim.aroma, ["蜜香"]);
  assert.deepEqual(byDim.flavor, ["甜"]);
  assert.deepEqual(free, ["通用", "无维"]);
  assert.equal(byDim.waterPath, undefined, "未知维度不能出现");
});

// ─── 描述词库筛选 ─────────────────────────────────────────────────────────

test("描述词按生熟筛选，any 对两者都适用", () => {
  const entries = [
    { tag: "生普词", category: "raw" as const },
    { tag: "熟普词", category: "ripe" as const },
    { tag: "通用词", category: "any" as const },
  ];
  const raw = filterVocab(entries, { category: "raw" });
  assert.deepEqual(
    raw.map((e) => e.tag),
    ["生普词", "通用词"],
    "精确匹配排在 any 前面",
  );
});

test("描述词按维度筛选，不匹配的直接排除", () => {
  const entries = [
    { tag: "香气词", category: "any" as const, dim: "aroma" },
    { tag: "滋味词", category: "any" as const, dim: "flavor" },
    { tag: "通用词", category: "any" as const, dim: "any" },
  ];
  const out = filterVocab(entries, { dim: "aroma" });
  assert.deepEqual(
    out.map((e) => e.tag),
    ["香气词", "通用词"],
  );
});

test("描述词按年份段筛选", () => {
  const entries = [
    { tag: "新茶词", category: "any" as const, ageBracket: "young" },
    { tag: "老茶词", category: "any" as const, ageBracket: "aged" },
    { tag: "通用词", category: "any" as const, ageBracket: "any" },
  ];
  assert.deepEqual(
    filterVocab(entries, { ageBracket: "young" }).map((e) => e.tag),
    ["新茶词", "通用词"],
  );
});

// ─── 导出 ─────────────────────────────────────────────────────────────────

const sampleItems: ExportItem[] = [
  {
    id: "ci1",
    teaName: "某经典生普",
    name: null,
    acquiredAt: "2026-01-02T00:00:00.000Z",
    qtyNote: "还剩半饼",
    remindEveryMonths: 6,
    currentStorage: {
      startsAt: "2026-01-02T00:00:00.000Z",
      storageScore: 50,
      assessedBy: "self",
      city: "昆明",
      container: "紫砂罐",
      legacyStorageLabel: null,
    },
    epochs: [
      {
        startsAt: "2026-01-02T00:00:00.000Z",
        storageScore: 50,
        assessedBy: "self",
        city: "昆明",
        container: "紫砂罐",
        legacyStorageLabel: null,
      },
    ],
    tastings: [
      {
        id: "ct1",
        tastedAt: "2026-02-01T00:00:00.000Z",
        stage: "ascending",
        deltaVsPrev: null,
        dims: { aroma: 7, flavor: 8, waterPath: 6, bodyFeel: 7 },
        descriptors: ["蜜香", "水路细"],
        dimTags: { aroma: ["蜜香"], waterPath: ["水路细"] },
        grams: 7.5,
        vessel: "盖碗",
        note: "第一泡有点紧",
        images: ["https://example.test/a.jpg"],
        videos: [],
        visibility: "private",
        elapsedSeconds: 22,
      },
    ],
  },
  {
    id: "ci2",
    teaName: null,
    name: "自建茶",
    acquiredAt: null,
    qtyNote: null,
    remindEveryMonths: 6,
    currentStorage: null,
    epochs: [],
    tastings: [],
  },
];

test("导出 CSV 的表头与行数", () => {
  const csv = cellarExportCsv(sampleItems);
  const lines = csv.replace(/^﻿/, "").trim().split("\n");
  assert.equal(lines[0], CELLAR_EXPORT_CSV_HEADER.join(","));
  assert.equal(lines.length, 3, "表头 + 2 行（一条品鉴 + 一个无品鉴的条目）");
});

test("导出表头不能重名（重名会让同名列互相覆盖，凭空少一列）", () => {
  const seen = new Set<string>();
  for (const h of CELLAR_EXPORT_CSV_HEADER) {
    assert.equal(seen.has(h), false, `表头重名：${h}`);
    seen.add(h);
  }
});

test("每一行的列数与表头一致（否则数据会错位）", () => {
  const rows = cellarExportRows(sampleItems);
  for (const r of rows) {
    assert.equal(
      r.length,
      CELLAR_EXPORT_CSV_HEADER.length,
      "行宽与表头不一致",
    );
  }
});

test("导出的 CSV 能被解析回来（备注里的逗号/引号/换行都不丢）", () => {
  // 备注是自由文本（上限 5000 字），里面出现逗号、双引号、换行都完全正常。
  // 这正是 toCsv 的转义存在的理由 —— 用生产解析器验一遍才算数。
  const nasty = '他说"这饼很甜"，\n然后又改口';
  const csv = cellarExportCsv([
    {
      ...sampleItems[0],
      tastings: [{ ...sampleItems[0].tastings[0], note: nasty }],
    },
  ]);
  const table = parseCsv(csv);
  assert.equal(table.rows.length, 1, "一条品鉴 = 一行 CSV（备注里的换行不该多出行）");
  assert.equal(table.rows[0]["品鉴备注"], nasty);
  assert.equal(Object.keys(table.rows[0]).length, CELLAR_EXPORT_CSV_HEADER.length);
});

test("表头与数据列一一对应（改表头不会错位）", () => {
  const row = cellarExportRows(sampleItems)[0];
  const map = Object.fromEntries(
    CELLAR_EXPORT_CSV_HEADER.map((h, i) => [h, row[i]]),
  );
  assert.equal(map["条目ID"], "ci1");
  assert.equal(map["仓储评分"], 50);
  assert.equal(map["仓储档"], "标准仓");
  assert.equal(map["仓储评分人"], "self");
  assert.equal(map["仓储期序号"], 1);
  assert.equal(map["仓储期数"], 1);
  assert.equal(map["品鉴ID"], "ct1");
  assert.equal(map["综合"], 7);
  assert.equal(map["描述词"], "蜜香,水路细");
});

test("换过仓的条目：每一段仓储期都出现在导出里（不能只留最新那段）", () => {
  const item: ExportItem = {
    ...sampleItems[0],
    currentStorage: {
      startsAt: "2026-06-01T00:00:00.000Z",
      storageScore: 55,
      assessedBy: "self",
      city: "广州",
      container: null,
      legacyStorageLabel: null,
    },
    epochs: [
      {
        startsAt: "2026-01-02T00:00:00.000Z",
        storageScore: 45,
        assessedBy: "self",
        city: "昆明",
        container: "紫砂罐",
        legacyStorageLabel: null,
      },
      {
        startsAt: "2026-06-01T00:00:00.000Z",
        storageScore: 55,
        assessedBy: "self",
        city: "广州",
        container: null,
        legacyStorageLabel: null,
      },
    ],
  };
  const table = parseCsv(cellarExportCsv([item]));
  const scores = table.rows.map((r) => r["仓储评分"]);
  assert.deepEqual(scores, ["45", "55"], "两段仓储期都要在");
  assert.deepEqual(
    table.rows.map((r) => r["仓储期序号"]),
    ["1", "2"],
  );
  assert.deepEqual(
    table.rows.map((r) => r["仓储期数"]),
    ["2", "2"],
  );
});

test("没有品鉴记录的条目也会出现在导出里（不能丢条目）", () => {
  const csv = cellarExportCsv(sampleItems);
  assert.match(csv, /ci2/);
  assert.match(csv, /自建茶/);
});

test("描述词在 CSV 里用逗号分隔（与 F1 修正表同一套约定）", () => {
  const csv = cellarExportCsv(sampleItems);
  assert.match(csv, /蜜香,水路细/);
});

test("导出 CSV 带 BOM，Excel 打开不乱码", () => {
  assert.ok(cellarExportCsv(sampleItems).startsWith("﻿"));
});

test("导出 JSON 带版本号与条目", () => {
  const j = cellarExportJson(sampleItems);
  assert.equal(j.version, 1);
  assert.equal(j.items.length, 2);
  assert.ok(j.exportedAt);
});

// ─── CSV 公式注入 ─────────────────────────────────────────────────────────

test("CSV 单元格以 = + - @ 开头时加单引号（Excel 会当公式求值）", () => {
  assert.equal(cellarCsvCell("=1+1"), "'=1+1");
  assert.equal(cellarCsvCell("+SUM(A1)"), "'+SUM(A1)");
  assert.equal(cellarCsvCell("-2+3"), "'-2+3");
  assert.equal(cellarCsvCell("@cmd"), "'@cmd");
  assert.equal(cellarCsvCell("  =1+1"), "'  =1+1", "前导空白也要挡（Excel 会跳过它）");
});

test("普通文本不受影响", () => {
  assert.equal(cellarCsvCell("蜜香"), "蜜香");
  assert.equal(cellarCsvCell("他说，这饼很甜"), "他说，这饼很甜");
  assert.equal(cellarCsvCell(""), "");
  assert.equal(cellarCsvCell(null), "");
  assert.equal(cellarCsvCell(undefined), "");
});

test("导出的 CSV 里，恶意备注不会变成公式", () => {
  const nasty = '=HYPERLINK("http://x","点我")';
  const csv = cellarExportCsv([
    {
      ...sampleItems[0],
      tastings: [{ ...sampleItems[0].tastings[0], note: nasty }],
    },
  ]);
  // 解析回来看那一格：Excel 会把以 = 开头的文本当公式，
  // 前面加的单引号让它变成纯文本。
  const table = parseCsv(csv);
  const cell = table.rows[0]["品鉴备注"];
  assert.ok(cell.startsWith("'"), `单元格应以单引号开头，实际是 ${cell}`);
  assert.equal(cell.slice(1), nasty, "内容本身不能被改");
});
