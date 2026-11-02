import Link from "next/link";
import { auth } from "@/lib/auth";
import TeaEditForm from "@/components/tea/tea-edit-form";
import { canManageTeas } from "@/lib/tea-permissions";

/**
 * 茶品编辑页。
 *
 * 2026-11-02：准入从「等级 >= 2」改成**权限**（管理员与站长）。
 *
 * 原先这个页面是纯客户端的（`"use client"` + `useSession()`），准入只在前端判，
 * 服务端 `PUT /api/teas/[id]` 也只判等级 —— 任何 Lv.2 普通用户可以改**任意**
 * 一款经典茶的名称/品牌/年份/封面/行情估价，改完立刻公开生效，站长的审核队列
 * 都不会被触发。现在两头都收紧了：页面进不来，接口也 403。
 *
 * 站长的编辑通道就是这里（后台 `/admin/teas` 至今没有改茶品正文的入口），
 * 所以准入收紧到 admin + 站长之后，站长依然能改茶。
 */
export default async function EditTeaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();

  if (!canManageTeas(session?.user)) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-2">只有管理员与站长可以编辑茶品</p>
        <p className="text-stone-400 text-sm mb-4">
          普通茶友可以在任意经典茶的档案页发布**跟进帖**，参与转化观察与行情讨论
        </p>
        <Link href={`/tea/${id}`} className="inline-block border border-stone-300 text-stone-600 px-5 py-2.5 rounded-lg text-sm hover:border-amber-300 transition">
          返回茶品
        </Link>
      </div>
    );
  }

  return <TeaEditForm id={id} />;
}
