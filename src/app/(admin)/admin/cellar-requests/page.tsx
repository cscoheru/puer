"use client";

import { useCallback, useEffect, useState } from "react";
import StorageAnchorPicker from "@/components/cellar/storage-anchor-picker";
import { useTeaSearch } from "@/components/cellar/use-tea-search";
import type { TeaOption } from "@/components/cellar/use-tea-search";

/**
 * 茶仓后台（PRD v0.3 §5 Phase 2）。
 *
 * 两个 tab：
 *  - **自建茶品**：用户提交、茶品库里还没有的茶。站长并入茶品库，
 *    并入后引用这条申请的茶仓条目会自动挂上那款茶。
 *  - **代录**：PRD `:139` 要求「先由站长手工帮种子用户录入茶仓」。
 *    代录写的是**别人的私有数据**，所以仓储评分的来源标成「站长评」
 *    而不是「自评」—— 将来做社区带时，这两种来源不能混。
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

interface UserRow {
  id: string;
  uid: number | null;
  username: string;
  level: number;
  isSynthetic: boolean;
}

export default function AdminCellarPage() {
  const [tab, setTab] = useState<"requests" | "proxy">("requests");

  return (
    <div className="max-w-7xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">我的茶仓</h1>
        <p className="text-sm text-stone-500 mt-1">
          审核用户自建的茶品；给种子用户代录茶仓条目。
        </p>
      </div>

      <div className="mb-5 flex items-center gap-2">
        <button
          onClick={() => setTab("requests")}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${
            tab === "requests"
              ? "bg-amber-800 text-white border-amber-800"
              : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"
          }`}
        >
          自建茶品待审核
        </button>
        <button
          onClick={() => setTab("proxy")}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${
            tab === "proxy"
              ? "bg-amber-800 text-white border-amber-800"
              : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"
          }`}
        >
          代录茶仓
        </button>
      </div>

      {tab === "requests" ? <RequestsTab /> : <ProxyTab />}
    </div>
  );
}

// ─── Tab 1：自建茶品审核 ─────────────────────────────────────────────────

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

// ─── Tab 2：代录茶仓 ─────────────────────────────────────────────────────

function ProxyTab() {
  const [keyword, setKeyword] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [target, setTarget] = useState<UserRow | null>(null);
  const [items, setItems] = useState<
    { id: string; name: string | null; teaName: string | null; storageScore: number | null; tastingCount: number }[]
  >([]);
  const [message, setMessage] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const search = async () => {
    if (!keyword.trim()) return;
    try {
      const res = await fetch(
        `/api/admin/users?keyword=${encodeURIComponent(keyword.trim())}&limit=20`,
      );
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch {
      setUsers([]);
    }
  };

  const loadItems = useCallback(async (userId: string) => {
    try {
      const res = await fetch(`/api/cellar?targetUserId=${encodeURIComponent(userId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 404 = 这个账号看不见茶仓（flag 关着且 uid 不在白名单里）；
        // 403 = 没有代录权限。这两种都**不能**显示成「这个用户没有茶仓条目」——
        // 那是把「查不到」说成「没有」，站长会以为用户真的没记录过。
        // 成功时不碰 message：代录成功的提示语也走同一个 message 状态。
        setMessage(data.error || "加载失败");
        setItems([]);
        return;
      }
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setMessage("加载失败");
      setItems([]);
    }
  }, []);

  const pick = (u: UserRow) => {
    setTarget(u);
    setShowAdd(false);
    setMessage("");
    loadItems(u.id);
  };

  return (
    <div>
      <p className="text-sm text-stone-500 mb-4">
        代录写的是用户的私有数据，仓储评分的来源会标成「站长评」。
      </p>

      <div className="flex items-center gap-2 mb-4">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
          placeholder="按 UID / 用户名 / 邮箱找用户，回车确认"
          className="text-sm px-3 py-2 border border-stone-300 rounded flex-1 max-w-md"
        />
        <button
          onClick={search}
          className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50"
        >
          查找
        </button>
      </div>

      {users.length > 0 && !target && (
        <ul className="mb-4 bg-white border border-stone-200 rounded-lg divide-y divide-stone-100 max-w-md">
          {users.map((u) => (
            <li key={u.id}>
              <button
                onClick={() => pick(u)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 transition"
              >
                <span className="text-stone-800">{u.username}</span>
                <span className="text-xs text-stone-400 ml-2">
                  {u.uid ? `UID ${u.uid} · ` : ""}Lv.{u.level}
                  {u.isSynthetic && " · 合成账号"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {target && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-stone-800">
              {target.username} 的茶仓
            </h2>
            <button
              onClick={() => {
                setTarget(null);
                setItems([]);
              }}
              className="text-xs text-stone-500 hover:text-stone-700"
            >
              换一个用户
            </button>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="px-3 py-1.5 text-sm bg-amber-700 text-white rounded hover:bg-amber-800 ml-auto"
            >
              {showAdd ? "收起" : "代录一条"}
            </button>
          </div>

          {message && (
            <p className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
              {message}
            </p>
          )}

          {showAdd && (
            <ProxyAddForm
              targetUserId={target.id}
              onDone={(msg) => {
                setMessage(msg);
                setShowAdd(false);
                loadItems(target.id);
              }}
            />
          )}

          {items.length === 0 ? (
            <p className="text-sm text-stone-400 py-6 text-center bg-white rounded-lg border border-dashed border-stone-200">
              这个用户还没有茶仓条目
            </p>
          ) : (
            <ul className="bg-white border border-stone-200 rounded-lg divide-y divide-stone-100">
              {items.map((it) => (
                <li key={it.id} className="px-3 py-2.5 text-sm flex items-center gap-3">
                  <span className="text-stone-800 flex-1 truncate">
                    {it.teaName || it.name || "未命名"}
                  </span>
                  {it.storageScore != null && (
                    <span className="text-xs text-stone-500">
                      仓储 {it.storageScore}
                    </span>
                  )}
                  <span className="text-xs text-stone-400">
                    {it.tastingCount} 次品鉴
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 代录一条：选茶 + 仓储（评分来源自动标成「站长评」）。 */
function ProxyAddForm({
  targetUserId,
  onDone,
}: {
  targetUserId: string;
  onDone: (message: string) => void;
}) {
  const [picked, setPicked] = useState<TeaOption | null>(null);
  const { q, setQ, teas, searching, error: searchError } = useTeaSearch(
    "/api/admin/cellar/teas",
  );
  const [score, setScore] = useState<number | null>(null);
  const [city, setCity] = useState("");
  const [container, setContainer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");


  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cellar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teaId: picked.id,
          targetUserId,
          ...(score != null
            ? {
                storage: {
                  storageScore: score,
                  city: city.trim() || null,
                  container: container.trim() || null,
                },
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "代录失败");
        return;
      }
      onDone(`已代录：${picked.name}`);
      setPicked(null);
      setQ("");
      setScore(null);
      setCity("");
      setContainer("");
    } catch {
      setError("代录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜茶品库"
        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
      />
      {teas.length > 0 && (
        <ul className="mt-2 max-h-40 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100">
          {teas.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setPicked(t)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-amber-50 transition ${
                  picked?.id === t.id ? "bg-amber-50 text-amber-800" : "text-stone-700"
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

      <div className="flex gap-2 flex-wrap mt-3 items-center">
        <StorageAnchorPicker value={score} onChange={setScore} />
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="城市（可选）"
          className="px-3 py-1.5 border border-stone-300 rounded-lg text-sm"
        />
        <input
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          placeholder="容器（可选）"
          className="px-3 py-1.5 border border-stone-300 rounded-lg text-sm"
        />
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <button
        onClick={submit}
        disabled={!picked || busy}
        className="mt-3 px-3 py-1.5 text-sm bg-amber-700 text-white rounded hover:bg-amber-800 disabled:opacity-40"
      >
        {busy ? "代录中…" : "代录"}
      </button>
    </div>
  );
}
