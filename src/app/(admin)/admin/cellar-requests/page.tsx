"use client";

import { useCallback, useEffect, useState } from "react";
import { useTeaSearch } from "@/components/cellar/use-tea-search";
import type { TeaOption } from "@/components/cellar/use-tea-search";

/**
 * 茶仓后台（PRD v0.3 §5 Phase 2）。
 *
 * 只剩一件事：**自建茶品** —— 用户提交、茶品库里还没有的茶。站长并入
 * 茶品库，并入后引用这条申请的茶仓条目会自动挂上那款茶。
 *
 * **没有代录**（2026-10-23 站长拍板）：茶仓里的每一条记录都由用户本人录入，
 * 站长不写别人的茶仓。所以这里没有「代录」tab，也没有对应的接口 ——
 * 站长的茶仓特权只剩「提供茶品库与经典茶品目录」这一条线。
 */

interface RequestRow {
  id: string;
  name: string;
  brand: string | null;
  year: number | null;
  type: string;
  weightSpec: string | null;
  note: string | null;
  status: string;
  mergedTeaId: string | null;
  rejectReason: string | null;
  createdAt: string;
  requester: { uid: number | null; username: string; nickname: string | null };
  cellarItemCount: number;
}

export default function AdminCellarPage() {
  return (
    <div className="max-w-7xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">茶仓后台</h1>
        <p className="text-sm text-stone-500 mt-1">
          审核用户自建的茶品，并入茶品库后茶仓条目会自动挂上那款茶。
        </p>
      </div>

      <RequestsTab />
    </div>
  );
}

// ─── 自建茶品审核 ─────────────────────────────────────────────────────────

function RequestsTab() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("pending");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 正在并入哪一条
  const [merging, setMerging] = useState<string | null>(null);
  const [picked, setPicked] = useState<TeaOption | null>(null);
  // 选茶搜索（去抖 + 拉取）与用户侧共用同一个 hook。
  const { q, setQ, teas, searching, error: searchError } = useTeaSearch(
    "/api/admin/cellar/teas",
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/cellar/requests?status=${status}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 403（没有 cellar:manage）不能显示成「没有符合条件的申请」——
        // 那是把权限问题说成了队列为空。
        setError(data.error || "加载失败");
        setRows([]);
        return;
      }
      setError("");
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);


  const review = async (
    id: string,
    action: "approve" | "reject",
    extra: Record<string, unknown> = {},
  ) => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/cellar/requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      setMessage(action === "approve" ? "已并入" : "已退回");
      setMerging(null);
      setPicked(null);
      setQ("");
      load();
    } catch {
      setMessage("操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="text-sm px-2 py-1.5 border border-stone-300 rounded bg-white"
        >
          <option value="pending">待审核</option>
          <option value="approved">已通过</option>
          <option value="rejected">已退回</option>
        </select>
        <span className="text-xs text-stone-400">共 {rows.length} 条</span>
      </div>

      {message && (
        <p className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
          {message}
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm px-3 py-2 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-stone-400 py-8 text-center">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-stone-400 py-8 text-center bg-white rounded-lg border border-dashed border-stone-200">
          没有符合条件的申请
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li
              key={r.id}
              className="bg-white border border-stone-200 rounded-lg p-4"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-medium text-stone-800">
                    {r.name}
                    <span className="text-xs text-stone-400 ml-2">
                      {[r.brand, r.year, r.type === "ripe" ? "熟茶" : "生茶"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </p>
                  <p className="text-xs text-stone-400 mt-0.5">
                    {r.requester.nickname || r.requester.username}
                    {r.requester.uid ? `（${r.requester.uid}）` : ""} 提交于{" "}
                    {r.createdAt.slice(0, 10)}
                    {r.cellarItemCount > 0 &&
                      ` · ${r.cellarItemCount} 个茶仓条目引用了它`}
                  </p>
                  {r.note && (
                    <p className="text-xs text-stone-500 mt-1">{r.note}</p>
                  )}
                  {r.status === "approved" && r.mergedTeaId && (
                    <p className="text-xs text-emerald-700 mt-1">
                      已并入茶品 {r.mergedTeaId}
                    </p>
                  )}
                  {r.status === "rejected" && r.rejectReason && (
                    <p className="text-xs text-stone-500 mt-1">
                      退回原因：{r.rejectReason}
                    </p>
                  )}
                </div>

                {r.status === "pending" && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setMerging(merging === r.id ? null : r.id);
                        setPicked(null);
                        setQ("");
                      }}
                      className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50"
                    >
                      并入茶品库
                    </button>
                    <button
                      onClick={() => {
                        const reason = prompt("退回原因（可留空）：") ?? "";
                        review(r.id, "reject", {
                          rejectReason: reason.trim() || null,
                        });
                      }}
                      disabled={busy}
                      className="px-3 py-1.5 text-sm text-stone-500 border border-stone-300 rounded hover:bg-stone-50 disabled:opacity-40"
                    >
                      退回
                    </button>
                  </div>
                )}
              </div>

              {merging === r.id && (
                <div className="mt-3 pt-3 border-t border-stone-100">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜茶品库，勾选要并入的那款"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
                  />
                  {teas.length > 0 && (
                    <ul className="mt-2 max-h-48 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100">
                      {teas.map((t) => (
                        <li key={t.id}>
                          <button
                            onClick={() => setPicked(t)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-amber-50 transition ${
                              picked?.id === t.id
                                ? "bg-amber-50 text-amber-800"
                                : "text-stone-700"
                            }`}
                          >
                            {t.name}
                            {t.brand ? ` · ${t.brand}` : ""}
                            {t.year ? ` · ${t.year}` : ""}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() =>
                        picked && review(r.id, "approve", { mergedTeaId: picked.id })
                      }
                      disabled={!picked || busy}
                      className="px-3 py-1.5 text-sm bg-amber-700 text-white rounded hover:bg-amber-800 disabled:opacity-40"
                    >
                      {busy ? "处理中…" : "确认并入"}
                    </button>
                    {picked && (
                      <span className="text-xs text-stone-500">
                        将并入：{picked.name}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
