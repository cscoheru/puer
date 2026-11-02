import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import TastingNoteComments from "@/components/tasting-note-comments";
import TastingNoteEditor from "@/components/tasting/tasting-note-editor";
import { can } from "@/lib/permissions";
import { archiveTier, canViewNoteBody, gateArchiveContent } from "@/lib/archive-visibility";
import { canManageTeas } from "@/lib/tea-permissions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TastingNotePage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  const isAdmin = can(session?.user, "admin:access");

  const note = await prisma.tastingNote.findUnique({
    where: { id },
    include: {
      tea: true,
      author: { select: { id: true, username: true, avatar: true, level: true } },
      _count: { select: { comments: true } },
    },
  });

  if (!note || note.tea.deletedAt) notFound();

  // R23 茶品库对用户绝对隐藏：非经典茶的档案页对普通用户 404。
  // 详情页同理 —— 否则猜到一个 id 就能从笔记页摸到茶品库。
  //
  // 「待整理」（needsReview）的茶同理：它的档案页对普通用户 404，
  // 笔记页不能比档案页更宽松（否则就是「列表与详情不一致」的另一种形态）。
  const teaIsPublic = note.tea.isClassic && !note.tea.needsReview;
  if (!teaIsPublic && !canManageTeas(session?.user)) notFound();

  // 档案内容分级（2026-11-02 站长定的口径：**摘要公开、正文要登录**）。
  //
  // 受保护内容**不进 SSR**：未登录时正文根本不传给客户端组件，
  // 否则 view-source 里就有全文（P2-R22 一直强调的那条）。
  const tier = archiveTier({
    userId: session?.user?.id,
    isAdmin,
    isPaidMember: false, // TODO(R22+): 付费会员体系（session 会员字段）
  });
  const loginHref = session?.user
    ? undefined
    : `/login?next=${encodeURIComponent(`/tasting/${id}`)}`;

  const scores = [
    { label: "外形", value: note.appearance },
    { label: "汤色", value: note.color },
    { label: "香气", value: note.aroma },
    { label: "滋味", value: note.taste },
    { label: "余韵", value: note.aftertaste },
  ].filter((s) => s.value !== null);

  const allImages: string[] = Array.isArray(note.images)
    ? (note.images as unknown[]).filter((i): i is string => typeof i === "string")
    : [];

  // 作者本人与管理员看全文；其余按档位（member 档 = 已登录 → 全文）
  const canSeeBody = canViewNoteBody(
    tier,
    { userId: session?.user?.id, isAdmin },
    note.authorId,
  );
  const gated = gateArchiveContent(
    canSeeBody ? "staff" : tier,
    note.content,
    allImages,
  );
  const images = gated.images;

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
        canEdit={isAdmin}
        locked={gated.locked}
        loginHref={loginHref}
        note={{
          id: note.id,
          title: note.title,
          // 未登录时这里是空串 —— 正文不进 SSR
          content: gated.content,
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
