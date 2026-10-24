import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { cleanTeaName } from "@/lib/tea-name-clean";
import { recomputeTeaStats } from "@/lib/tea-stats";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/teas/merge-same-name —— **同名**的两款茶直接合并。
 *
 * 站长 2026-10-24：「如果茶品名称完全一样的，直接进行合并即可，合并方向为
 * 将品鉴笔记少的合并到笔记多的茶品中」。
 *
 * ## 方向由**服务器**决定
 *
 * 「笔记多的是主体」这条规则写在这里，不在界面上 —— 界面上点错了方向，
 * 就会把内容多的一方删掉（笔记会跟着级联删）。客户端只负责说「这两条
 * 合并」，哪条留下由服务器算。
 *
 * ## 只处理「去掉来源前缀后同名」的两条
 *
 * 「（资料）2004年班章青饼」与「2004年班章青饼」是同一条；名字不一样的
 * 两款茶走 `/api/admin/teas/merge-batch`（那是站长自己挑主体）。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { idA, idB } = await req.json();
  if (!idA || !idB || idA === idB) {
    return NextResponse.json(
      { error: "缺少参数（idA + idB，且两者不能相同）" },
      { status: 400 },
    );
  }

  const [a, b] = await Promise.all([
    prisma.tea.findUnique({
      where: { id: idA },
      select: {
        id: true,
        name: true,
        isClassic: true,
        _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
      },
    }),
    prisma.tea.findUnique({
      where: { id: idB },
      select: {
        id: true,
        name: true,
        isClassic: true,
        _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
      },
    }),
  ]);
  if (!a || !b) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  if (cleanTeaName(a.name) !== cleanTeaName(b.name)) {
    return NextResponse.json(
      { error: "这两款的名称不一样，请用「批量合并」自己指定保留哪条" },
      { status: 400 },
    );
  }

  const refsOf = (t: typeof a) =>
    t!._count.tastingNotes + t!._count.articles + t!._count.cellarItems;

  // 经典款优先当主体（经典是站长亲自选的，不能被合并掉）
  let keep = a!;
  let drop = b!;
  if (b!.isClassic && !a!.isClassic) {
    keep = b!;
    drop = a!;
  } else if (refsOf(b!) > refsOf(a!)) {
    keep = b!;
    drop = a!;
  }

  // 主体别名里补上被合并方的名字
  const existingAliases = new Set<string>();
  const keepRow = await prisma.tea.findUnique({
    where: { id: keep.id },
    select: { aliases: true },
  });
  for (const al of keepRow?.aliases ?? []) existingAliases.add(al);
  const newAliases = [drop.name, ...(keepRow?.aliases ?? [])].filter(
    (n) => !existingAliases.has(n),
  );

  await prisma.$transaction([
    prisma.tastingNote.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.article.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.cellarItem.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.tea.update({
      where: { id: keep.id },
      data:
        newAliases.length > 0 ? { aliases: { push: newAliases } } : {},
    }),
    prisma.tea.delete({ where: { id: drop.id } }),
  ]);

  await recomputeTeaStats(keep.id);

  return NextResponse.json({
    success: true,
    keepId: keep.id,
    keepName: keep.name,
    removedId: drop.id,
    removedName: drop.name,
  });
}
