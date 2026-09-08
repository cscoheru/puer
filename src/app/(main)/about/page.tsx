import Link from "next/link";

export const metadata = { title: "关于 PuEr" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">关于 PuEr</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">关于 PuEr</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">PuEr（puer.im）是一个专注于中老期普洱茶的爱好者社区。</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们提供品鉴笔记分享、茶品百科、茶友交流论坛、茶品互换等服务。</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们的使命：让每一位普洱爱好者都能找到志同道合的茶友，分享每一泡茶的滋味与故事。</p>
      </div>
    </div>
  );
}
