import Link from "next/link";

export const metadata = { title: "隐私政策" };

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">隐私政策</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-4">隐私政策</h1>
      <div className="space-y-1">
      <p className="text-stone-600 leading-relaxed mb-2">我们收集的信息仅限于您注册时提供的用户名和密码。</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们使用必要的 Cookie 来维持您的登录状态。</p>
      <p className="text-stone-600 leading-relaxed mb-2">我们不会将您的个人信息分享给第三方。</p>
      <p className="text-stone-600 leading-relaxed mb-2">如您需要删除账号，请联系管理员。</p>
      </div>
    </div>
  );
}
