import { firstTeaImage, type TeaListRow } from "@/lib/tea-query";

/** P1-5：给出固有尺寸，浏览器可在图片加载前预留空间（CLS）。
 *  P2-R6：正面封面优先，缺省图库第一张，无图 🍵 占位。 */
export function TeaThumb({
  tea,
  className = "w-14 h-14",
  icon = "text-2xl",
  rounded = "rounded-lg",
}: {
  tea: Pick<TeaListRow, "coverImage" | "gallery" | "tastingNotes" | "name">;
  className?: string;
  icon?: string;
  rounded?: string;
}) {
  const img = firstTeaImage(tea);
  return (
    <div className={`${className} ${rounded} overflow-hidden bg-gradient-to-br from-amber-50 to-stone-100 shrink-0`}>
      {img ? (
        <img
          src={img}
          alt={tea.name}
          width={120}
          height={120}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className={`w-full h-full flex items-center justify-center ${icon}`}>🍵</div>
      )}
    </div>
  );
}
