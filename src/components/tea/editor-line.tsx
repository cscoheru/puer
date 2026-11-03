import Link from "next/link";
import {
  deltaLabel,
  editorLineHref,
  stageLabel,
  stageTone,
  type EditorTasting,
} from "@/lib/editor-line";

/**
 * 站长线区块（PRD v0.3 §5 Phase 1）。
 *
 * ## 现在是可点的
 *
 * 2026-11-02 站长报「站长线上的品鉴记录一个都点不开，看不到详情」。查实是两层
 * 叠加，**都不是权限设计**：
 *   ① 这个组件从 2026-10-23 上线起就**从来没渲染过链接**（`git log -p` 全
 *      history 里没有过 `next/link` / `href=`）—— 是「从未实现」，不是回归；
 *   ② 就算补上链接，`/tasting/[id]` 当时整个页面是 `admin:access` 守卫，
 *      连站长自己点进去都是 404。
 *
 * 现在：卡片链到记录的正身（镜像笔记 → 帖子页，原始笔记 → 笔记页），
 * 详情页按「摘要公开、正文/全部图片要付费会员」分级展示
 * （`src/lib/archive-visibility.ts`）。
 *
 * ## 匿名访客点不开（2026-11-03）
 *
 * 站长定的口径：「非登录状态无法点击（用户点击则提示登录），登录后点击记录，
 * 只能看到部分记录，锁定状态和其他保持统一。」
 *
 * 所以 `canOpenDetail=false` 时卡片**不是链接**，底部给一个「登录后查看详情」
 * 的入口 —— 与站内其它锁定态（LockedTip / 登录链接）一致。
 */
export default function EditorLineView({
  tastings,
  statement,
  showEmpty = true,
  canOpenDetail = true,
  loginHref,
}: {
  tastings: EditorTasting[];
  statement: string | null;
  showEmpty?: boolean;
  /** 访客能不能打开详情页（匿名为 false）。 */
  canOpenDetail?: boolean;
  /** 登录落点（canOpenDetail=false 时给「登录后查看详情」）。 */
  loginHref?: string;
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
          <EditorLineItem key={t.id} t={t} canOpenDetail={canOpenDetail} loginHref={loginHref} />
        ))}
      </div>

      {statement && (
        <p className="mt-3 text-xs text-stone-400 leading-relaxed">{statement}</p>
      )}
    </div>
  );
}

function EditorLineItem({
  t,
  canOpenDetail = true,
  loginHref,
}: {
  t: EditorTasting;
  canOpenDetail?: boolean;
  loginHref?: string;
}) {
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

  // 卡片主体：链接态与锁定态共用同一段内容（不要复制两份 —— 改一处漏一处
  // 就是「有链接的那份改了、锁定的那份没改」）。
  const body = (
    <>
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
    </>
  );

  return (
    <div className="relative pl-6">
      <span className="absolute -left-[9px] top-2 w-4 h-4 rounded-full bg-amber-700 border-2 border-white" />
      {canOpenDetail ? (
        <Link
          href={editorLineHref(t)}
          className="block bg-white border border-stone-200 rounded-lg p-3 hover:border-amber-400 hover:bg-amber-50/30 transition cursor-pointer group"
        >
          {body}
          <p className="text-[0.65rem] text-amber-700 mt-1.5 opacity-0 group-hover:opacity-100 transition">
            查看详情 →
          </p>
        </Link>
      ) : (
        <div className="block bg-white border border-stone-200 rounded-lg p-3">
          {body}
          {loginHref ? (
            <p className="text-[0.65rem] text-stone-400 mt-1.5">
              🔒{" "}
              <a
                href={loginHref}
                className="text-amber-700 hover:text-amber-900 underline underline-offset-2"
              >
                登录后查看详情
              </a>
            </p>
          ) : (
            <p className="text-[0.65rem] text-stone-400 mt-1.5">🔒 登录后查看详情</p>
          )}
        </div>
      )}
    </div>
  );
}
