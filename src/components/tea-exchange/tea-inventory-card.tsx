"use client";

import { useState } from "react";
import { teaTypeLabel, storageLabel, specLabel } from "./constants";
import TradeRequestModal from "./trade-request-modal";

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
  user?: { id: string; username: string; avatar: string | null; level: number };
}

interface Props {
  item: InventoryItem;
  isOwner: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onHide?: () => void;
}

export default function TeaInventoryCard({ item, isOwner, onEdit, onDelete, onHide }: Props) {
  const [showTradeModal, setShowTradeModal] = useState(false);
  const coverImg = item.images?.[0];
  const isExpired = item.expiresAt ? new Date(item.expiresAt) < new Date() : false;
  const dimmed = isExpired || item.hidden;

  return (
    <>
      <div className={`bg-white border border-stone-200 rounded-lg overflow-hidden hover:shadow-md transition ${dimmed ? "opacity-60 grayscale-[30%]" : ""}`}>
        {/* Badges */}
        {(isExpired || item.hidden) && (
          <div className="flex gap-1 px-3 pt-2">
            {isExpired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-500">已过期</span>}
            {item.hidden && <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-500">已隐藏</span>}
          </div>
        )}

        {/* Image */}
        {coverImg ? (
          <div className="aspect-[4/3] bg-stone-100 overflow-hidden">
            <img src={coverImg} alt={item.brand} decoding="async" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="aspect-[4/3] bg-stone-50 flex items-center justify-center text-stone-300 text-sm">
            暂无图片
          </div>
        )}

        <div className="p-3 space-y-2">
          {/* Title row */}
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <h3 className="font-bold text-stone-800 text-sm truncate">
                {item.brand} {item.year}
              </h3>
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

          {/* Attributes */}
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

          {/* Expiry info */}
          {item.expiresAt && !isExpired && (
            <p className="text-[10px] text-stone-400">
              有效期至 {new Date(item.expiresAt).toLocaleDateString("zh-CN")}
            </p>
          )}

          {/* Owner (for exchange hall) */}
          {item.user && (
            <a
              href={`/user/${item.user.id}?tab=inventory`}
              className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-stone-600 transition"
            >
              {item.user.avatar ? (
                <img src={item.user.avatar} alt="" className="w-4 h-4 rounded-full object-cover" />
              ) : (
                <span className="w-4 h-4 rounded-full bg-stone-200 flex items-center justify-center text-[10px]">
                  {item.user.username[0]}
                </span>
              )}
              {item.user.username}
            </a>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            {isOwner ? (
              <>
                <button onClick={onEdit} className="text-sm text-stone-600 hover:text-stone-900 transition font-medium">编辑</button>
                <button onClick={onHide} className="text-sm text-blue-600 hover:text-blue-800 transition font-medium">
                  {item.hidden ? "显示" : "隐藏"}
                </button>
                <button onClick={onDelete} className="text-sm text-red-500 hover:text-red-700 transition font-medium">删除</button>
              </>
            ) : !isExpired ? (
              <button
                onClick={() => setShowTradeModal(true)}
                className="flex-1 text-xs bg-amber-600 text-white py-1.5 rounded hover:bg-amber-700 transition"
              >
                我想要
              </button>
            ) : null}
            {item.requestCount > 0 && (
              <span className="text-xs text-stone-400 ml-auto">
                {item.requestCount} 人想要
              </span>
            )}
          </div>
        </div>
      </div>

      {showTradeModal && (
        <TradeRequestModal
          inventoryItem={item}
          onClose={() => setShowTradeModal(false)}
        />
      )}
    </>
  );
}
