/**
 * 以东和数据为基础播种茶品库 —— 一次性脚本（2026-10-24）。
 *
 * ## 为什么
 *
 * 站长 2026-10-24 指出：东和（https://www.donghetea.com/marketReference）
 * 是业内公认的信息平台，行情一直是价格风向标，对主要茶品都有记录 ——
 * **那是一份相当完整的茶品库**，以此为基础建库才完整。
 *
 * 而现在库里的 1723 款茶，实测**只有 13 款**能在东和数据里对上；
 * 其余 1511 款是从品鉴笔记导入的产物（重名、命名随意、互相重复）。
 *
 * ## 数据来源
 *
 *   `/opt/puer-hub/rag-data/sku-clean.jsonl`（942 条）
 *     —— 从东和的行情表格清洗出来的**普洱**茶品：年份已归一化、形态
 *     （饼/沱/砖/散）、规格、价格俱全。这是茶品库本体。
 *
 *   `/opt/puer-hub/rag-data/donghe-skus.jsonl`（6717 条）
 *     —— 东和的**在售清单**（含铁盒、礼茶这类非普洱），带实时价与图片。
 *     用来给茶品挂行情与封面图。
 *
 * ## 做什么
 *
 *   ① 按「年份 + 归一化名」把清洗数据**对上**现有茶品 → 补齐缺失字段
 *      （品牌、年份、形态、规格、行情、封面图）
 *   ② 对不上的 → **新建**一条茶品（「普通」层的骨架）
 *   ③ 两条清洗数据内部重名的（同名不同规格）→ 只留一条，另一条进
 *      「待整理」
 *
 * ## 不做什么
 *
 * **不合并现有条目、不删除任何东西。** 现有 1723 款茶的去留是站长的决定
 * （`/admin/teas` 的「只看待整理」队列），本脚本只负责**把库的基础换对**。
 *
 * ## 怎么跑
 *
 * ```bash
 * # 干跑（默认，只出报告）
 * docker exec puer-hub-app node scripts/seed-tea-library.ts
 * # 真写
 * docker exec puer-hub-app node scripts/seed-tea-library.ts --apply
 * ```
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/index.js";
import type { Prisma } from "../src/generated/prisma/index.js";
import { normalizeTeaName } from "../src/lib/tea-name-normalize.ts";

const prisma = new PrismaClient();

/**
 * 数据文件位置。
 *
 * 默认值是**宿主机**上的路径 —— 但 app 容器里没有挂载 /opt/puer-hub/rag-data
 * （那是 rag-service 容器在用），所以在容器里跑要指定环境变量指向容器内的副本：
 *
 *   SEED_CLEAN_FILE=/tmp/rag/sku-clean.jsonl \
 *   SEED_SKU_FILE=/tmp/rag/donghe-skus.jsonl \
 *   node scripts/seed-tea-library.ts
 */
const CLEAN_FILE =
  process.env.SEED_CLEAN_FILE ?? "/opt/puer-hub/rag-data/sku-clean.jsonl";
const SKU_FILE =
  process.env.SEED_SKU_FILE ?? "/opt/puer-hub/rag-data/donghe-skus.jsonl";

/**
 * 品牌前缀 —— 按名字里出现的厂牌词切。
 *
 * ⚠️ 这是**推断**，不是数据里现成的字段（清洗数据没有 brand 列）。
 * 切不出来的一律记「未知」，并在报告里列出来给站长过目 ——
 * 宁可让站长看到一堆「未知」，也不要脚本替他们编一个品牌。
 */
const BRAND_PREFIXES = [
  "紫大益", "大益", "白菜孔雀", "孔雀之乡", "下关", "福今", "陈升号", "宝和祥",
  "今大福", "勐库戎氏", "中茶", "同庆号", "同兴号", "陈云号", "圆茶", "鼎丰",
  "同昌号", "同心", "同信", "同庆", "德顺昌", "敬昌", "同兴", "同昌",
  "蓝印", "七子", "贡茶", "宫廷", "金瓜", "印级", "唛级",
];

/**
 * 源表 → 品牌。
 *
 * 很多茶的名字里根本不含厂牌（「401 7592」「博字7572」「红印普饼」都是
 * 大益的唛号），但**它们来自哪张表**说清楚了 —— 清洗数据就是按表整理的，
 * 表名就是厂牌。这是比从名字猜可靠得多的来源。
 */
const SOURCE_BRAND: [RegExp, string][] = [
  [/大益熟茶统计/, "大益"],
  [/大益新茶分析/, "大益"],
  [/白菜孔雀/, "白菜孔雀"],
  // 定制系列是大益的定制线（库里「2008-大益806批次8582」也记成大益）
  [/定制茶系列/, "大益"],
  // 改制前老茶：厂牌多在名字里（百年双狮同庆号…），切不到就记「老茶」
  // （库里现有的改制前老茶也是这个品牌）
  [/改制前老茶/, "老茶"],
];

/** 从名字 + 源表切品牌。切不出来返回 null（报告里会列出来）。 */
function deriveBrand(name: string, sourceFile: string): string | null {
  for (const b of BRAND_PREFIXES) {
    if (name.startsWith(b)) return b;
  }
  // 「百年陈云号…」「百年双狮同庆号…」这类：品牌在名字中段
  for (const b of BRAND_PREFIXES) {
    if (name.includes(b)) return b;
  }
  for (const [re, brand] of SOURCE_BRAND) {
    if (re.test(sourceFile)) return brand;
  }
  return null;
}

/**
 * 行情价：按可信度取第一个有的价格字段，并标明它是哪一种价。
 *
 * 清洗数据的价分散在好几个字段里（市场价 341 条、估价 474 条、
 * 回购价 138 条、每克价 941 条…），只取 `market_price_per_jian`
 * 会漏掉三分之二。
 */
const PRICE_FIELDS: [keyof CleanRow, string][] = [
  ["market_price_per_jian", "市场"],
  ["market_price", "市场"],
  ["estimate", "估价"],
  ["buyback_price", "回购"],
  ["alloc_price", "配货"],
  ["market_high", "市场"],
];

/**
 * 行情价的展示串。
 *
 * 库里现有的行情是这种写法（「1.8万～3.5万（结合品相和仓储）」），
 * UI 直接把它打出来，所以这里也要是给人看的样子。
 * 清洗数据的价是**每件**（market_price_per_jian）。
 */
function formatPrice(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "";
  if (v >= 10000) {
    const w = v / 10000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)}万/件`;
  }
  return `${v}/件`;
}

/** 行情快照（给 teas.marketInfo）。没有价就返回 null。 */
function mkMarketInfo(row: CleanRow): Prisma.InputJsonValue | undefined {
  const p = pickPrice(row);
  if (!p) return undefined;
  return {
    price: p.price,
    source: p.source,
    ...(row.snapshot_date ? { updatedAt: row.snapshot_date } : {}),
  };
}

/**
 * 取一条清洗数据能给的最好行情。
 *
 * @returns 展示串与来源说明；没有价就返回 null
 */
function pickPrice(row: CleanRow): { price: string; source: string } | null {
  for (const [field, kind] of PRICE_FIELDS) {
    const v = row[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const price = formatPrice(v);
    if (!price) continue;
    return {
      price,
      source: kind === "市场" ? "东和茶库" : `东和茶库（${kind}）`,
    };
  }
  // 兜底：每克价（941 条有，最全），但单位是克 —— 标清楚。
  const perG = row.price_per_g;
  if (typeof perG === "number" && Number.isFinite(perG) && perG > 0) {
    return { price: `${perG}元/克`, source: "东和茶库（每克）" };
  }
  return null;
}

/**
 * 通用词 —— 比对时要剔除，它们不携带产品身份。
 *
 * 「普洱」「生茶」「熟茶」「饼」「沱」这些在每个名字里都可能出现；
 * 留着它们会让「2003 生茶」跟「2004 熟茶」看起来很像。
 *
 * ⚠️ **大益 / 中茶不在这个表里** —— 它们是**产品线**，去掉之后
 * 「紫大益7572」会变成「紫」、「黄印7572」变成「黄印」，
 * 两款完全不同的茶反而被判成同款。
 */
const GENERIC_WORDS = [
  "普洱", "生茶", "熟茶", "产品", "定制", "系列", "高级", "精品", "特级",
  "印级", "唛级", "批次", "年", "饼", "沱", "砖", "散", "贡", "生", "熟",
  "茶", "号",
];

/**
 * 名字的「核心」—— 去掉数字（年份/唛号/批号/克重）、通用词与标点后剩下的。
 *
 * 这是「异名同款」比对的依据：真正的产品身份在剩下的字里
 * （「飞台咖啡大大益」与「咖啡大大益」、「中茶黄印」与「黄印」）。
 */
function coreOf(name: string): string {
  let s = name.normalize("NFKC").toLowerCase();
  s = s.replace(/\d+/g, "");
  for (const w of GENERIC_WORDS) s = s.split(w).join("");
  // 计量单位也要剔除 —— 「357克」留下个「克」字，会造出「大益克」这种
  // 两字核心，然后任何含「大益」的名字都被判成它的同款。
  for (const w of ["公斤", "克", "提", "件", "片", "篓", "筒", "罐", "条", "盒", "g"]) {
    s = s.split(w).join("");
  }
  return s.replace(/[\s\-_（）()\[\]【】「」,，.。:：·、/]/g, "");
}

/**
 * 名字里的**唛号**（4 位数字，去掉年份本身）。
 *
 * ⚠️ 必须先去掉年份：「2002年201批次春尖茶青饼」里的 4 位数字是年份
 * 2002，不是唛号。混进去的话，每条名字带年份的清洗数据都会「撞上」
 * 同年的经典茶 —— 干跑里凭空冒出 160 条假撞车就是这个。
 */
function maoTokens(name: string, year: number): string[] {
  return (name.normalize("NFKC").match(/\d{4}/g) ?? []).filter(
    (g) => Number(g) !== year,
  );
}

/**
 * 名字开头的**批次号**（三位数）。
 *
 * 批次是产品身份的一部分：「204紫大益7572」与「208紫大益7572」是同一
 * 产品线的**不同批次**，价格不同，不该合并。而去掉数字后两者的核心
 * 完全一样（都是「紫大益」），所以要比对批次。
 */
function batchOf(name: string): string | null {
  const m = name.normalize("NFKC").match(/^(\d{3})(?!\d)/);
  return m ? m[1] : null;
}

/** 字符二元组集合。 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 包含度：短的那个有多大比例被长的那个包含。
 *
 * 用包含度而不是相似度，是因为**同款的名字往往长短不一**
 * （「301咖啡大大益7592」vs「2003-飞台咖啡大大益7592」—— 短的那个
 * 完全被长的那个包含，包含度 1.0）。
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** 「异名同款」的判定阈值。 */
const SAME_PRODUCT_THRESHOLD = 0.8;

/**
 * 核心词至少要这么长才参与匹配。
 *
 * ⚠️ 没有这条会大面积误判：库里不少茶品的名字去掉通用词后**只剩品牌**
 * （「2004-大益普洱熟沱」→ 核心「大益」两字），而「大益」这个二元组
 * 在几乎每条大益的茶里都出现 —— 于是「紫大益一片叶7572」会被判成
 * 「大益普洱熟沱」的同款。核心不足 3 个字，认不出产品身份。
 */
const MIN_CORE_CHARS = 3;

/** 生熟：名字里的「熟/生」优先，其次清洗数据的 raw_or_ripe 字段。 */
function deriveType(name: string, rawOrRipe: string): "raw" | "ripe" {
  if (/熟/.test(name) || /熟/.test(rawOrRipe)) return "ripe";
  return "raw";
}

/**
 * 茶品的**匹配键**：`年份 + 去掉年份后的归一化名`。
 *
 * ⚠️ 关键：库里的茶品名**自带年份**（「2003·班章乔木生态沱」「03年班章孔雀
 * 沱」「2002-班章精品白菜」三种写法都有），清洗数据则是「年份」与「名字」
 * 分开两列。匹配时必须先把名字里的年份**摘掉**再比 —— 否则会把
 * 「2003·班章乔木生态沱」算成「2003-2003班章乔木生态沱」，永远对不上。
 */
function teaKey(year: number, rawName: string): string {
  let n = rawName.trim();
  let m = n.match(/^((?:19|20)\d{2})\s*[·\-年._]?\s*(.*)$/);
  if (m && Number(m[1]) === year) {
    n = m[2];
  } else {
    // 两位年份：「03年班章孔雀沱」
    m = n.match(/^(\d{2})年\s*(.*)$/);
    if (m && 2000 + Number(m[1]) === year) n = m[2];
  }
  return `${year}-${normalizeTeaName(n)}`;
}

/** 茶品的规范名：年份 + 名字（与库里现有的命名习惯一致：「2002-班章精品白菜」）。 */
function canonicalName(year: number, rawName: string): string {
  const name = rawName.trim();
  if (teaKey(year, name) === `${year}-${normalizeTeaName(name)}`) {
    // 名字里没有年份 —— 加前缀
    return `${year}-${name}`;
  }
  return name;
}

interface CleanRow {
  name: string;
  year: number;
  form: string;
  raw_or_ripe: string;
  spec_g: number | null;
  market_price_per_jian: number | null;
  market_price: number | null;
  estimate: number | null;
  buyback_price: number | null;
  alloc_price: number | null;
  market_high: number | null;
  price_per_g: number | null;
  has_price: boolean;
  snapshot_date: string | null;
  source_file: string;
}

interface SkuRow {
  skuId: string;
  name: string;
  img: string;
  price: number;
  lastPrice: number;
  changeRatio: number;
  unit: string;
  year: string;
  priceUpdatedAt: string;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const clean: CleanRow[] = readFileSync(CLEAN_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const skus: SkuRow[] = readFileSync(SKU_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // SKU 按归一化名索引：给茶品挂行情与封面图
  const skuByName = new Map<string, SkuRow[]>();
  for (const s of skus) {
    const k = normalizeTeaName(s.name);
    if (!k) continue;
    const list = skuByName.get(k) ?? [];
    list.push(s);
    skuByName.set(k, list);
  }

  // 现有茶品：按「年份+归一化名」索引
  const existing = await prisma.tea.findMany({
    where: { deletedAt: null },
    select: {
      id: true, name: true, brand: true, year: true, type: true,
      isClassic: true, needsReview: true,
      coverImage: true, marketInfo: true, weightSpec: true, originRegion: true,
      aliases: true,
      _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
    },
  });
  const existingByKey = new Map<string, (typeof existing)[number]>();
  // 二元组倒排索引：按「年份 + 二元组」找候选，再算包含度
  const byYear = new Map<number, { t: (typeof existing)[number]; bg: Set<string> }[]>();
  for (const t of existing) {
    const k = teaKey(t.year, t.name);
    if (!existingByKey.has(k)) existingByKey.set(k, t);
    const core = coreOf(t.name);
    if (core.length < MIN_CORE_CHARS) continue;
    const bg = bigrams(core);
    if (bg.size === 0) continue;
    const list = byYear.get(t.year) ?? [];
    list.push({ t, bg });
    byYear.set(t.year, list);
  }
  // 经典茶的唛号索引：「经典普洱」是站长亲自选的，不能被脚本改动，
  // 也不能被脚本新建的同名同款条目**再抄一份**到公开目录里。
  const classicTokens = new Map<string, (typeof existing)[number][]>();
  for (const t of existing) {
    if (!t.isClassic) continue;
    for (const g of maoTokens(t.name, t.year)) {
      const key = `${t.year}-${g}`;
      const list = classicTokens.get(key) ?? [];
      list.push(t);
      classicTokens.set(key, list);
    }
  }

  // 倒排：二元组 → 该年份的候选下标
  const inverted = new Map<number, Map<string, number[]>>();
  for (const [year, list] of byYear) {
    const idx = new Map<string, number[]>();
    list.forEach((e, i) => {
      for (const g of e.bg) {
        const arr = idx.get(g) ?? [];
        arr.push(i);
        idx.set(g, arr);
      }
    });
    inverted.set(year, idx);
  }

  /**
   * 找「异名同款」的现有茶品。
   *
   * 站长 2026-10-24 提的：「名称描述不同、实际是同一款茶」。
   * 光比归一化名认不出这种（「301咖啡大大益7592」与「2003-飞台咖啡大大益
   * 7592」归一化后差得远），所以这里用**字符二元组包含度**来认：
   * 同年 + 短的那个有 ≥80% 的二元组被长的那个包含。
   */
  function findSameProduct(
    year: number,
    name: string,
  ): (typeof existing)[number] | null {
    const core = coreOf(name);
    if (core.length < MIN_CORE_CHARS) return null;
    const myBatch = batchOf(name);
    const bg = bigrams(core);
    if (bg.size === 0) return null;
    const list = byYear.get(year);
    const idx = inverted.get(year);
    if (!list || !idx) return null;
    const cand = new Set<number>();
    for (const g of bg) {
      for (const i of idx.get(g) ?? []) cand.add(i);
    }
    let best: (typeof existing)[number] | null = null;
    let bestScore = 0;
    for (const i of cand) {
      const score = containment(bg, list[i].bg);
      if (score <= bestScore) continue;
      // 批次冲突 → 不是同一款（同产品线的不同批次，价格不同）
      const theirBatch = batchOf(list[i].t.name);
      if (myBatch && theirBatch && myBatch !== theirBatch) continue;
      bestScore = score;
      best = list[i].t;
    }
    return bestScore >= SAME_PRODUCT_THRESHOLD ? best : null;
  }

  // 清洗数据内部也有重名（同名不同规格）→ 只留第一条，其余算重复
  const seen = new Set<string>();
  const rows: {
    row: CleanRow;
    key: string;
    name: string;
    brand: string | null;
    type: "raw" | "ripe";
    sku: SkuRow | null;
    dup: boolean;
    /** 判定为同一款的现有茶品（异名同款）。 */
    same: (typeof existing)[number] | null;
    /** 与某个经典茶品同年同唛号 —— 不新建，进待整理队列。 */
    classicClash: boolean;
  }[] = [];

  for (const row of clean) {
    if (!row.name || !row.year) continue;
    const name = canonicalName(row.year, row.name);
    const key = teaKey(row.year, row.name);
    const dup = seen.has(key);
    seen.add(key);
    const same = dup ? null : (existingByKey.get(key) ?? findSameProduct(row.year, row.name));
    // 与某个经典茶品同年同唛号 → 可能是经典那款的另一个写法/批次。
    // 这种**不直接建成公开条目**（那会在公开目录里多出一条经典），
    // 而是进待整理队列，由站长并入经典。
    const classicClash =
      !same && !dup
        ? maoTokens(row.name, row.year).some((g) =>
            classicTokens.has(`${row.year}-${g}`),
          )
        : false;
    rows.push({
      row,
      key,
      name,
      brand: deriveBrand(row.name, row.source_file),
      type: deriveType(row.name, row.raw_or_ripe),
      sku: skuByName.get(normalizeTeaName(row.name))?.[0] ?? null,
      dup,
      same,
      classicClash,
    });
  }

  // 判为「异名同款」的 → 补到现有那一条上（并把东和的名字记成别名），
  // **不新建** —— 新建就会出现同一款茶两条记录，正是要避免的。
  const toCreate = rows.filter((r) => !r.dup && !r.same && !r.classicClash);
  const toEnrich = rows.filter((r) => !r.dup && r.same);
  const toQueue = rows.filter((r) => !r.dup && !r.same && r.classicClash);
  const noBrand = rows.filter((r) => !r.brand);
  const withSku = rows.filter((r) => r.sku);

  console.log(`=== ${apply ? "实跑" : "干跑"} ===`);
  console.log(`清洗数据：${clean.length} 条（去重后 ${seen.size} 条，其中内部重名 ${rows.filter((r) => r.dup).length} 条）`);
  console.log(`现有茶品：${existing.length} 款`);
  const byName = toEnrich.filter((r) => r.same && r.same.name === r.name);
  const byProduct = toEnrich.filter((r) => r.same && r.same.name !== r.name);
  console.log(`→ 对上现有的（补齐字段）：${toEnrich.length} 条`);
  console.log(`     其中 同名：${byName.length} 条`);
  console.log(`     其中 异名同款（按二元组包含度认出）：${byProduct.length} 条`);
  console.log(`→ 新建（普通层的骨架）：${toCreate.length} 条`);
  console.log(
    `→ 与经典茶品同年同唛号（不新建，进待整理队列等站长并入）：${toQueue.length} 条`,
  );
  console.log(`→ 能挂上东和行情与封面图：${withSku.length} 条`);
  console.log(`→ 品牌切不出来（需人工过目）：${noBrand.length} 条`);

  if (byProduct.length > 0) {
    console.log("\n--- 异名同款（前 25 条）—— 这些不新建，只补到现有那一条上 ---");
    for (const r of byProduct.slice(0, 25)) {
      console.log(
        `   清洗「${r.row.name}」(${r.row.year}) ≈ 现有「${r.same!.name}」` +
          (r.same!.brand ? `（${r.same!.brand}）` : ""),
      );
    }
  }

  if (toQueue.length > 0) {
    console.log("\n--- 与经典撞唛号的（前 15 条）—— 这些不建为公开条目 ---");
    for (const r of toQueue.slice(0, 15)) console.log(`   ${r.name}（${r.row.year}）`);
  }

  if (noBrand.length > 0) {
    console.log("\n--- 品牌切不出来的（前 30 条）---");
    for (const r of noBrand.slice(0, 30)) console.log(`   ${r.name}`);
  }

  if (!apply) {
    console.log("\n--- 将要新建的（前 20 条）---");
    for (const r of toCreate.slice(0, 20)) {
      console.log(
        `   ${r.name}  [${r.brand ?? "未知"} ${r.type} ${r.row.form}]` +
          (r.row.market_price_per_jian ? ` 价 ${r.row.market_price_per_jian}` : "") +
          (r.sku ? "  ✓有东和行情" : ""),
      );
    }
    console.log("\n（干跑：没有写库。加 --apply 才真的改。）");
    return;
  }

  // ── 写库 ──
  const admin = await prisma.user.findFirst({
    where: { role: "admin" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) {
    console.error("找不到 admin 用户，无法创建茶品。");
    process.exitCode = 1;
    return;
  }

  let created = 0;
  for (const r of toCreate) {
    await prisma.tea.create({
      data: {
        name: r.name.slice(0, 200),
        brand: (r.brand ?? "未知").slice(0, 100),
        year: r.row.year,
        type: r.type,
        weightSpec: r.row.spec_g ? `${r.row.spec_g}g` : null,
        coverImage: r.sku?.img ?? null,
        marketInfo: mkMarketInfo(r.row),
        aliases: [r.row.name.slice(0, 200)],
        createdBy: admin.id,
        // 东和数据是权威参照 → 直接进「普通」层。
        // 例外：与经典茶品同年同唛号的（可能抄了经典那款）→ 进待整理，
        // 由站长并入经典，不在公开目录里多出一条。
        needsReview: r.classicClash,
      },
    });
    created++;
  }
  console.log(`\n新建 ${created} 款。`);

  // 补齐现有茶品缺失的字段（只补空着的，不覆盖已有的）
  let enriched = 0;
  for (const r of toEnrich) {
    // ⚠️ 用 r.same（匹配时认出来的那条），**不能**用 existingByKey.get(r.key)：
    // 异名同款的匹配来自 findSameProduct，它不在 key 索引里。
    const t = r.same!;
    const data: Record<string, unknown> = {};
    if (!t.brand || t.brand === "未知") {
      if (r.brand) data.brand = r.brand.slice(0, 100);
    }
    if (!t.weightSpec && r.row.spec_g) data.weightSpec = `${r.row.spec_g}g`;
    if (!t.coverImage && r.sku?.img) data.coverImage = r.sku.img;
    if (!t.marketInfo) {
      const mi = mkMarketInfo(r.row);
      if (mi) data.marketInfo = mi;
    }
    // 对上了东和的数据 = 这条茶有权威参照了 → 清掉「待整理」标记，
    // 它不该再留在站长的整理队列里。
    if (t.needsReview) data.needsReview = false;
    // 把东和那边的名字也记成别名 —— 「301咖啡大大益7592」与
    // 「2003-飞台咖啡大大益7592」是同一款茶，两个名字都得能搜到它。
    if (r.row.name !== t.name && !(t.aliases ?? []).includes(r.row.name)) {
      data.aliases = { push: [r.row.name.slice(0, 200)] };
    }
    if (Object.keys(data).length === 0) continue;
    await prisma.tea.update({ where: { id: t.id }, data });
    enriched++;
  }
  console.log(`补齐 ${enriched} 款现有茶品的字段。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
