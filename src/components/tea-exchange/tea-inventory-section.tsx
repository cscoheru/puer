"use client";

import { useState, useEffect, useCallback } from "react";
import TeaInventoryCard from "./tea-inventory-card";
import TeaInventoryForm from "./tea-inventory-form";

interface Props {
  userId: string;
  isOwner: boolean;
}

interface InventoryItem {
  id: string;
  brand: string;
  name?: string | null;
  type: string;
  year: number;
  spec: string;
  remainingWeight: number;
  storage: string;
  purchaseTime: string | null;
  source: string | null;
  openTime: string | null;
  description: string | null;
  images: string[];
  requestCount: number;
  estimatedValue?: number | string | null;
  validityDays: number | null;
  expiresAt: string | null;
  hidden: boolean;
}

export default function TeaInventorySection({ userId, isOwner }: Props) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [hiddenItems, setHiddenItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [tab, setTab] = useState<"active" | "hidden">("active");

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tea-inventory?userId=${userId}&status=active`);
      const data = await res.json();
      setItems(data.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const fetchHidden = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tea-inventory?userId=${userId}&status=active&showHidden=true`);
      const data = await res.json();
      setHiddenItems(data.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchItems(); fetchHidden(); }, [fetchItems, fetchHidden]);

  async function handleDelete(id: string) {
    if (!confirm("确定彻底删除该茶版？此操作不可撤销。")) return;
    const res = await fetch(`/api/tea-inventory/${id}`, { method: "DELETE" });
    if (res.ok) {
      setItems((prev) => prev.filter((i) => i.id !== id));
      setHiddenItems((prev) => prev.filter((i) => i.id !== id));
    }
  }

  async function handleHide(id: string) {
    await fetch(`/api/tea-inventory/${id}/hide`, { method: "POST" });
    fetchItems();
    fetchHidden();
  }

  if (loading && items.length === 0 && hiddenItems.length === 0) {
    return <div className="text-center py-8 text-sm text-stone-400">加载中...</div>;
  }

  const hiddenCount = hiddenItems.filter((i) => i.hidden).length;

  return (
    <div>
      {isOwner && (
        <>
          {/* Top bar */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex gap-1">
              <button
                onClick={() => setTab("active")}
                className={`px-4 py-2 text-sm rounded transition ${
                  tab === "active"
                    ? "bg-amber-600 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                在架 ({items.filter((i) => !i.hidden).length})
              </button>
              {isOwner && (
                <button
                  onClick={() => { setTab("hidden"); }}
                  className={`px-4 py-2 text-sm rounded transition ${
                    tab === "hidden"
                      ? "bg-stone-500 text-white"
                      : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                  }`}
                >
                  已下架
                  {hiddenCount > 0 && (
                    <span className="ml-1 text-xs">({hiddenCount})</span>
                  )}
                </button>
              )}
            </div>
            <button
              onClick={() => { setEditingItem(null); setShowForm(true); }}
              className="px-4 py-2 bg-amber-600 text-white text-sm rounded hover:bg-amber-700 transition"
            >
              + 添加茶版
            </button>
          </div>
        </>
      )}

      {/* Active tab */}
      {tab === "active" && (
        <>
          {items.filter((i) => !i.hidden).length === 0 ? (
            <div className="text-center py-8 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
              {isOwner ? "暂无茶版，点击上方按钮添加" : "该用户暂无茶版"}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {items
                .filter((i) => !i.hidden)
                .map((item) => (
                  <TeaInventoryCard
                    key={item.id}
                    item={item}
                    isOwner={isOwner}
                    onEdit={() => { setEditingItem(item); setShowForm(true); }}
                    onDelete={() => handleDelete(item.id)}
                    onHide={() => handleHide(item.id)}
                  />
                ))}
            </div>
          )}
        </>
      )}

      {/* Hidden tab */}
      {tab === "hidden" && (
        <>
          {hiddenItems.filter((i) => i.hidden).length === 0 ? (
            <div className="text-center py-8 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
              暂无已下架茶版
            </div>
          ) : (
            <div>
              <p className="text-xs text-stone-400 mb-3">
                已下架的茶版仅你自己可见，你可以还原或彻底删除
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {hiddenItems
                  .filter((i) => i.hidden)
                  .map((item) => (
                    <div key={item.id} className="relative">
                      <TeaInventoryCard
                        item={item}
                        isOwner={isOwner}
                        onEdit={() => { setEditingItem(item); setShowForm(true); }}
                        onDelete={() => handleDelete(item.id)}
                        onHide={() => handleHide(item.id)}
                      />
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {showForm && (
        <TeaInventoryForm
          initial={editingItem}
          onClose={() => { setShowForm(false); setEditingItem(null); }}
          onSaved={() => { setShowForm(false); setEditingItem(null); fetchItems(); fetchHidden(); }}
        />
      )}
    </div>
  );
}
