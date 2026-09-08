import Link from "next/link";

export const metadata = { title: "帮助" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">帮助</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">帮助</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">注册：点击右上角「注册」，设置用户名和密码即可。</p>
      <p className="text-stone-600 leading-relaxed mb-2">发帖：登录后在论坛中选择版块，点击「发布新帖」。</p>
      <p className="text-stone-600 leading-relaxed mb-2">修改密码：登录后进入设置页面可修改密码和个人信息。</p>
      </div>
    </div>
  );
}
