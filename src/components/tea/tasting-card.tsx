import Link from "next/link";

interface TastingNoteCardProps {
  note: {
    id: string;
    title: string;
    summary: string | null;
    appearance: number | null;
    color: number | null;
    aroma: number | null;
    taste: number | null;
    aftertaste: number | null;
    images: unknown;
    createdAt: Date;
    author: { username: string; avatar: string | null; level: number };
  };
}

export default function TastingCard({ note }: TastingNoteCardProps) {
  const images: string[] = Array.isArray(note.images)
    ? (note.images as unknown[]).filter((i): i is string => typeof i === "string")
    : [];
  const previewImage = images[0];
  const scores = [note.appearance, note.color, note.aroma, note.taste, note.aftertaste].filter(Boolean) as number[];
  const avgScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  return (
    <Link
      href={`/tasting/${note.id}`}
      className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
    >
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        {previewImage ? (
          <div className="w-20 h-20 md:w-24 md:h-24 shrink-0 rounded-lg overflow-hidden bg-stone-100">
            <img src={previewImage} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-20 h-20 md:w-24 md:h-24 shrink-0 rounded-lg bg-gradient-to-br from-amber-50 to-stone-100 flex items-center justify-center text-2xl">
            📝
          </div>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-stone-800 group-hover:text-amber-800 transition truncate">
            {note.title}
          </h3>
          {note.summary && (
            <p className="text-xs md:text-sm text-stone-500 mt-1 line-clamp-2">{note.summary}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-stone-400">
            <span>{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span>
            {avgScore && <span className="text-amber-700">★ {avgScore}</span>}
            {images.length > 1 && <span>{images.length} 图</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}
