"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Logo from "@/components/logo";
import SearchBar from "@/components/search-bar";
import UserMenu from "@/components/user-menu";
import { useLocale } from "@/i18n/context";

export default function Header() {
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileQuery, setMobileQuery] = useState("");
  const [mobileFocused, setMobileFocused] = useState(false);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { _, locale, toggle } = useLocale();

  const closeMenu = () => setMenuOpen(false);

  // 茶记入口仅管理员可见(原 level>=2 与 /tasting 页面 role 判定不一致,统一为 admin)
  const showLevelLinks = session?.user?.role === "admin";
  const showUserLinks = !!session?.user;

  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-amber-100">
      <div className="max-w-6xl mx-auto px-3 md:px-4 h-14 flex items-center gap-3">
        <Logo />

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1 ml-2">
          <Link href="/forum" className="px-3 py-1.5 text-sm text-stone-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition">
            {_("论坛")}
          </Link>
          <Link href="/exchange" className="px-3 py-1.5 text-sm text-stone-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition">
            {_("互换大厅")}
          </Link>
          <Link href="/sessions" className="px-3 py-1.5 text-sm text-stone-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition">
            {_("云喝茶")}
          </Link>
          <Link href="/ask" className="px-3 py-1.5 text-sm text-stone-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition">
            {_("茶问")}
          </Link>
          {showLevelLinks && (
            <Link href="/tasting" className="px-3 py-1.5 text-sm text-stone-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition">
              {_("茶记")}
            </Link>
          )}
        </nav>

        {/* Search bar — centered on desktop, hidden on mobile */}
        <div className="hidden md:flex flex-1 justify-center">
          <SearchBar />
        </div>

        {/* User menu + locale toggle — right aligned on desktop */}
        <div className="hidden md:flex items-center gap-2">
          <button
            onClick={toggle}
            className="text-xs px-2 py-1 rounded border border-stone-300 text-stone-500 hover:border-amber-400 hover:text-amber-600 transition"
            aria-label="切换语言"
          >
            <span suppressHydrationWarning>{locale === "zh-TW" ? "简体" : "繁體"}</span>
          </button>
          <UserMenu />
        </div>

        {/* Mobile: search icon + user menu + hamburger */}
        <div className="flex items-center gap-0.5 md:hidden">
          {mobileSearchOpen ? (
            <div className="relative flex items-center flex-1">
              <div className={`relative flex items-center w-full transition-all duration-200 ${mobileFocused ? "ring-2 ring-amber-300 border-amber-400" : ""} rounded-full`}>
                <svg className="absolute left-3 w-4 h-4 text-stone-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input ref={mobileInputRef} type="text" value={mobileQuery}
                  onChange={(e) => setMobileQuery(e.target.value)}
                  onFocus={() => setMobileFocused(true)}
                  onBlur={() => setMobileFocused(false)}
                  onKeyDown={(e) => { if (e.key === "Enter" && mobileQuery.trim()) { setMobileSearchOpen(false); router.push(`/forum/search?q=${encodeURIComponent(mobileQuery.trim())}`); } }}
                  placeholder="搜索帖子..." autoFocus
                  className="w-full pl-9 pr-10 py-2 text-sm bg-stone-100 border border-stone-200 rounded-full outline-none text-stone-700 placeholder:text-stone-400 transition"
                />
                <button onClick={() => { setMobileSearchOpen(false); setMobileQuery(""); }} className="absolute right-1.5 p-1.5 text-stone-400 hover:text-stone-600 rounded-full hover:bg-stone-200 transition" aria-label="关闭搜索">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* P2-R5：经典普洱入口（仅移动端常显，点击进品牌吧） */}
              <Link
                href="/forum/classics"
                className="flex items-center gap-1 px-2.5 py-1.5 ml-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 text-xs font-medium hover:bg-amber-100 hover:border-amber-300 transition"
                aria-label={_("经典普洱")}
              >
                <span aria-hidden>🏵️</span>
                <span>{_("经典")}</span>
              </Link>
              <button onClick={() => { setMobileSearchOpen(true); setTimeout(() => mobileInputRef.current?.focus(), 100); }}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-stone-500 hover:text-amber-700 transition"
                aria-label="搜索">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
              </button>
              <UserMenu />
              <button onClick={() => setMenuOpen(!menuOpen)}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-stone-600 -mr-2"
                aria-label={menuOpen ? "关闭菜单" : "打开菜单"}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  {menuOpen ? <path d="M6 6l12 12M6 18L18 6" /> : <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>}
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile slide-down menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-amber-100 bg-white/95 backdrop-blur">
          <div className="px-4 pt-3">
            <SearchBar />
          </div>
          <div className="px-4 pt-2 flex items-center justify-between">
            <button
              onClick={toggle}
              className="text-xs px-2 py-1 rounded border border-stone-300 text-stone-500 hover:border-amber-400 hover:text-amber-600 transition"
            >
              <span suppressHydrationWarning>{locale === "zh-TW" ? "简体" : "繁體"}</span>
            </button>
          </div>
          <nav className="px-4 py-3 space-y-1">
            <Link href="/forum" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🏠 {_("首页")}</Link>
            <Link href="/forum/classics" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🏵️ {_("经典普洱")}</Link>
            <Link href="/exchange" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🤝 {_("互换大厅")}</Link>
            <Link href="/sessions" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🍵 {_("云喝茶")}</Link>
            <Link href="/ask" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🫖 {_("茶问")}</Link>
            {showLevelLinks && (
              <Link href="/tasting" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">📖 {_("茶记")}</Link>
            )}
            <Link href="/forum/explore" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">🔍 {_("探索社区")}</Link>
            <Link href="/forum/new" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-700 hover:bg-amber-50 transition min-h-[44px] flex items-center">✏️ {_("发布新帖")}</Link>
          </nav>

          {showUserLinks && (
            <div className="border-t border-amber-100 px-4 py-3">
              <Link href={`/user/${session!.user!.id}`} onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-600 hover:bg-amber-50 transition min-h-[44px] flex items-center">
                👤 {_("个人主页")}
              </Link>
              <Link href="/favorites" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-600 hover:bg-amber-50 transition min-h-[44px] flex items-center">
                ⭐ {_("收藏")}
              </Link>
              <Link href="/settings" onClick={closeMenu} className="block py-3 px-3 -mx-3 rounded-lg text-stone-600 hover:bg-amber-50 transition min-h-[44px] flex items-center">
                ⚙️ {_("设置")}
              </Link>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
