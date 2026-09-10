"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/admin", label: "概览", icon: "📊" },
  { href: "/admin/content", label: "内容管理", icon: "📝" },
  { href: "/admin/users", label: "用户管理", icon: "👥" },
  { href: "/admin/sessions", label: "茶会管理", icon: "🍵" },
  { href: "/admin/reports", label: "举报管理", icon: "🚨" },
  { href: "/admin/reviews", label: "内容审核", icon: "🔍" },
  { href: "/admin/tea-reviews", label: "茶图鉴定", icon: "👮" },
  { href: "/admin/moderators", label: "版主管理", icon: "🛡️" },
  { href: "/admin/hot", label: "热榜管理", icon: "🔥" },
  { href: "/admin/settings", label: "系统设置", icon: "⚙️" },
];

const TOOL_ITEMS = [
  { href: "/admin/teas", label: "茶品合并", icon: "🔄" },
  { href: "/admin/drafts", label: "草稿管理", icon: "📋" },
  { href: "/admin/import", label: "笔记导入", icon: "📥" },
  { href: "/admin/xhs", label: "小红书引流", icon: "📕" },
];

export default function AdminSidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/admin") return pathname === "/admin";
    return pathname.startsWith(href);
  }

  return (
    <aside className="hidden md:flex w-56 shrink-0 border-r border-stone-200 bg-white flex-col">
      <div className="p-4 border-b border-stone-100">
        <h2 className="text-sm font-semibold text-stone-700">管理后台</h2>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
              isActive(item.href)
                ? "bg-amber-50 text-amber-800 font-medium"
                : "text-stone-600 hover:bg-stone-50 hover:text-stone-800"
            }`}
          >
            <span className="text-base">{item.icon}</span>
            {item.label}
          </Link>
        ))}

        <div className="pt-3 pb-1 px-3">
          <span className="text-[0.625rem] font-semibold text-stone-400 uppercase tracking-wider">工具</span>
        </div>
        {TOOL_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
              isActive(item.href)
                ? "bg-amber-50 text-amber-800 font-medium"
                : "text-stone-600 hover:bg-stone-50 hover:text-stone-800"
            }`}
          >
            <span className="text-base">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="p-3 border-t border-stone-100">
        <Link
          href="/"
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-stone-500 hover:bg-stone-50 transition"
        >
          ← 返回前台
        </Link>
      </div>
    </aside>
  );
}
