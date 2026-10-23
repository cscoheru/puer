import {
  deltaLabel,
  stageLabel,
  stageTone,
  type EditorTasting,
} from "@/lib/editor-line";

/**
 * 站长线区块（PRD v0.3 §5 Phase 1）。
 *
 * 只展示结构化字段与摘要预览 —— 品鉴全文仍是站长私人的（admin 才看得到），
 * 这里给的是「时间轴 + 结论」，让访客知道这款茶在站长手里是什么状态。
 */
export default function EditorLineView({
  tastings,
  statement,
  showEmpty = true,
}: {
  tastings: EditorTasting[];
  statement: string | null;
  showEmpty?: boolean;
}) {
  if (!tastings.length) {
    if (!showEmpty) return null;
    return (
      <div className="mb-8">
        <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-1">
          站长线
        </h2>
        <p className="text-xs text-stone-400 mb-4">站长在这款茶上的一手品鉴记录</p>
        <p className="text-center text-stone-400 py-8 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
          暂无记录
        </p>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-1">
        站长线 ({tastings.length})
      </h2>
      <p className="text-xs text-stone-400 mb-4">
        站长在这款茶上的一手品鉴记录，按时间排列
      </p>

      <div className="relative border-l-2 border-amber-200 ml-2 space-y-4">
        {tastings.map((t) => (
          <EditorLineItem key={t.id} t={t} />
        ))}
      </div>

      {statement && (
        <p className="mt-3 text-xs text-stone-400 leading-relaxed">{statement}</p>
      )}
    </div>
  );
}

function EditorLineItem({ t }: { t: EditorTasting }) {
  const stage = stageLabel(t.stage);
  const delta = deltaLabel(t.deltaVsPrev);
  const scoreValues = [
    t.scores.appearance,
    t.scores.color,
    t.scores.aroma,
    t.scores.taste,
    t.scores.aftertaste,
  ].filter((v): v is number => v !== null);
  const avg = scoreValues.length
    ? (scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length).toFixed(1)
    : null;

  return (
    <div className="relative pl-6">
      <span className="absolute -left-[9px] top-2 w-4 h-4 rounded-full bg-amber-700 border-2 border-white" />
      <div className="bg-white border border-stone-200 rounded-lg p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-amber-800">
            {new Date(t.createdAt).getFullYear()} 年
          </span>
          <span className="text-xs text-stone-400">
            {new Date(t.createdAt).toLocaleDateString("zh-CN")}
          </span>
          {stage && (
            <span
              className={`text-[0.65rem] px-1.5 py-0.5 rounded border ${stageTone(t.stage)}`}
            >
              {stage}
            </span>
          )}
          {delta && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded border border-stone-200 bg-stone-50 text-stone-600">
              {delta}
            </span>
          )}
          {avg && <span className="text-xs text-amber-700">★ {avg}</span>}
        </div>

        <p className="text-sm font-medium text-stone-800 mt-0.5 truncate">{t.title}</p>

        {(t.grams != null || t.vessel) && (
          <p className="text-[0.7rem] text-stone-400 mt-1">
            {t.grams != null && `${t.grams} 克`}
            {t.grams != null && t.vessel && " · "}
            {t.vessel && `${t.vessel} 冲泡`}
          </p>
        )}

        {t.descriptors.length > 0 && (
          <p className="text-xs text-stone-500 mt-1 leading-relaxed">
            {t.descriptors.join(" / ")}
          </p>
        )}

        {t.summary && (
          <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-2">
            {t.summary}
          </p>
        )}
      </div>
    </div>
  );
}
