"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import TeaPicker from "@/components/cellar/tea-picker";
import type { TeaOption } from "@/components/cellar/use-tea-search";
import { storageBandLabel } from "@/lib/cellar";
import { listPaginationView } from "@/lib/pagination-limits";
import StorageAnchorPicker from "@/components/cellar/storage-anchor-picker";

/**
 * 我的茶仓 —— 条目列表 + 添加茶。
 *
 * 登录门禁走客户端的 `useSession`（照 `favorites` 页的做法）：未登录时
 * 页面渲染成「请先登录」的引导，而不是一个空列表 —— 用户会以为功能坏了。
 * 服务端仍然会独立校验（接口返回 401），两处都要有。
 */

interface ItemRow {
  id: string;
  name: string | null;
  teaId: string | null;
  teaName: string | null;
  teaYear: number | null;
  teaBrand: string | null;
  teaType: string | null;
  acquiredAt: string | null;
  qtyNote: string | null;
  tastingCount: number;
  lastTastedAt: string | null;
  lastDelta: string | null;
  storageScore: number | null;
  storageCity: string | null;
  storageContainer: string | null;
}

const DELTA_TEXT: Record<string, string> = {
  better: "比上次好",
  same: "与上次持平",
  worse: "比上次差",
};

export default function CellarList() {
  const { data: session, status } = useSession();
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 服务端返回的页数是按 total 算的，**不**受翻页深度上限约束。
  // 不夹到 MAX_PUBLIC_PAGE 的话，用户在第 50 页点「下一页」会原地打转 ——
  // 服务端把 51 收敛回 50，还是给第 50 页的数据。夹取收在
  // listPaginationView 里（服务端与客户端共用一份口径）。
  const [pages, setPages] = useState(1);
  // 服务端**实际**返回的页码（用户请求的页码可能被收敛过）。
  const [effPage, setEffPage] = useState(1);
  // 还有记录翻不到（总数推出的页数比能翻到的多）。如实说，别假装到底了。
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cellar?page=${page}&limit=${pageSize}`);
      const data = await res.json();
      if (!res.ok) {
        // 401/403/404 各有各的语义，不能一律当成「茶仓是空的」——
        // 那样合成账号会看到「添加第一款」按钮，点了必然失败。
        setError(data.error || "加载失败");
        setItems([]);
        return;
      }
      setError("");
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
      // 分页口径收在 listPaginationView 里（客户端不再自己算）。
      // isAdmin 恒为 false：这是用户自己的茶仓，服务端对本人请求会收敛翻页深度。
      const view = listPaginationView(
        {
          total: typeof data.total === "number" ? data.total : 0,
          limit: typeof data.limit === "number" ? data.limit : pageSize,
          effectivePage: typeof data.page === "number" ? data.page : page,
        },
        { isAdmin: false },
      );
      setPages(view.pages);
      setEffPage(view.page);
      setTruncated(view.truncated);
    } catch {
      setError("加载失败");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    if (status !== "authenticated") return;
    load();
  }, [status, load]);

  if (status === "loading") {
    return <div className="text-center py-12 text-stone-400">加载中…</div>;
  }

  if (status === "unauthenticated") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-4">请先登录后使用我的茶仓</p>
        <Link
          href="/login"
          className="inline-block bg-amber-800 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-amber-900 transition"
        >
          去登录
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h1 className="text-2xl md:text-4xl font-serif font-bold text-stone-800">
            我的茶仓
          </h1>
          <p className="text-stone-500 text-sm mt-1">
            {loading ? "加载中…" : `共 ${total} 款茶`}
          </p>
        </div>
        <button
          onClick={() => {
            setShowAdd(true);
            setMessage("");
          }}
          className="shrink-0 px-4 py-2 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition"
        >
          添加茶
        </button>
      </div>

      {truncated && (
        <p className="mt-3 mb-4 text-xs px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
          列表最多可翻到第 {pages} 页（共 {total} 款茶）。完整记录可以在
          <Link
            href="/settings"
            className="underline underline-offset-2 hover:text-amber-900"
          >
            设置 → 我的数据
          </Link>
          里导出。
        </p>
      )}

      <p className="text-xs text-stone-400 mb-6">
        茶仓里的记录默认只有你自己看得到。记一条品鉴只要三下点击。
      </p>

      {message && (
        <p className="mb-4 text-sm px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
          {message}
        </p>
      )}

      {error ? (
        <p className="mb-4 text-sm px-3 py-2 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </p>
      ) : loading ? (
        <div className="text-center py-12 text-stone-400">加载中…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-stone-200 rounded-xl bg-white">
          <p className="text-stone-400 mb-2">茶仓还是空的</p>
          <p className="text-xs text-stone-400 mb-4">
            把手里有的茶加进来，之后每次喝完记一笔，就能看出它怎么变。
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800"
          >
            添加第一款
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id}>
              <Link
                href={`/tea-cellar/${it.id}`}
                className="block bg-white border border-stone-200 rounded-xl p-4 hover:border-amber-300 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-stone-800 truncate">
                      {it.teaName || it.name || "未命名"}
                    </p>
                    <p className="text-xs text-stone-400 mt-0.5">
                      {[it.teaBrand, it.teaYear, it.teaType === "ripe" ? "熟茶" : it.teaType === "raw" ? "生茶" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {it.storageScore != null && (
                    <span className="shrink-0 text-[0.65rem] px-2 py-1 rounded border border-stone-200 bg-stone-50 text-stone-600">
                      {storageBandLabel(it.storageScore)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 mt-2.5 text-xs text-stone-400 flex-wrap">
                  <span>
                    {it.tastingCount > 0
                      ? `${it.tastingCount} 次品鉴`
                      : "还没品鉴过"}
                  </span>
                  {it.lastTastedAt && (
                    <span>最近 {it.lastTastedAt.slice(0, 10)}</span>
                  )}
                  {it.lastDelta && (
                    <span className="text-amber-700">{DELTA_TEXT[it.lastDelta]}</span>
                  )}
                  {it.qtyNote && <span>{it.qtyNote}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 text-sm">
          <button
            onClick={() => setPage(Math.max(1, effPage - 1))}
            disabled={effPage <= 1}
            className="px-3 py-1.5 min-h-[44px] inline-flex items-center border border-stone-300 rounded disabled:opacity-40 hover:bg-stone-50"
          >
            上一页
          </button>
          <span
            className="text-stone-500"
            aria-live="polite"
            aria-atomic="true"
          >
            第 {effPage} / {pages} 页
          </span>
          <button
            onClick={() => setPage(Math.min(pages, effPage + 1))}
            disabled={effPage >= pages}
            className="px-3 py-1.5 min-h-[44px] inline-flex items-center border border-stone-300 rounded disabled:opacity-40 hover:bg-stone-50"
          >
            下一页
          </button>
        </div>
      )}

      {showAdd && (
        <AddTeaDialog
          onClose={() => setShowAdd(false)}
          onAdded={(msg) => {
            setMessage(msg);
            setShowAdd(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** 添加茶：搜茶品库 → 选仓储（可跳过）→ 入仓；搜不到就自建。 */
function AddTeaDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const [step, setStep] = useState<"pick" | "self">("pick");
  const [tea, setTea] = useState<TeaOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 仓储
  const [storageScore, setStorageScore] = useState<number | null>(null);
  const [city, setCity] = useState("");
  const [container, setContainer] = useState("");
  const [qtyNote, setQtyNote] = useState("");

  // 自建
  const [selfName, setSelfName] = useState("");
  const [selfBrand, setSelfBrand] = useState("");
  const [selfYear, setSelfYear] = useState("");
  const [selfType, setSelfType] = useState<"raw" | "ripe">("raw");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (step === "self") {
        body.teaRequest = {
          name: selfName.trim(),
          brand: selfBrand.trim() || null,
          year: selfYear.trim() ? Number(selfYear) : null,
          type: selfType,
        };
      } else {
        if (!tea) {
          setError("先选一款茶");
          return;
        }
        body.teaId = tea.id;
      }
      if (storageScore != null) {
        body.storage = {
          storageScore,
          city: city.trim() || null,
          container: container.trim() || null,
        };
      }
      if (qtyNote.trim()) body.qtyNote = qtyNote.trim();

      const res = await fetch("/api/cellar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "添加失败");
        return;
      }
      onAdded(
        step === "self"
          ? "已添加。这条自建茶已提交给站长，审核并入茶品库后就能对照站长线了。"
          : "已添加。",
      );
    } catch {
      setError("添加失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-serif font-bold text-stone-800">
            {step === "pick" ? "添加茶" : "自建茶品"}
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-sm"
          >
            关闭
          </button>
        </div>

        {step === "pick" ? (
          <>
            <TeaPicker
              autoFocus
              onPick={(t) => {
                setTea(t);
                setError("");
              }}
              onSelfBuild={() => setStep("self")}
            />
            {tea && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-900">
                  已选：{tea.name}
                  {tea.brand ? `（${tea.brand}）` : ""}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="text-xs text-stone-500">茶品名 *</span>
              <input
                value={selfName}
                onChange={(e) => setSelfName(e.target.value)}
                placeholder="如：2019 冰岛古树"
                className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-stone-500">品牌</span>
                <input
                  value={selfBrand}
                  onChange={(e) => setSelfBrand(e.target.value)}
                  className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-stone-500">年份</span>
                <input
                  value={selfYear}
                  onChange={(e) => setSelfYear(e.target.value)}
                  inputMode="numeric"
                  className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
                />
              </label>
            </div>
            <div>
              <span className="text-xs text-stone-500">生熟</span>
              <div className="flex gap-2 mt-1">
                {(["raw", "ripe"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSelfType(t)}
                    className={`flex-1 py-2 text-sm rounded-lg border transition ${
                      selfType === t
                        ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                        : "border-stone-200 text-stone-600"
                    }`}
                  >
                    {t === "raw" ? "生茶" : "熟茶"}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => setStep("pick")}
              className="text-xs text-stone-500 hover:text-amber-700"
            >
              ← 回到搜茶品
            </button>
          </div>
        )}

        {/* 仓储登记 —— 三项都可跳过 */}
        <div className="mt-5 pt-4 border-t border-stone-100">
          <p className="text-xs text-stone-500 mb-2">
            仓储登记（可跳过，之后再补）
          </p>
          <StorageAnchorPicker
            value={storageScore}
            onChange={setStorageScore}
            className="mb-2"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="城市（可选）"
              className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
            />
            <input
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              placeholder="容器（可选）"
              className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
            />
          </div>
          <input
            value={qtyNote}
            onChange={(e) => setQtyNote(e.target.value)}
            placeholder="备注（可选，如「还剩半饼」）"
            className="w-full mt-3 px-3 py-2 border border-stone-300 rounded-lg text-sm"
          />
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-600">{error}</p>
        )}

        <button
          onClick={submit}
          disabled={busy || (step === "pick" && !tea)}
          className="w-full mt-4 py-2.5 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition disabled:opacity-40"
        >
          {busy ? "保存中…" : "入仓"}
        </button>
      </div>
    </div>
  );
}
