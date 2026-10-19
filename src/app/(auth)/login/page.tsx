"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";

/**
 * 登录后回跳目标。只接受**站内绝对路径**：必须以单个 `/` 开头，
 * 拒绝 `//evil.com`（协议相对 URL）、`/\evil.com`（部分浏览器按 `//` 解析）
 * 和任何含 `:` 的值（`javascript:`、`https:`）。回跳参数来自 URL，
 * 不做这层校验就是开放重定向。
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.includes(":") || raw.includes("\\")) return "/";
  return raw;
}

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email: account,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("账号或密码不正确");
    } else {
      // Hard redirect: forces SessionProvider to re-init so useSession()
      // reflects the just-set JWT cookie. A soft router.push() leaves the
      // stale pre-login session cached → header still shows "登录/注册".
      // `next` 从 window 读取而非 useSearchParams()，与本仓库其它客户端页一致
      // （避免客户端组件 prerender 需要 Suspense 包裹）。
      window.location.href = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-amber-50 to-stone-100">
      <div className="w-full max-w-md p-5 md:p-8 bg-white rounded-2xl shadow-lg border border-amber-100 mx-4 md:mx-0">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="text-2xl md:text-3xl font-bold" style={{ color: "#3d6b4e" }}>Puêr</h1>
          <p className="text-stone-500 mt-2 text-sm md:text-base">以茶会友，品鉴真味</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">账号</label>
            <input
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="UID、用户名或邮箱"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </form>

        <p className="text-center text-sm text-stone-500 mt-6">
          还没有账号？{" "}
          <Link href="/register" className="text-amber-700 hover:text-amber-900 font-medium">
            注册
          </Link>
        </p>
      </div>
    </div>
  );
}
