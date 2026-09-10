import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import ForumContent from "@/components/forum-content";
import VideoPlayer from "@/components/video-player";
import TastingNoteComments from "@/components/tasting-note-comments";

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
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href="/tea" className="hover:text-amber-700 transition">茶品库</Link>
        <span className="mx-2">/</span>
        <Link href={`/tea/${note.tea.id}`} className="hover:text-amber-700 transition">{note.tea.name}</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">品鉴笔记</span>
      </nav>

      {/* Header */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
        <h1 className="text-xl md:text-3xl font-serif font-bold text-stone-800">{note.title}</h1>

        {/* Author & Date */}
        <div className="flex items-center gap-3 mt-3 text-sm text-stone-500">
          <span>{note.author.username}</span>
          <span>·</span>
          <span>{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span>
        </div>

        {/* Tea info card */}
        <Link
          href={`/tea/${note.tea.id}`}
          className="flex items-center gap-3 mt-4 p-3 bg-amber-50 rounded-lg border border-amber-200 hover:bg-amber-100 transition"
        >
          <span className="text-xl">🍵</span>
          <div>
            <div className="text-sm font-medium text-amber-900">{note.tea.name}</div>
            <div className="text-xs text-amber-700">
              {note.tea.brand} · {note.tea.year}年 · {note.tea.type === "raw" ? "生茶" : "熟茶"}
            </div>
          </div>
          <span className="ml-auto text-amber-600 text-xs">查看详情 →</span>
        </Link>

        {/* Scores */}
        {scores.length > 0 && (
          <div className="flex flex-wrap gap-3 mt-4">
            {scores.map((s) => (
              <div key={s.label} className="px-3 py-1.5 bg-stone-50 rounded-lg text-center min-w-[60px]">
                <div className="text-lg font-bold text-amber-800">{s.value}</div>
                <div className="text-[0.625rem] text-stone-400">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Brew info */}
        {(note.brewMethod || note.waterTemp || note.teaWeight || note.steepCount) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-stone-500">
            {note.brewMethod && <span>冲泡: {note.brewMethod}</span>}
            {note.waterTemp && <span>水温: {note.waterTemp}°C</span>}
            {note.teaWeight && <span>投茶: {note.teaWeight}</span>}
            {note.steepCount && <span>耐泡: {note.steepCount}泡</span>}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
        <ForumContent html={note.content} />
      </div>

      {/* Auto-generated slideshow video */}
      {note.videoUrl && (
        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <VideoPlayer src={note.videoUrl} />
        </div>
      )}

      {/* Image Gallery */}
      {images.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <h2 className="text-sm font-semibold text-stone-600 mb-3">图片 ({images.length})</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {images.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                className="aspect-[4/3] rounded-lg overflow-hidden bg-stone-100"
              >
                <img src={src} alt="" className="w-full h-full object-cover hover:opacity-85 transition" />
              </a>
            ))}
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
