"use client";

import { teaTypeLabel, specLabel, ACQUISITION_TYPES } from "./constants";

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
  images?: string[];
  description: string | null;
}

interface Props {
  item: WishItem;
  isOwner: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function TeaWishCard({ item, isOwner, onEdit, onDelete }: Props) {
  const acqLabel = ACQUISITION_TYPES.find((a) => a.value === item.acquisitionType)?.label || item.acquisitionType;

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-stone-800 text-sm">
          {item.brand || "不限品牌"}
          {item.year ? ` ${item.year}` : ""}
          {item.type ? ` ${teaTypeLabel(item.type)}` : ""}
        </h3>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
          item.acquisitionType === "swap" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"
        }`}>
          {acqLabel}
        </span>
      </div>

      {/* Want details */}
      <div className="flex flex-wrap gap-1.5 text-xs text-stone-500">
        {item.spec && <span>{specLabel(item.spec)}</span>}
      </div>

      {/* Images */}
      {item.images && item.images.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto">
          {item.images.map((url, i) => (
            <img key={i} src={url} alt="" className="w-14 h-14 rounded object-cover shrink-0" />
          ))}
        </div>
      )}

      {/* Swap offer or price */}
      {item.acquisitionType === "swap" && item.swapOfferBrand && (
        <div className="text-xs text-stone-500 bg-stone-50 rounded p-2">
          <span className="font-medium text-stone-600">置换出：</span>
          {item.swapOfferBrand} {item.swapOfferYear || ""} {item.swapOfferType ? teaTypeLabel(item.swapOfferType) : ""}
          {item.swapOfferWeight ? ` ${item.swapOfferWeight}g` : ""}
          {item.swapOfferSpec ? ` ${specLabel(item.swapOfferSpec)}` : ""}
        </div>
      )}
      {item.acquisitionType === "purchase" && item.offerPrice && (
        <div className="text-xs text-stone-500 bg-stone-50 rounded p-2">
          <span className="font-medium text-stone-600">意向价：</span>
          ¥{Number(item.offerPrice).toLocaleString()}
        </div>
      )}

      {item.description && (
        <p className="text-xs text-stone-400 line-clamp-2">{item.description}</p>
      )}

      {isOwner && (
        <div className="flex gap-2 pt-1">
          <button onClick={onEdit} className="text-xs text-stone-500 hover:text-stone-700 transition">编辑</button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 transition">删除</button>
        </div>
      )}
    </div>
  );
}
