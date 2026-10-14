import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import TastingNoteComments from "@/components/tasting-note-comments";
import TastingNoteEditor from "@/components/tasting/tasting-note-editor";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TastingNotePage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();

  // Admin only — non-admins see 404
  if (session?.user?.role !== "admin") notFound();

  const note = await prisma.tastingNote.findUnique({
    where: { id },
    include: {
      tea: true,
      author: { select: { id: true, username: true, avatar: true, level: true } },
      _count: { select: { comments: true } },
    },
  });

  if (!note) notFound();

  const scores = [
    { label: "外形", value: note.appearance },
    { label: "汤色", value: note.color },
    { label: "香气", value: note.aroma },
    { label: "滋味", value: note.taste },
    { label: "余韵", value: note.aftertaste },
  ].filter((s) => s.value !== null);

  const images: string[] = Array.isArray(note.images)
    ? (note.images as unknown[]).filter((i): i is string => typeof i === "string")
    : [];

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      {/* Breadcrumb — P2-R23：去掉「茶品库」入口（对用户绝对隐藏） */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href={`/tea/${note.tea.id}`} className="hover:text-amber-700 transition">{note.tea.name}</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">品鉴笔记</span>
      </nav>

      {/* Editable island: title/author/tea card, body, video and image gallery */}
      <TastingNoteEditor
        note={{
          id: note.id,
          title: note.title,
          content: note.content,
          images,
          videoUrl: note.videoUrl,
          authorName: note.author.username,
          createdAt: note.createdAt.toISOString(),
          tea: {
            id: note.tea.id,
            name: note.tea.name,
            brand: note.tea.brand,
            year: note.tea.year,
            type: note.tea.type,
          },
        }}
      />

      {/* Scores */}
      {scores.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <h2 className="text-sm font-semibold text-stone-600 mb-3">评分</h2>
          <div className="flex flex-wrap gap-3">
            {scores.map((s) => (
              <div key={s.label} className="px-3 py-1.5 bg-stone-50 rounded-lg text-center min-w-[60px]">
                <div className="text-lg font-bold text-amber-800">{s.value}</div>
                <div className="text-[0.625rem] text-stone-400">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Brew info */}
      {(note.brewMethod || note.waterTemp || note.teaWeight || note.steepCount) && (
        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <h2 className="text-sm font-semibold text-stone-600 mb-2">冲泡记录</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
            {note.brewMethod && <span>冲泡: {note.brewMethod}</span>}
            {note.waterTemp && <span>水温: {note.waterTemp}°C</span>}
            {note.teaWeight && <span>投茶: {note.teaWeight}</span>}
            {note.steepCount && <span>耐泡: {note.steepCount}泡</span>}
          </div>
        </div>
      )}

      {/* Comments */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <h2 className="text-sm font-semibold text-stone-600 mb-4">
          评论 ({note._count.comments})
        </h2>
        <TastingNoteComments tastingNoteId={note.id} />
      </div>
    </div>
  );
}
