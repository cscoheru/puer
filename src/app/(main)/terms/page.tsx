import Link from "next/link";

export const metadata = { title: "用户协议" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">用户协议</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">用户协议</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">使用本社区即表示您同意遵守社区规则。</p>
      <p className="text-stone-600 leading-relaxed mb-2">您对自己发布的内容负责。我们有权删除违规内容。</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们保留随时修改条款的权利，修改后的条款自发布之日起生效。</p>
      </div>
    </div>
  );
}
