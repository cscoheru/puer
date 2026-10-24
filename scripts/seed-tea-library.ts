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
  has_price: boolean;
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
      _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
    },
  });
  const existingByKey = new Map<string, (typeof existing)[number]>();
  for (const t of existing) {
    const k = teaKey(t.year, t.name);
    if (!existingByKey.has(k)) existingByKey.set(k, t);
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
  }[] = [];

  for (const row of clean) {
    if (!row.name || !row.year) continue;
    const name = canonicalName(row.year, row.name);
    const key = teaKey(row.year, row.name);
    const dup = seen.has(key);
    seen.add(key);
    rows.push({
      row,
      key,
      name,
      brand: deriveBrand(row.name, row.source_file),
      type: deriveType(row.name, row.raw_or_ripe),
      sku: skuByName.get(normalizeTeaName(row.name))?.[0] ?? null,
      dup,
    });
  }

  const toCreate = rows.filter((r) => !r.dup && !existingByKey.has(r.key));
  const toEnrich = rows.filter((r) => !r.dup && existingByKey.has(r.key));
  const noBrand = rows.filter((r) => !r.brand);
  const withSku = rows.filter((r) => r.sku);

  console.log(`=== ${apply ? "实跑" : "干跑"} ===`);
  console.log(`清洗数据：${clean.length} 条（去重后 ${seen.size} 条，其中内部重名 ${rows.filter((r) => r.dup).length} 条）`);
  console.log(`现有茶品：${existing.length} 款`);
  console.log(`→ 对上现有的（补齐字段）：${toEnrich.length} 条`);
  console.log(`→ 新建（普通层的骨架）：${toCreate.length} 条`);
  console.log(`→ 能挂上东和行情与封面图：${withSku.length} 条`);
  console.log(`→ 品牌切不出来（需人工过目）：${noBrand.length} 条`);

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
        marketInfo: r.row.market_price_per_jian
          ? {
              price: r.row.market_price_per_jian,
              unit: r.row.form || "件",
              updatedAt: null,
              source: "donghe-sku-clean",
            }
          : undefined,
        aliases: [r.row.name.slice(0, 200)],
        createdBy: admin.id,
        // 东和数据是权威参照 → 直接进「普通」层，不进待整理
        needsReview: false,
      },
    });
    created++;
  }
  console.log(`\n新建 ${created} 款。`);

  // 补齐现有茶品缺失的字段（只补空着的，不覆盖已有的）
  let enriched = 0;
  for (const r of toEnrich) {
    const t = existingByKey.get(r.key)!;
    const data: Record<string, unknown> = {};
    if (!t.brand || t.brand === "未知") {
      if (r.brand) data.brand = r.brand.slice(0, 100);
    }
    if (!t.weightSpec && r.row.spec_g) data.weightSpec = `${r.row.spec_g}g`;
    if (!t.coverImage && r.sku?.img) data.coverImage = r.sku.img;
    if (!t.marketInfo && r.row.market_price_per_jian) {
      data.marketInfo = {
        price: r.row.market_price_per_jian,
        unit: r.row.form || "件",
        source: "donghe-sku-clean",
      };
    }
    // 对上了东和的数据 = 这条茶有权威参照了 → 清掉「待整理」标记，
    // 它不该再留在站长的整理队列里。
    if (t.needsReview) data.needsReview = false;
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
