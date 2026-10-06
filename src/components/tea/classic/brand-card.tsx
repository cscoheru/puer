import Link from "next/link";

interface BrandCardProps {
  label: string;
  icon: string | null;
  logo?: string | null;
  href: string;
  classicCount: number;
  totalCount: number;
  noteCount: number;
  active?: boolean;
}

/** 品牌吧卡片：logo/icon + 品牌名 + 三列统计 */
export default function BrandCard({ label, icon, logo, href, classicCount, totalCount, noteCount, active }: BrandCardProps) {
  return (
    <Link
      href={href}
      className={`shrink-0 snap-start min-w-[140px] md:min-w-[160px] p-3 md:p-4 rounded-xl border transition hover:shadow-md ${
        active
          ? "bg-amber-50 border-amber-400 shadow-sm"
          : "bg-white border-stone-200 hover:border-amber-300"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={label} className="w-8 h-8 rounded-lg object-cover border border-stone-200" />
        ) : (
          <span className="text-xl">{icon || "🏷️"}</span>
        )}
        <span className="font-medium text-stone-800 text-sm truncate">{label}</span>
      </div>
      <div className="flex gap-3 text-[0.625rem] text-stone-500">
        <span>经典 {classicCount}</span>
        <span>全部 {totalCount}</span>
        <span>品鉴 {noteCount}</span>
      </div>
    </Link>
  );
}