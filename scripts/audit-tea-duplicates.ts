/**
 * 茶品重复筛查 —— 一次性脚本（2026-10-24）。
 *
 * ## 为什么需要
 *
 * 茶品库里同一款茶被反复导入成好几条：站长报的是「国饮-2015班章大树」
 * 「普洱自在饮：2019-01茶友盲品」「国饮-2015」这几个搜出来是一回事。
 * 根因在导入侧：去重以「年份 + 批次」为门槛，**年份解析不出来就完全
 * 不去重**（`scripts/import_tasting_notes.py` 的 `find_exact_match`）。
 *
 * ## 做什么
 *
 *   ① **重复组**（完全同名，或归一化后同名）→ 保留**引用最多**的那条，
 *      其余标成「待整理」（`needsReview = true`）
 *   ② **没有任何引用**、又不是经典的 → 标成「待整理」
 *   ③ **经典款不动** —— 经典是站长亲自选出来的，不是脚本能碰的
 *
 * ## 不做什么
 *
 * **不自动合并。** 合并要站长决定：哪条当主体、别名怎么留、笔记归到谁。
 * 本脚本只做「排队」—— 把该看的挑出来（`/admin/teas` 的「只看待整理」），
 * 剩下的交给站长。
 *
 * ## 怎么跑
 *
 * ```bash
 * # 干跑（默认，只出报告，不写库）
 * docker exec puer-hub-app node scripts/audit-tea-duplicates.ts
 *
 * # 真写
 * docker exec puer-hub-app node scripts/audit-tea-duplicates.ts --apply
 * ```
 *
 * 干跑**先跑** —— 上次词库播种就是干跑与实跑的分类差了几行，
 * 先看报告再落库。
 */
import { PrismaClient } from "../src/generated/prisma/index.js";
import { normalizeTeaName } from "../src/lib/tea-name-normalize.ts";

const prisma = new PrismaClient();

interface TeaRow {
  id: string;
  name: string;
  brand: string;
  year: number;
  isClassic: boolean;
  needsReview: boolean;
  refs: number;
}

/** 一条茶品被引用了多少次（品鉴笔记 + 帖子 + 茶仓条目）。 */
function refCount(t: {
  _count: { tastingNotes: number; articles: number; cellarItems: number };
}): number {
  return t._count.tastingNotes + t._count.articles + t._count.cellarItems;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.tea.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      brand: true,
      year: true,
      isClassic: true,
      needsReview: true,
      _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
    },
  });

  const teas: TeaRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    brand: t.brand,
    year: t.year,
    isClassic: t.isClassic,
    needsReview: t.needsReview,
    refs: refCount(t),
  }));

  // ── ① 重复组：按归一化名分组 ──
  // 归一化相同 ⇒ 完全同名也相同（归一化是幂等的），所以一组就够。
  const groups = new Map<string, TeaRow[]>();
  for (const t of teas) {
    const key = normalizeTeaName(t.name);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
  const dupIds = new Set<string>();
  for (const [, list] of dupGroups) {
    // 主体：经典优先，其次引用多的。引用一样多时取 id 小的（稳定，可复跑）。
    const sorted = [...list].sort(
      (a, b) =>
        Number(b.isClassic) - Number(a.isClassic) ||
        b.refs - a.refs ||
        a.id.localeCompare(b.id),
    );
    const keeper = sorted[0];
    for (const t of sorted.slice(1)) {
      if (t.isClassic) continue; // 经典永远保留
      if (t.needsReview) continue; // 已经是待整理，不重复处理
      dupIds.add(t.id);
    }
    void keeper;
  }

  // ── ② 无引用的空壳（非经典）──
  const shells = teas.filter(
    (t) => !t.isClassic && t.refs === 0 && !t.needsReview && !dupIds.has(t.id),
  );

  const targets = [
    ...teas.filter((t) => dupIds.has(t.id)),
    ...shells,
  ];

  console.log(`=== ${apply ? "实跑" : "干跑"} ===`);
  console.log(`茶品总数：${teas.length}（经典 ${teas.filter((t) => t.isClassic).length}）`);
  console.log(`重复组：${dupGroups.length} 组，涉及 ${dupGroups.reduce((n, [, l]) => n + l.length, 0)} 款`);
  console.log(`  → 其中将被标为「待整理」：${dupIds.size} 款`);
  console.log(`无引用空壳（非经典）：${shells.length} 款`);
  console.log(`合计将标为「待整理」：${targets.length} 款`);
  // 被标为待整理的那些身上有没有内容？—— 有的话，站长在「只看待整理」
  // 里合并它们时，内容会转到主体（merge-batch 会转移笔记/帖子/茶仓条目）。
  const markedRefs = targets.reduce(
    (n, t) => n + t.refs,
    0,
  );
  const markedWithContent = targets.filter((t) => t.refs > 0).length;
  console.log(
    `  → 身上有内容的：${markedWithContent} 款（共 ${markedRefs} 篇引用）` +
      `—— 合并时会转到主体`,
  );
  console.log(`已经是「待整理」（不动）：${teas.filter((t) => t.needsReview).length} 款`);

  if (dupGroups.length > 0) {
    console.log("\n--- 重复组明细（前 20 组）---");
    for (const [key, list] of dupGroups.slice(0, 20)) {
      const sorted = [...list].sort(
        (a, b) => Number(b.isClassic) - Number(a.isClassic) || b.refs - a.refs,
      );
      console.log(`「${key}」× ${list.length}`);
      for (const t of sorted) {
        const mark = t.isClassic
          ? "经典"
          : dupIds.has(t.id)
            ? "→ 待整理"
            : "保留";
        console.log(`   ${mark}  ${t.brand} ${t.year} ${t.name}（引用 ${t.refs}）`);
      }
    }
  }

  if (!apply) {
    console.log("\n（干跑：没有写库。加 --apply 才真的改。）");
    return;
  }

  if (targets.length === 0) {
    console.log("\n没有需要处理的茶品。");
    return;
  }

  // 分批更新：一次几千条 UPDATE 会让事务很大、锁很久。
  const BATCH = 200;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await prisma.tea.updateMany({
      where: { id: { in: batch.map((t) => t.id) } },
      data: { needsReview: true },
    });
    process.stdout.write(`\r已标记 ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }
  console.log(`\n完成：${targets.length} 款已标为「待整理」。`);
  console.log("去 /admin/teas → 「只看待整理」处理它们。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
