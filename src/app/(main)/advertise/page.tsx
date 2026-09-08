import Link from "next/link";

export const metadata = { title: "广告合作" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">广告合作</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">广告合作</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">广告合作请联系：klyliae@gmail.com</p>
      <p className="text-stone-600 leading-relaxed mb-2">微信：rockrockiloveyou</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们提供硬广和内容植入两种合作方式，精准触达普洱茶爱好者群体。</p>
      </div>
    </div>
  );
}
