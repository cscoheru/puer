import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { cellarVisibleTo } from "@/lib/cellar-guard";
import CellarList from "@/components/cellar/cellar-list";

/**
 * 我的茶仓（PRD v0.3 §5 Phase 2）。
 *
 * 服务端组件，只做两件事：**验可见性** 与**给 noindex**。
 * 剩下的交互都在客户端组件里。
 *
 * 可见性判定（`cellarVisibleTo`）：全局 flag 开着就全体可见，否则只有
 * uid 白名单里的人能进 —— 2026-10-23 起先只对站长开放。
 *
 * 对看不见的人 404 而不是「功能未开放」的提示页 —— 一个还没上线的功能
 * 不该被搜索引擎收录，也不该让爬虫知道它存在。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的茶仓",
  // 茶仓是私有数据，**不进索引**（照 user/[id] 页的做法）。
  robots: { index: false, follow: false },
};

export default async function TeaCellarPage() {
  const session = await auth();
  if (!cellarVisibleTo(session?.user)) notFound();
  return <CellarList />;
}
