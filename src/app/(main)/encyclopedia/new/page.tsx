import Link from "next/link";
import { auth } from "@/lib/auth";
import NewTeaForm from "@/components/tea/new-tea-form";
import { canManageTeas, canPromoteToClassic } from "@/lib/tea-permissions";

/**
 * 新增茶品页。
 *
 * 2026-11-02 站长要求：「关于发布新经典，只有 admin 和站长用户可以，其他用户不能
 * 发布新经典（看不到这个按钮）更不能编辑茶品。」
 *
 * 这个页面原来是**纯客户端**的（`"use client"` + `useSession()`），准入只在前端
 * 判 `level >= 2` —— 也就是说任何 Lv.2 用户直接输 URL 就能打开表单。服务端闸门
 * （`POST /api/teas`）当时也只判等级，那是一条真的越权路径。
 *
 * 现在：准入在**服务端**判（`canManageTeas`），无权的人直接看到提示，URL 也进不来。
 */
export default async function NewTeaPage({
  searchParams,
}: {
  searchParams: Promise<{ classic?: string }>;
}) {
  const [session, params] = await Promise.all([auth(), searchParams]);
  const allowed = canManageTeas(session?.user);

  if (!allowed) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-2">只有管理员与站长可以创建茶品</p>
        <p className="text-stone-400 text-sm mb-4">
          普通茶友可以在任意经典茶的档案页发布**跟进帖**，参与转化观察与行情讨论
        </p>
        <Link href="/forum/classics" className="inline-block border border-stone-300 text-stone-600 px-5 py-2.5 rounded-lg text-sm hover:border-amber-300 transition">
          去经典普洱
        </Link>
      </div>
    );
  }

  return (
    <NewTeaForm
      allowClassic={canPromoteToClassic(session?.user)}
      defaultClassic={params.classic === "1"}
    />
  );
}
