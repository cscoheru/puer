import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { refId, type, value } = await req.json();
  if (!refId || !["article", "comment"].includes(type) || ![1, -1, 0].includes(value)) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  const userId = session.user.id;

  // Find existing vote
  const existing = await prisma.vote.findUnique({
    where: { userId_refId: { userId, refId } },
  });

  const prevValue = existing?.value || 0;

  // If same value, remove vote (toggle off)
  if (existing && value === prevValue) {
    await prisma.vote.delete({ where: { id: existing.id } });
    await updateCounters(refId, type, prevValue, 0);
    await updateAuthorKarma(refId, type, prevValue, 0);
    return NextResponse.json({ value: 0, removed: true });
  }

  // If different value, upsert vote
  if (existing) {
    await prisma.vote.update({ where: { id: existing.id }, data: { value } });
  } else {
    await prisma.vote.create({ data: { userId, refId, value } });
  }

  await updateCounters(refId, type, prevValue, value);
  await updateAuthorKarma(refId, type, prevValue, value);

  return NextResponse.json({ value, changed: prevValue !== 0 });
}

async function updateCounters(refId: string, type: string, prevValue: number, newValue: number) {
  const upInc = (newValue === 1 ? 1 : 0) - (prevValue === 1 ? 1 : 0);
  const downInc = (newValue === -1 ? 1 : 0) - (prevValue === -1 ? 1 : 0);
  if (upInc === 0 && downInc === 0) return;

  const data = { upvotes: { increment: upInc }, downvotes: { increment: downInc } };
  if (type === "article") {
    await prisma.article.update({ where: { id: refId }, data });
  } else {
    await prisma.comment.update({ where: { id: refId }, data });
  }
}

async function updateAuthorKarma(refId: string, type: string, prevValue: number, newValue: number) {
  const diff = newValue - prevValue; // +2 for upvote, -2 for un-upvote, etc.
  if (diff === 0) return;

  // Single raw SQL: find authorId via subquery and update karma in one round-trip
  const refTable = type === "article" ? "articles" : "comments";
  await prisma.$executeRawUnsafe(
    `UPDATE users SET karma = karma + $1 WHERE id = (SELECT "authorId" FROM ${refTable} WHERE id = $2)`,
    diff,
    refId,
  );
}
