"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useLocale } from "@/i18n/context";
import { useFeatureFlag } from "@/components/layout/feature-context";

interface Notification {
  id: string;
  type: string;
  content: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

/** 轮询间隔：通知是低频事件，1 分钟足够，不必更勤。 */
const NOTIF_POLL_MS = 60_000;

export default function UserMenu() {
  const { data: session } = useSession();
  // Hook before the logged-out early return below — the menu renders on both
  // /forum and /tw/forum, so its chrome has to follow the reader's language.
  const { _ } = useLocale();
  // 我的茶仓：登录用户可见，且要 feature flag 开着。
  const cellarOn = useFeatureFlag("cellar") && !!session?.user;
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notifRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 上一次请求还没回来 → 别再发一个（防重叠）。 */
  const fetchingRef = useRef(false);

  const loadNotifications = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.notifications)) {
        setNotifications(data.notifications);
        setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0);
      }
    } catch {
      // 网络抖动不该把界面弄坏 —— 下一次轮询会补上
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  /**
   * 标记已读。
   *
   * 之前**没有任何地方**把 read 置为 true —— 未读数只增不减，徽标永远是 9+，
   * 新来的提醒会被埋掉（而且 PRD §9 的「提醒点击到记录的转化率」要的就是
   * 这个点击信号）。
   */
  const markRead = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) return;
      const data = await res.json();
      // 立刻本地生效 —— 不等下一次轮询（否则红点会闪回来）。
      setNotifications((prev) =>
        prev.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)),
      );
      if (typeof data.unreadCount === "number") setUnreadCount(data.unreadCount);
    } catch {
      // 标记失败不影响使用
    }
  }, []);

  // 取通知：挂载时取一次，之后每分钟轮询；页面不可见时**暂停**（切回来立刻补一次）。
  useEffect(() => {
    if (!session?.user) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(loadNotifications, NOTIF_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        loadNotifications();
        start();
      } else {
        stop();
      }
    };

    // void + 微任务：fetch 是异步的，但直接调用会被 react-hooks 的
    // set-state-in-effect 规则判成「在 effect 里同步 setState」。
    void Promise.resolve().then(loadNotifications);
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session, loadNotifications]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 未登录显示登录/注册;session 由服务端注入,SSR 即可正确渲染,无需等 hydrate
  if (!session?.user) {
    return (
      <div className="flex items-center gap-2">
        <Link href="/login" className="text-sm text-stone-600 hover:text-amber-800 transition min-h-[44px] flex items-center px-2">
          {_("登录")}
        </Link>
        <Link
          href="/register"
          className="text-sm bg-amber-800 text-white px-4 py-2 rounded-lg hover:bg-amber-900 transition min-h-[44px] flex items-center"
        >
          {_("注册")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Notifications */}
      <div className="relative" ref={notifRef}>
        <button
          onClick={() => { setNotifOpen(!notifOpen); setMenuOpen(false); }}
          className="relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-stone-500 hover:text-amber-700 transition rounded-lg hover:bg-stone-100"
          aria-label={_("通知")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[0.625rem] font-bold rounded-full flex items-center justify-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        {notifOpen && (
          <div className="absolute right-0 mt-1 w-80 bg-white border border-stone-200 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-100">
              <h3 className="text-sm font-semibold text-stone-700">{_("通知")}</h3>
              {unreadCount > 0 && (
                <button
                  onClick={() => markRead(notifications.filter((n) => !n.read).map((n) => n.id))}
                  className="text-[0.6875rem] text-stone-400 hover:text-amber-700 transition"
                >
                  {_("全部已读")}
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <p className="text-xs text-stone-400 text-center py-8">{_("暂无通知")}</p>
            ) : (
              notifications.map((n) => (
                <Link
                  key={n.id}
                  href={n.link || "#"}
                  className={`block px-4 py-2.5 hover:bg-stone-50 transition border-b border-stone-50 last:border-0 ${!n.read ? "bg-amber-50/50" : ""}`}
                  onClick={() => {
                    setNotifOpen(false);
                    // 点开哪一条就标记哪一条 —— 这也是「提醒点击转化率」的信号。
                    if (!n.read) markRead([n.id]);
                  }}
                >
                  <p className="text-xs text-stone-700 line-clamp-2">{n.content}</p>
                  <p className="text-[0.625rem] text-stone-400 mt-0.5">
                    {new Date(n.createdAt).toLocaleDateString("zh-CN")}
                  </p>
                </Link>
              ))
            )}
          </div>
        )}
      </div>

      {/* User avatar / dropdown */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => { setMenuOpen(!menuOpen); setNotifOpen(false); }}
          className="flex items-center gap-1.5 min-h-[44px] px-2 rounded-lg hover:bg-stone-100 transition"
        >
          <div className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center text-xs text-amber-700 overflow-hidden">
            {session.user.image ? (
              <img src={session.user.image} alt="" decoding="async" className="w-full h-full object-cover" />
            ) : (
              (session.user.name || session.user.email || "?")[0]
            )}
          </div>
          <span className="hidden md:block text-sm text-stone-700 font-medium max-w-[100px] truncate">
            {session.user.name}
          </span>
          <svg className="hidden md:block w-3 h-3 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute right-0 mt-1 w-48 bg-white border border-stone-200 rounded-lg shadow-lg z-50">
            <div className="px-4 py-2.5 border-b border-stone-100">
              <p className="text-sm font-medium text-stone-700 truncate">{session.user.name}</p>
              {session.user.level !== undefined && (
                <p className="text-xs text-amber-700">Lv.{session.user.level}</p>
              )}
            </div>
            <div className="py-1">
              <Link
                href={`/user/${session.user.id}`}
                onClick={() => setMenuOpen(false)}
                className="block px-4 py-2 text-sm text-stone-600 hover:bg-stone-50 transition"
              >
                {_("个人主页")}
              </Link>
              <Link
                href="/favorites"
                onClick={() => setMenuOpen(false)}
                className="block px-4 py-2 text-sm text-stone-600 hover:bg-stone-50 transition"
              >
                {_("收藏")}
              </Link>
              {cellarOn && (
                <Link
                  href="/tea-cellar"
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-2 text-sm text-stone-600 hover:bg-stone-50 transition"
                >
                  {_("我的茶仓")}
                </Link>
              )}
              <Link
                href="/settings"
                onClick={() => setMenuOpen(false)}
                className="block px-4 py-2 text-sm text-stone-600 hover:bg-stone-50 transition"
              >
                {_("设置")}
              </Link>
              <hr className="my-1 border-stone-100" />
              <button
                onClick={() => signOut()}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-stone-50 transition"
              >
                {_("退出登录")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
