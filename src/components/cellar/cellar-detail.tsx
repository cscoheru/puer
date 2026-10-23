"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import EditorLineView from "@/components/tea/editor-line";
import QuickTastingForm from "@/components/cellar/quick-tasting-form";
import {
  DELTA_LABELS,
  STAGE_LABELS,
  overallScore,
  storageBandLabel,
  STORAGE_ANCHORS,
} from "@/lib/cellar";
import type { EditorLine } from "@/lib/editor-line";

/**
 * 茶仓条目详情：我的线 + 站长线对照。
 *
 * ## 两条线并排，永不合成
 *
 * PRD §4「永不平均」：站长线 / 社区带 / 我的线分开呈现，**不得合成总分**。
 * 所以这里并排展示两条线，不给一个「综合评价」。站长线是「一个人、一个
 * 家庭仓」的记录，我的线是「我自己的仓」，两者口径本来就不同 ——
 * 合成一个数会把两件事搅在一起。
 *
 * 站长线只在**这款茶已在茶品库里**时才有（`teaId`）。自建茶品还没并入
 * 茶品库之前，没有站长线可对照 —— 那一栏不显示，而不是显示「暂无」。
 */

interface TastingRow {
  id: string;
  tastedAt: string;
  stage: string | null;
  deltaVsPrev: string | null;
  dims: Record<string, number> | null;
  descriptors: string[];
  grams: number | null;
  vessel: string | null;
  note: string | null;
  visibility: string;
  elapsedSeconds: number | null;
}

interface EpochRow {
  id: string;
  startsAt: string;
  storageScore: number | null;
  assessedBy: string;
  city: string | null;
  container: string | null;
  legacyStorageLabel: string | null;
}

interface ItemData {
  id: string;
  name: string | null;
  teaId: string | null;
  tea: { id: string; name: string; year: number; brand: string; type: string } | null;
  acquiredAt: string | null;
  qtyNote: string | null;
  remindEveryMonths: number;
  epochs: EpochRow[];
  tastings: TastingRow[];
}

export default function CellarDetail({
  item: initialItem,
  editorLine,
}: {
  item: ItemData;
  editorLine: EditorLine | null;
}) {
  const [item, setItem] = useState(initialItem);
  const [vocab, setVocab] = useState<string[]>([]);
  const [showStorage, setShowStorage] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cellar/${initialItem.id}`);
      const data = await res.json();
      if (res.ok && data?.id) setItem(data as ItemData);
    } catch {
      // 保留初始数据 —— 刷新失败不该把页面清空
    }
  }, [initialItem.id]);

  useEffect(() => {
    load();
  }, [load]);

  // 描述词库：按这款茶的生熟取；取不到就空着（点选是可选功能）。
  useEffect(() => {
    const cat = item.tea?.type === "ripe" ? "ripe" : "raw";
    fetch(`/api/cellar/vocab?category=${cat}`)
      .then((r) => r.json())
      .then((d) => {
        const entries = Array.isArray(d.entries) ? d.entries : [];
        setVocab(entries.map((e: { tag: string }) => e.tag));
      })
      .catch(() => setVocab([]));
  }, [item.tea?.type]);

  const last = item.tastings[item.tastings.length - 1] ?? null;
  const currentEpoch = item.epochs[item.epochs.length - 1] ?? null;

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <Link
        href="/tea-cellar"
        className="text-xs text-stone-500 hover:text-amber-700 transition"
      >
        ← 我的茶仓
      </Link>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mt-2 mb-1">
        {item.tea?.name || item.name || "未命名"}
      </h1>
      <p className="text-xs text-stone-400 mb-6">
        {[
          item.tea?.brand,
          item.tea?.year,
          item.tea?.type === "ripe" ? "熟茶" : item.tea?.type === "raw" ? "生茶" : null,
          item.acquiredAt ? `入仓 ${item.acquiredAt.slice(0, 10)}` : null,
          item.qtyNote,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {message && (
        <p className="mb-4 text-sm px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
          {message}
        </p>
      )}

      <div className="grid md:grid-cols-5 gap-6">
        {/* 左：快速品鉴 + 我的线 */}
        <div className="md:col-span-3 space-y-6">
          <QuickTastingForm
            itemId={item.id}
            defaults={{
              grams: last?.grams ?? null,
              vessel: last?.vessel ?? null,
              descriptors: last?.descriptors ?? [],
              hasPrevious: item.tastings.length > 0,
              previousDescriptors: last?.descriptors ?? [],
            }}
            vocab={vocab}
            onSaved={load}
          />

          {/* 仓储 */}
          <section className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-stone-800">仓储</h2>
              <button
                onClick={() => setShowStorage((v) => !v)}
                className="text-xs text-stone-500 hover:text-amber-700 transition"
              >
                {showStorage ? "收起" : currentEpoch ? "换仓" : "登记仓储"}
              </button>
            </div>

            {currentEpoch ? (
              <div className="text-sm text-stone-600 space-y-1">
                <p>
                  {currentEpoch.storageScore != null ? (
                    <>
                      <span className="font-medium text-stone-800">
                        {currentEpoch.storageScore}{" "}
                        {storageBandLabel(currentEpoch.storageScore)}
                      </span>
                      <span className="text-xs text-stone-400 ml-1.5">
                        （{currentEpoch.assessedBy === "editor" ? "站长评" : "自评"}）
                      </span>
                    </>
                  ) : (
                    <span className="text-stone-400">仓储未评分</span>
                  )}
                </p>
                <p className="text-xs text-stone-400">
                  自 {currentEpoch.startsAt.slice(0, 10)} 起
                  {currentEpoch.city ? ` · ${currentEpoch.city}` : ""}
                  {currentEpoch.container ? ` · ${currentEpoch.container}` : ""}
                </p>
                {item.epochs.length > 1 && (
                  <details className="text-xs text-stone-400">
                    <summary className="cursor-pointer">
                      换过 {item.epochs.length - 1} 次仓
                    </summary>
                    <ul className="mt-1.5 space-y-1 pl-3 border-l border-stone-200">
                      {item.epochs
                        .slice()
                        .reverse()
                        .map((e) => (
                          <li key={e.id}>
                            {e.startsAt.slice(0, 10)} ·{" "}
                            {e.storageScore != null
                              ? `${e.storageScore} ${storageBandLabel(e.storageScore)}`
                              : "未评分"}
                            {e.city ? ` · ${e.city}` : ""}
                            {e.container ? ` · ${e.container}` : ""}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-stone-400">还没登记仓储</p>
            )}

            {showStorage && (
              <StorageForm
                itemId={item.id}
                currentScore={currentEpoch?.storageScore ?? null}
                onSaved={(msg) => {
                  setMessage(msg);
                  setShowStorage(false);
                  load();
                }}
              />
            )}
          </section>

          {/* 我的线 */}
          <section>
            <h2 className="text-lg font-serif font-bold text-stone-800 mb-1">
              我的品鉴线 ({item.tastings.length})
            </h2>
            <p className="text-xs text-stone-400 mb-4">
              你自己的记录，按时间排列
            </p>
            {item.tastings.length === 0 ? (
              <p className="text-center text-stone-400 py-8 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
                还没有品鉴记录
              </p>
            ) : (
              <div className="relative border-l-2 border-amber-200 ml-2 space-y-4">
                {item.tastings
                  .slice()
                  .reverse()
                  .map((t) => (
                    <TastingItem key={t.id} t={t} />
                  ))}
              </div>
            )}
          </section>
        </div>

        {/* 右：站长线对照 */}
        <div className="md:col-span-2">
          {item.teaId ? (
            <div>
              <h2 className="text-lg font-serif font-bold text-stone-800 mb-1">
                站长线对照
              </h2>
              <p className="text-xs text-stone-400 mb-4">
                站长在这款茶上的一手记录，与你的线分开呈现
              </p>
              {editorLine ? (
                <EditorLineView
                  tastings={editorLine.tastings}
                  statement={editorLine.statement}
                  showEmpty={false}
                />
              ) : (
                <p className="text-xs text-stone-400 bg-white rounded-lg border border-stone-200 p-3">
                  站长还没在这款茶上留过品鉴记录。
                </p>
              )}
              {item.tea && (
                <Link
                  href={`/tea/${item.tea.id}`}
                  className="text-xs text-amber-700 hover:underline"
                >
                  查看茶品页 →
                </Link>
              )}
            </div>
          ) : (
            <div className="bg-stone-100 rounded-xl p-4 text-xs text-stone-500">
              <p className="font-medium text-stone-600 mb-1">还没有站长线可对照</p>
              <p>
                这条自建茶品还没并入站内茶品库，并入之后就能对照站长的品鉴了。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TastingItem({ t }: { t: TastingRow }) {
  const score = overallScore(t.dims);
  const stage = t.stage ? STAGE_LABELS[t.stage as keyof typeof STAGE_LABELS] : null;
  const delta = t.deltaVsPrev
    ? DELTA_LABELS[t.deltaVsPrev as keyof typeof DELTA_LABELS]
    : null;

  return (
    <div className="relative pl-6">
      <span className="absolute -left-[9px] top-2 w-4 h-4 rounded-full bg-amber-700 border-2 border-white" />
      <div className="bg-white border border-stone-200 rounded-lg p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-stone-400">
            {t.tastedAt.slice(0, 10)}
          </span>
          {stage && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800">
              {stage}
            </span>
          )}
          {delta && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded border border-stone-200 bg-stone-50 text-stone-600">
              {delta}
            </span>
          )}
          {score != null && (
            <span className="text-xs text-amber-700">★ {score}</span>
          )}
        </div>

        {t.dims && Object.keys(t.dims).length > 0 && (
          <p className="text-xs text-stone-400 mt-1">
            {[
              t.dims.aroma != null ? `香气 ${t.dims.aroma}` : null,
              t.dims.flavor != null ? `滋味 ${t.dims.flavor}` : null,
              t.dims.waterPath != null ? `水路 ${t.dims.waterPath}` : null,
              t.dims.bodyFeel != null ? `体感 ${t.dims.bodyFeel}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}

        {t.descriptors.length > 0 && (
          <p className="text-xs text-stone-500 mt-1">{t.descriptors.join(" / ")}</p>
        )}

        {(t.grams != null || t.vessel) && (
          <p className="text-[0.7rem] text-stone-400 mt-1">
            {t.grams != null && `${t.grams} 克`}
            {t.grams != null && t.vessel && " · "}
            {t.vessel && `${t.vessel} 冲泡`}
          </p>
        )}

        {t.note && (
          <p className="text-xs text-stone-600 mt-1.5 leading-relaxed whitespace-pre-wrap">
            {t.note}
          </p>
        )}
      </div>
    </div>
  );
}

/** 换仓 / 登记仓储。 */
function StorageForm({
  itemId,
  currentScore,
  onSaved,
}: {
  itemId: string;
  currentScore: number | null;
  onSaved: (message: string) => void;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [city, setCity] = useState("");
  const [container, setContainer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/cellar/${itemId}/storage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageScore: score,
          city: city.trim() || null,
          container: container.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "保存失败");
        return;
      }
      onSaved("仓储已更新");
    } catch {
      setError("保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-stone-100">
      <p className="text-xs text-stone-500 mb-2">
        {currentScore != null ? "换仓（新增一段仓储期，旧的保留）" : "登记仓储"}
      </p>
      <div className="flex gap-2 flex-wrap mb-2">
        {STORAGE_ANCHORS.map((a) => (
          <button
            key={a.score}
            onClick={() => setScore(score === a.score ? null : a.score)}
            title={a.desc}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition ${
              score === a.score
                ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                : "border-stone-200 text-stone-600 hover:border-amber-300"
            }`}
          >
            {a.score} {a.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="城市（可选）"
          className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
        />
        <input
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          placeholder="容器（可选）"
          className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
        />
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="w-full mt-3 py-2 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition disabled:opacity-40"
      >
        {busy ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
