import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { cellarVisibleTo } from "@/lib/cellar-guard";
import { getCellarItem } from "@/lib/cellar-data";
import { getEditorLine } from "@/lib/editor-line-data";
import CellarDetail from "@/components/cellar/cellar-detail";

/**
 * 茶仓条目详情。
 *
 * ## 为什么在服务端取数据
 *
 * 条目是**所有者私有**的。服务端带着 session 取，天然不会把别人的数据
 * 发到浏览器；客户端组件再自己 fetch 一遍只是为了刷新（记完品鉴后
 * 更新时间轴），拿到的仍然是自己的数据。
 *
 * 站长线在服务端一并取好（`getEditorLine`）—— 它是公开信息（站长线本来
 * 就渲染在茶品页上），但不必让客户端多打一次。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "茶仓条目",
  robots: { index: false, follow: false },
};

export default async function CellarItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  // 可见性先判：对看不见的人，条目存不存在都是 404。
  if (!cellarVisibleTo(session?.user)) notFound();

  const { id } = await params;
  if (!session?.user?.id) notFound();

  // 别人的条目取不到 —— 数据层的 where 里带 userId。
  const item = await getCellarItem(session.user.id, id);
  if (!item) notFound();

  const editorLine = item.teaId
    ? await getEditorLine(item.teaId).catch(() => null)
    : null;

  return (
    <CellarDetail
      item={{
        id: item.id,
        name: item.name,
        teaId: item.teaId,
        tea: item.tea,
        acquiredAt: item.acquiredAt,
        qtyNote: item.qtyNote,
        remindEveryMonths: item.remindEveryMonths,
        nextRemindAt: item.nextRemindAt,
        lastRemindedAt: item.lastRemindedAt,
        epochs: item.epochs,
        tastings: item.tastings,
        latestTastingCreatedAt: item.latestTastingCreatedAt,
        // 复饮建议的信号（服务端按「同一条茶、按人」取好）—— 客户端用
        // 同一个纯函数算，口径与跑批脚本一致。
        latestTastingDelta: item.latestTastingDelta,
        latestTastingStage: item.latestTastingStage,
      }}
      editorLine={editorLine}
    />
  );
}
