import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { cleanTeaName } from "@/lib/tea-name-clean";
import { groupSameNameTeas, mergeTeaPair } from "@/lib/tea-merge";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/teas/merge-same-name —— 合并**名称完全一样**的茶品。
 *
 * 站长 2026-10-25：「对于茶品名称完全一样的，请在系统中直接进行合并，
 * 不需要手动操作。」
 *
 * 两种用法：
 *   - `{ idA, idB }` —— 合并指定的两条（方向由服务器定）；
 *   - `{ all: true }` —— **批量**：把所有「名称 + 年份 + 品牌」全同的组
 *     一次并完（`dryRun: true` 只出报告不写库）。
 *
 * ## 方向由**服务器**决定
 *
 * 「笔记多的是主体」这条规则写在 `src/lib/tea-merge.ts` 里，不在界面上 ——
 * 界面上点错了方向，就会把内容多的一方删掉（笔记会跟着级联删）。
 *
 * ## 为什么「同名」还要加上年份与品牌
 *
 * 只比名称会出事：生产库里有一组三条都叫「我所了解的大益茶」，年份是
 * 0 / 2000 / 2000，品牌也不同 —— 那不是同一款茶。名字里那些来源前缀
 * （「（资料）」「【天天论普】」）剥掉之后再比 ✅。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;

  // ── 批量：把所有同名同年份同品牌的组一次并完 ──────────────────────────
  if (body?.all === true) {
    const teas = await prisma.tea.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, year: true, brand: true },
    });
    const groups = groupSameNameTeas(teas, cleanTeaName);

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        groups: groups.length,
        redundant: groups.reduce((n, g) => n + g.ids.length - 1, 0),
        sample: groups.slice(0, 20).map((g) => ({
          name: g.name,
          year: g.year,
          brand: g.brand,
          count: g.ids.length,
        })),
      });
    }

    const results = [];
    const errors = [];
    for (const g of groups) {
      // 一组里只留一条：反复把「剩下的」并进第一条即可（方向仍由服务器定）。
      let anchor = g.ids[0];
      for (const id of g.ids.slice(1)) {
        try {
          const r = await mergeTeaPair(anchor, id);
          results.push(r);
          anchor = r.keepId;
        } catch (e) {
          errors.push({
            id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    return NextResponse.json({
      ok: true,
      groups: groups.length,
      merged: results.length,
      errors,
      results: results.slice(0, 50),
    });
  }

  // ── 单对 ─────────────────────────────────────────────────────────────
  const { idA, idB } = body ?? {};
  if (!idA || !idB || idA === idB) {
    return NextResponse.json(
      { error: "缺少参数（idA + idB，且两者不能相同）" },
      { status: 400 },
    );
  }

  const [a, b] = await Promise.all([
    prisma.tea.findUnique({
      where: { id: idA },
      select: { id: true, name: true, year: true, brand: true },
    }),
    prisma.tea.findUnique({
      where: { id: idB },
      select: { id: true, name: true, year: true, brand: true },
    }),
  ]);
  if (!a || !b) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  if (
    cleanTeaName(a.name) !== cleanTeaName(b.name) ||
    a.year !== b.year ||
    a.brand !== b.brand
  ) {
    return NextResponse.json(
      {
        error:
          "这两条不是同一款茶（名称/年份/品牌至少有一项不同）—— 请用「批量合并」或自己指定保留哪条",
      },
      { status: 400 },
    );
  }

  const result = await mergeTeaPair(idA, idB);
  return NextResponse.json({ success: true, ...result });
}
