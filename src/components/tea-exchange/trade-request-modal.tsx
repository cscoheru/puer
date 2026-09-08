"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { teaTypeLabel, storageLabel, specLabel, TEA_TYPES, WEIGHT_SPECS } from "./constants";

interface InventoryItem {
  id: string;
  brand: string;
  type: string;
  year: number;
  spec: string;
  remainingWeight: number;
  storage: string;
  images: string[];
  user?: { id: string; username: string };
}

interface Props {
  inventoryItem: InventoryItem;
  onClose: () => void;
}

export default function TradeRequestModal({ inventoryItem: item, onClose }: Props) {
  const { data: session } = useSession();
  const [requestType, setRequestType] = useState<"swap" | "purchase">("swap");
  const [offerSwapBrand, setOfferSwapBrand] = useState("");
  const [offerSwapType, setOfferSwapType] = useState("raw");
  const [offerSwapYear, setOfferSwapYear] = useState("");
  const [offerSwapSpec, setOfferSwapSpec] = useState("357g");
  const [offerSwapWeight, setOfferSwapWeight] = useState("");
  const [offerSwapDesc, setOfferSwapDesc] = useState("");
  const [offerPrice, setOfferPrice] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  if (!session?.user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-stone-500 text-center">请先登录后再操作</p>
          <div className="flex justify-center mt-3">
            <a href="/login" className="text-sm text-amber-600 hover:underline">去登录</a>
          </div>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    const body = {
      inventoryItemId: item.id,
      requestType,
      offerSwapBrand: requestType === "swap" ? offerSwapBrand : undefined,
      offerSwapType: requestType === "swap" ? offerSwapType : undefined,
      offerSwapYear: requestType === "swap" ? offerSwapYear : undefined,
      offerSwapSpec: requestType === "swap" ? offerSwapSpec : undefined,
      offerSwapWeight: requestType === "swap" ? offerSwapWeight : undefined,
      offerSwapDesc: requestType === "swap" ? offerSwapDesc : undefined,
      offerPrice: requestType === "purchase" ? offerPrice : undefined,
      message: message || undefined,
    };

    try {
      const res = await fetch("/api/trade-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "请求失败");
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          {success ? (
            <div className="text-center py-6">
              <p className="text-lg font-bold text-stone-800 mb-2">请求已发送</p>
              <p className="text-sm text-stone-500">等待对方回应</p>
              <button onClick={onClose} className="mt-4 px-6 py-2 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 transition">
                关闭
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold text-stone-800 mb-4">我想要</h2>

              {/* Target item info */}
              <div className="flex gap-3 mb-4 bg-stone-50 rounded p-3">
                {item.images?.[0] && (
                  <img src={item.images[0]} alt="" className="w-16 h-16 rounded object-cover" />
                )}
                <div className="text-sm">
                  <p className="font-bold text-stone-800">{item.brand} {item.year} {teaTypeLabel(item.type)}</p>
                  <p className="text-xs text-stone-500">{specLabel(item.spec)} | {item.remainingWeight}g | {storageLabel(item.storage)}</p>
                  {item.user && <p className="text-xs text-stone-400 mt-0.5">来自 {item.user.username}</p>}
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                {/* Request type */}
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input type="radio" name="requestType" value="swap" checked={requestType === "swap"} onChange={() => setRequestType("swap")} />
                    置换
                  </label>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input type="radio" name="requestType" value="purchase" checked={requestType === "purchase"} onChange={() => setRequestType("purchase")} />
                    购买
                  </label>
                </div>

                {/* Swap offer */}
                {requestType === "swap" && (
                  <div className="space-y-2 bg-blue-50/50 rounded p-3">
                    <p className="text-xs font-medium text-blue-700">我提供的茶品</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input value={offerSwapBrand} onChange={(e) => setOfferSwapBrand(e.target.value)} required className="border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="品牌 *" />
                      <select value={offerSwapType} onChange={(e) => setOfferSwapType(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm">
                        {TEA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <input type="number" value={offerSwapYear} onChange={(e) => setOfferSwapYear(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="年份" />
                      <select value={offerSwapSpec} onChange={(e) => setOfferSwapSpec(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm">
                        {WEIGHT_SPECS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </div>
                    <input type="number" value={offerSwapWeight} onChange={(e) => setOfferSwapWeight(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="剩余克数" />
                    <textarea value={offerSwapDesc} onChange={(e) => setOfferSwapDesc(e.target.value)} rows={2} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm resize-none" placeholder="描述..." />
                  </div>
                )}

                {/* Purchase price */}
                {requestType === "purchase" && (
                  <div className="bg-amber-50/50 rounded p-3">
                    <p className="text-xs font-medium text-amber-700 mb-2">出价</p>
                    <input type="number" step="0.01" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} required className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="¥" />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-stone-500 mb-1">留言</label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm resize-none" placeholder="说点什么..." />
                </div>

                {error && <p className="text-xs text-red-500">{error}</p>}

                <div className="flex gap-2 pt-2">
                  <button type="button" onClick={onClose} className="flex-1 border border-stone-300 text-stone-600 py-2 rounded text-sm hover:bg-stone-50 transition">取消</button>
                  <button type="submit" disabled={submitting} className="flex-1 bg-amber-600 text-white py-2 rounded text-sm hover:bg-amber-700 transition disabled:opacity-50">
                    {submitting ? "发送中..." : "发送请求"}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
