import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseEnex } from "@/lib/enex-parser";
import { can } from "@/lib/permissions";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可导入" }, { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const importType = (formData.get("type") as string) || "tasting"; // tasting | article | discussion

  if (!file) {
    return NextResponse.json({ error: "请上传 ENEX 文件" }, { status: 400 });
  }

  if (!file.name.endsWith(".enex")) {
    return NextResponse.json({ error: "仅支持 .enex 格式" }, { status: 400 });
  }

  const enexContent = await file.text();

  let parseResult;
  try {
    parseResult = await parseEnex(enexContent);
  } catch (err) {
    return NextResponse.json(
      { error: `ENEX 解析失败: ${err instanceof Error ? err.message : "未知错误"}` },
      { status: 400 }
    );
  }

  const { notes, errors } = parseResult;

  // Batch create articles as drafts
  const created = await prisma.$transaction(
    notes.map((note) =>
      prisma.article.create({
        data: {
          type: importType,
          title: note.title,
          content: note.content,
          summary: note.content.substring(0, 200).replace(/<[^>]+>/g, "") + "...",
          tags: note.tags,
          status: "draft",
          authorId: session.user.id,
          // F0 来源标注：ENEX 导入的是站长自己的笔记（人写的）→ human。
          origin: "human",
        },
      })
    )
  );

  return NextResponse.json({
    imported: created.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 10),
    ids: created.map((a: any) => a.id),
  });
}
