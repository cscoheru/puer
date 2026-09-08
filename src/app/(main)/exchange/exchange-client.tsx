"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { teaTypeLabel, storageLabel, specLabel } from "@/components/tea-exchange/constants";
import TradeRequestModal from "@/components/tea-exchange/trade-request-modal";

interface InventoryItem {
  id: string;
  brand: string;
  name?: string | null;
  type: string;
  year: number;
  spec: string;
  remainingWeight: number;
  storage: string;
  images: string[];
  requestCount: number;
  estimatedValue?: number | string | null;
  description?: string | null;
  user: { id: string; username: string; avatar: string | null; level: number };
}

interface Props {
  brands: string[];
}

export default function ExchangeClient({ brands }: Props) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const { data: session } = useSession();

  // Filters
  const [filterType, setFilterType] = useState<string>("");
  const [filterBrand, setFilterBrand] = useState<string>("");
  const [filterStorage, setFilterStorage] = useState<string>("");
  const [sort, setSort] = useState<string>("newest");

  // Trade modal
  const [tradeItem, setTradeItem] = useState<InventoryItem | null>(null);

  // Detail modal
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState(0);

  const limit = 12;

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: "active", page: String(page), limit: String(limit), sort });
      if (filterType) params.set("type", filterType);
      if (filterBrand) params.set("brand", filterBrand);
      if (filterStorage) params.set("storage", filterStorage);
      const res = await fetch(`/api/tea-inventory?${params}`);
      const data = await res.json();
      setItems(data.data || []);
      setTotal(data.total || 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page, sort, filterType, filterBrand, filterStorage]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-stone-800">互换大厅</h1>
        <a href={session?.user ? `/user/${session.user.id}?tab=inventory` : "/login"} className="text-sm text-amber-600 hover:underline">管理我的茶版</a>
      </div>

      {/* Quick filter tabs */}
      <div className="flex gap-2 mb-4 overflow-x-auto">
        {[
          { label: "全部", type: "" },
          { label: "生茶", type: "raw" },
          { label: "熟茶", type: "ripe" },
        ].map(({ label, type }) => (
          <button
            key={label}
            onClick={() => { setFilterType(type); setPage(1); }}
            className={`px-4 py-1.5 text-sm rounded-full whitespace-nowrap transition ${
              filterType === type ? "bg-amber-600 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => { setSort(sort === "popular" ? "newest" : "popular"); setPage(1); }}
          className={`px-4 py-1.5 text-sm rounded-full whitespace-nowrap transition ${
            sort === "popular" ? "bg-amber-600 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
          }`}
        >
          热门
        </button>
      </div>

      <div className="flex gap-4">
        {/* Sidebar filters */}
        <div className="hidden md:block w-48 shrink-0 space-y-4">
          {/* Brand filter */}
          <div>
            <p className="text-xs font-medium text-stone-500 mb-2">品牌</p>
            <select
              value={filterBrand}
              onChange={(e) => { setFilterBrand(e.target.value); setPage(1); }}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">全部</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          {/* Storage filter */}
          <div>
            <p className="text-xs font-medium text-stone-500 mb-2">仓储</p>
            <div className="space-y-1">
              {["", "dry_high_aroma", "dry_normal", "home_natural", "wet"].map((v) => (
                <button
                  key={v}
                  onClick={() => { setFilterStorage(v); setPage(1); }}
                  className={`block w-full text-left px-2 py-1 text-xs rounded transition ${
                    filterStorage === v ? "bg-amber-50 text-amber-700" : "text-stone-500 hover:bg-stone-50"
                  }`}
                >
                  {v === "" ? "全部" : storageLabel(v)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div className="flex-1">
          {loading ? (
            <div className="text-center py-16 text-sm text-stone-400">加载中...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-16 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
              暂无茶版，快去添加吧
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {items.map((item) => (
                  <div key={item.id} className="bg-white border border-stone-200 rounded-lg overflow-hidden hover:shadow-md transition">
                    {/* Image — click to view detail */}
                    {item.images?.[0] ? (
                      <div
                        className="aspect-[4/3] bg-stone-100 overflow-hidden cursor-pointer"
                        onClick={() => setDetailItem(item)}
                      >
                        <img src={item.images[0]} alt={item.brand} decoding="async" className="w-full h-full object-cover hover:opacity-90 transition"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center text-stone-300 text-xs">图片加载失败</div>'; }}
                        />
                      </div>
                    ) : (
                      <div
                        className="aspect-[4/3] bg-stone-50 flex items-center justify-center text-stone-300 text-sm cursor-pointer"
                        onClick={() => setDetailItem(item)}
                      >
                        暂无图片
                      </div>
                    )}

                    <div className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-1">
                        <div className="min-w-0">
                          <h3 className="font-bold text-stone-800 text-sm truncate">{item.brand} {item.year}</h3>
                          {item.name && (
                            <p className="text-xs text-stone-500 truncate">{item.name}</p>
                          )}
                        </div>
                        <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded font-medium ${
                          item.type === "raw" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                        }`}>
                          {teaTypeLabel(item.type)}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-1.5 text-xs text-stone-500">
                        <span>{specLabel(item.spec)}</span>
                        <span className="text-stone-300">|</span>
                        <span>{item.remainingWeight}g</span>
                        <span className="text-stone-300">|</span>
                        <span>{storageLabel(item.storage)}</span>
                        {item.estimatedValue ? (
                          <>
                            <span className="text-stone-300">|</span>
                            <span className="text-amber-700 font-medium">¥{Number(item.estimatedValue).toLocaleString()}</span>
                          </>
                        ) : null}
                      </div>

                      {/* Owner */}
                      <a
                        href={`/user/${item.user.id}?tab=inventory`}
                        className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-stone-600 transition"
                      >
                        {item.user.avatar ? (
                          <img src={item.user.avatar} alt="" className="w-4 h-4 rounded-full object-cover" />
                        ) : (
                          <span className="w-4 h-4 rounded-full bg-stone-200 flex items-center justify-center text-[10px]">{item.user.username[0]}</span>
                        )}
                        {item.user.username}
                      </a>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => setTradeItem(item)}
                          className="flex-1 text-xs bg-amber-600 text-white py-1.5 rounded hover:bg-amber-700 transition"
                        >
                          我想要
                        </button>
                        {item.requestCount > 0 && (
                          <span className="text-xs text-stone-400">{item.requestCount}人想要</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1.5 text-sm border border-stone-300 rounded disabled:opacity-50 hover:bg-stone-50 transition"
                  >
                    上一页
                  </button>
                  <span className="text-sm text-stone-500">{page} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="px-3 py-1.5 text-sm border border-stone-300 rounded disabled:opacity-50 hover:bg-stone-50 transition"
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {tradeItem && (
        <TradeRequestModal inventoryItem={tradeItem} onClose={() => setTradeItem(null)} />
      )}

      {/* Detail modal */}
      {detailItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => { setDetailItem(null); setLightboxIdx(0); }}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Image gallery */}
            {detailItem.images && detailItem.images.length > 0 && (
              <div className="relative">
                {/* Main image */}
                <div className="aspect-[4/3] bg-stone-100 overflow-hidden rounded-t-xl">
                  <img
                    src={detailItem.images[lightboxIdx]}
                    alt=""
                    className="w-full h-full object-cover" decoding="async"
                  />
                </div>
                {/* Navigation arrows */}
                {detailItem.images.length > 1 && (
                  <>
                    {lightboxIdx > 0 && (
                      <button
                        onClick={() => setLightboxIdx((i) => i - 1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/40 text-white rounded-full flex items-center justify-center hover:bg-black/60 transition"
                      >
                        &lsaquo;
                      </button>
                    )}
                    {lightboxIdx < detailItem.images.length - 1 && (
                      <button
                        onClick={() => setLightboxIdx((i) => i + 1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/40 text-white rounded-full flex items-center justify-center hover:bg-black/60 transition"
                      >
                        &rsaquo;
                      </button>
                    )}
                    {/* Thumbnail strip */}
                    <div className="flex gap-1 p-2 bg-stone-50 overflow-x-auto">
                      {detailItem.images.map((img, i) => (
                        <button
                          key={i}
                          onClick={() => setLightboxIdx(i)}
                          className={`shrink-0 w-12 h-12 rounded overflow-hidden border-2 transition ${
                            i === lightboxIdx ? "border-amber-500" : "border-transparent opacity-60 hover:opacity-100"
                          }`}
                        >
                          <img src={img} alt="" className="w-full h-full object-cover" decoding="async" />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Info section */}
            <div className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-stone-800">
                    {detailItem.brand} {detailItem.year}
                  </h2>
                  {detailItem.name && (
                    <p className="text-sm text-stone-500">{detailItem.name}</p>
                  )}
                </div>
                <span className={`shrink-0 text-xs px-2 py-1 rounded font-medium ${
                  detailItem.type === "raw" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                }`}>
                  {teaTypeLabel(detailItem.type)}
                </span>
              </div>

              <div className="flex flex-wrap gap-2 text-sm text-stone-600">
                <span className="px-2 py-1 bg-stone-50 rounded">{specLabel(detailItem.spec)}</span>
                <span className="px-2 py-1 bg-stone-50 rounded">{detailItem.remainingWeight}g</span>
                <span className="px-2 py-1 bg-stone-50 rounded">{storageLabel(detailItem.storage)}</span>
                {detailItem.estimatedValue ? (
                  <span className="px-2 py-1 bg-amber-50 text-amber-800 rounded font-medium">
                    估价 ¥{Number(detailItem.estimatedValue).toLocaleString()}
                  </span>
                ) : null}
              </div>

              {detailItem.description && (
                <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-wrap">
                  {detailItem.description}
                </p>
              )}

              {/* Owner */}
              <a
                href={`/user/${detailItem.user.id}?tab=inventory`}
                className="flex items-center gap-2 text-sm text-stone-500 hover:text-stone-700 transition"
              >
                {detailItem.user.avatar ? (
                  <img src={detailItem.user.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-stone-200 flex items-center justify-center text-xs">
                    {detailItem.user.username[0]}
                  </span>
                )}
                {detailItem.user.username}
              </a>

              {/* Action */}
              <div className="flex gap-2 pt-2 border-t border-stone-100">
                <button
                  onClick={() => { setDetailItem(null); setLightboxIdx(0); setTradeItem(detailItem); }}
                  className="flex-1 bg-amber-600 text-white py-2 rounded-lg text-sm hover:bg-amber-700 transition"
                >
                  我想要
                </button>
                <button
                  onClick={() => { setDetailItem(null); setLightboxIdx(0); }}
                  className="px-6 border border-stone-300 text-stone-600 py-2 rounded-lg text-sm hover:bg-stone-50 transition"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
