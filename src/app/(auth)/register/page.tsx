"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import Script from "next/script";
import Link from "next/link";

// Cloudflare Turnstile Site Key(公开值,客户端可见)。
// 硬编码而非依赖构建期 NEXT_PUBLIC_ 注入,避免重新构建时丢失。
const TURNSTILE_SITE_KEY = "0x4AAAAAAD1UGEJcT_73nJGO";

function PasswordStrength({ pw }: { pw: string }) {
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const longEnough = pw.length >= 8;

  if (!pw) return null;
  const passed = [longEnough, hasLetter, hasNumber].filter(Boolean).length;
  const label = passed < 3 ? "弱" : passed === 3 ? "中" : "强";
  const color = passed < 2 ? "bg-red-400" : passed < 3 ? "bg-amber-400" : "bg-green-500";

  return (
    <div className="mt-1 space-y-1">
      <div className="flex gap-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded ${i <= passed ? color : "bg-stone-200"}`} />
        ))}
      </div>
      <ul className="text-[11px] text-stone-400 space-y-0.5">
        <li className={longEnough ? "text-green-600" : ""}>• 至少8个字符</li>
        <li className={hasLetter ? "text-green-600" : ""}>• 包含至少一个字母</li>
        <li className={hasNumber ? "text-green-600" : ""}>• 包含至少一个数字</li>
      </ul>
    </div>
  );
}

export default function RegisterPage() {
  const [form, setForm] = useState({ username: "", nickname: "", password: "", hp: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [assignedUid, setAssignedUid] = useState<number | null>(null);
  const [loadedAt] = useState(() => Date.now());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Anti-bot: reject if submitted too fast (less than 3s after page load)
    if (Date.now() - loadedAt < 3000) {
      setError("请稍后再提交");
      return;
    }

    setLoading(true);

    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        turnstileToken: (window as any).turnstile?.getResponse() || "",
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error);
      setLoading(false);
      return;
    }

    if (data.uid) setAssignedUid(data.uid);

    const result = await signIn("credentials", {
      email: String(data.uid),
      password: form.password,
      redirect: false,
    });

    setLoading(false);
    if (result?.ok) {
      // Hard redirect so useSession() picks up the freshly issued session
      // cookie; a soft router.push() keeps the stale pre-auth session cached.
      window.location.href = "/";
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-amber-50 to-stone-100">
      <div className="w-full max-w-md p-5 md:p-8 bg-white rounded-2xl shadow-lg border border-amber-100 mx-4 md:mx-0">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="text-2xl md:text-3xl font-serif font-bold text-amber-900">加入茶社</h1>
          <p className="text-stone-500 mt-2 text-sm md:text-base">注册账号，开始你的普洱之旅</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
              {error}
            </div>
          )}

          {assignedUid && (
            <div className="p-3 text-sm text-green-700 bg-green-50 rounded-lg border border-green-200">
              注册成功！你的 UID 号是 <strong className="text-lg">{assignedUid}</strong>，请牢记此号码用于登录。
            </div>
          )}

          {/* Honeypot — invisible to humans */}
          <div className="absolute -left-[9999px]" aria-hidden="true">
            <input type="text" name="hp" value={form.hp} onChange={(e) => setForm({ ...form, hp: e.target.value })} tabIndex={-1} autoComplete="off" />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">登录用户名</label>
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              minLength={2}
              maxLength={50}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="用于登录，仅限字母数字和下划线"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">昵称</label>
            <input
              type="text"
              value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
              maxLength={50}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="论坛中显示的名称（留空则同用户名）"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">密码</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="至少8位，含字母和数字"
            />
            <PasswordStrength pw={form.password} />
          </div>

          {/* Cloudflare Turnstile 验证码 — site key 是公开值,直接内联避免构建期 env 注入问题 */}
          {TURNSTILE_SITE_KEY && (
            <>
              <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
              <div className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} />
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
          >
            {loading ? "注册中..." : "注册"}
          </button>
        </form>

        <p className="text-center text-sm text-stone-500 mt-6">
          已有账号？{" "}
          <Link href="/login" className="text-amber-700 hover:text-amber-900 font-medium">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
