import Link from "next/link";

interface ArticleCardProps {
  article: {
    id: string;
    type: string;
    title: string;
    summary?: string | null;
    tastingScores?: Record<string, number> | null | unknown;
    createdAt: Date;
    author: { username: string; avatar?: string | null; level: number; levelName?: string };
    tea?: { name: string; brand: string; year: number } | null;
    _count: { comments: number; likes: number };
  };
}

export default function ArticleCard({ article }: ArticleCardProps) {
  const href = article.type === "tasting" ? `/tasting/${article.id}` : `/article/${article.id}`;

  const scoreObj = article.tastingScores as Record<string, number> | null | undefined;
  const avgScore =
    scoreObj
      ? Object.values(scoreObj).reduce((a, b) => a + b, 0) /
        Object.values(scoreObj).length
      : null;

  return (
    <Link href={href} className="block p-3 md:p-4 bg-white rounded-xl border border-stone-200 hover:border-amber-300 hover:shadow transition">
      <div className="flex items-start justify-between gap-2 md:gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-stone-800 truncate text-sm md:text-base">{article.title}</h3>

          {article.tea && (
            <p className="text-xs text-amber-700 mt-1">
              {article.tea.brand} · {article.tea.year} · {article.tea.name}
            </p>
          )}

          {article.summary && (
            <p className="text-sm text-stone-500 mt-1.5 line-clamp-2">{article.summary}</p>
          )}

          <div className="flex items-center gap-3 mt-2 text-xs text-stone-400">
            <span className="text-amber-700">
              Lv.{article.author.level} {article.author.levelName ?? `Lv.${article.author.level}`}
            </span>
            <span>{article.author.username}</span>
            <span>{new Date(article.createdAt).toLocaleDateString("zh-CN")}</span>
          </div>
        </div>

        {avgScore !== null && (
          <div className="text-center shrink-0">
            <div className="text-2xl font-bold text-amber-700">{avgScore.toFixed(1)}</div>
            <div className="text-xs text-stone-400">评分</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 mt-2 text-xs text-stone-400">
        <span>{article._count.comments} 评论</span>
        <span>{article._count.likes} 赞</span>
      </div>
    </Link>
  );
}
