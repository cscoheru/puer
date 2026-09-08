import Link from "next/link";

export const metadata = { title: "社区规则" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">社区规则</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">社区规则</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">1. 尊重他人 — 请礼貌交流，禁止人身攻击、辱骂、歧视等行为。</p>
      <p className="text-stone-600 leading-relaxed mb-2">2. 禁止广告 — 未经允许不得发布商业广告。茶品交易请在「茶市风云」版块发布。</p>
      <p className="text-stone-600 leading-relaxed mb-2">3. 禁止灌水 — 请发布与普洱茶相关的内容，无关帖子将被移除。</p>
      <p className="text-stone-600 leading-relaxed mb-2">4. 版权尊重 — 转载他人内容请注明出处。</p>
      </div>
    </div>
  );
}
