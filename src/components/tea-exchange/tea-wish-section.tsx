"use client";

import { useState, useEffect, useCallback } from "react";
import TeaWishCard from "./tea-wish-card";
import TeaWishForm from "./tea-wish-form";

interface Props {
  userId: string;
  isOwner: boolean;
}

interface WishItem {
  id: string;
  brand: string | null;
  type: string | null;
  year: number | null;
  spec: string | null;
  acquisitionType: string;
  swapOfferBrand: string | null;
  swapOfferType: string | null;
  swapOfferYear: number | null;
  swapOfferSpec: string | null;
  swapOfferWeight: number | null;
  swapOfferDesc: string | null;
  offerPrice: number | null;
  description: string | null;
}

export default function TeaWishSection({ userId, isOwner }: Props) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<WishItem | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tea-wish?userId=${userId}`);
      const data = await res.json();
      setItems(data.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleDelete(id: string) {
    if (!confirm("确定删除该心愿？")) return;
    await fetch(`/api/tea-wish/${id}`, { method: "DELETE" });
    fetchItems();
  }

  if (loading) {
    return <div className="text-center py-8 text-sm text-stone-400">加载中...</div>;
  }

  return (
    <div>
      {isOwner && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => { setEditingItem(null); setShowForm(true); }}
            className="px-4 py-2 bg-amber-600 text-white text-sm rounded hover:bg-amber-700 transition"
          >
            + 添加心愿
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-8 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
          {isOwner ? "暂无心愿，点击上方按钮添加" : "该用户暂无心愿"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((item) => (
            <TeaWishCard
              key={item.id}
              item={item}
              isOwner={isOwner}
              onEdit={() => { setEditingItem(item); setShowForm(true); }}
              onDelete={() => handleDelete(item.id)}
            />
          ))}
        </div>
      )}

      {showForm && (
        <TeaWishForm
          initial={editingItem}
          onClose={() => { setShowForm(false); setEditingItem(null); }}
          onSaved={() => { setShowForm(false); setEditingItem(null); fetchItems(); }}
        />
      )}
    </div>
  );
}
