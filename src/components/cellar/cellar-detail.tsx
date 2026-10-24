"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import EditorLineView from "@/components/tea/editor-line";
import QuickTastingForm from "@/components/cellar/quick-tasting-form";
import { overallScore, storageScoreLabel } from "@/lib/cellar";
import { DELTA_LABELS, STAGE_LABELS } from "@/lib/tasting-extract/vocab";
import StorageSlider from "@/components/cellar/storage-slider";
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
  const router = useRouter();
  const [item, setItem] = useState(initialItem);
  const [vocab, setVocab] = useState<string[]>([]);
  const [showStorage, setShowStorage] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
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

  // **不**在挂载时 load()：服务端组件已经把条目取好传进来了（useState 的
  // 初值），挂载再取一遍就是同一份数据取两次 —— 4 条 SQL 跑两遍。
  // load() 只在写操作之后调用（记完品鉴、换完仓）。

  // 描述词库：按这款茶的生熟取；取不到就空着（点选是可选功能）。
  useEffect(() => {
    const cat = item.tea?.type === "ripe" ? "ripe" : "raw";
    fetch(`/api/cellar/vocab?category=${cat}`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d) => {
        const entries = Array.isArray(d.entries) ? d.entries : [];
        setVocab(entries.map((e: { tag: string }) => e.tag));
      })
      .catch(() => setVocab([]));
  }, [item.tea?.type]);

  // 删条目：不可撤销，且会连带删掉全部品鉴记录 —— 所以要确认两次。
  const remove = async () => {
    if (
      !confirm(
        "删除这个条目？\n它的全部品鉴记录与仓储记录会一起删掉，不可撤销。",
      )
    ) {
      return;
    }
    const res = await fetch(`/api/cellar/${item.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "删除失败");
      return;
    }
    router.push("/tea-cellar");
  };

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
                        {storageScoreLabel(currentEpoch.storageScore)}
                      </span>
                      <span className="text-xs text-stone-400 ml-1.5">
                        （{currentEpoch.assessedBy === "editor" ? "站长评" : "自评"}）
                      </span>
                    </>
                  ) : (
                    <span className="text-stone-400">
                      仓储{storageScoreLabel(null)}
                    </span>
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
                            {storageScoreLabel(e.storageScore)}
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
                currentCity={currentEpoch?.city ?? null}
                currentContainer={currentEpoch?.container ?? null}
                onSaved={(msg) => {
                  setMessage(msg);
                  setShowStorage(false);
                  load();
                }}
              />
            )}
          </section>

          {/* 条目信息：改 / 删 */}
          <section className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-stone-800">条目信息</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowEdit((v) => !v)}
                  className="text-xs text-stone-500 hover:text-amber-700 transition"
                >
                  {showEdit ? "收起" : "编辑"}
                </button>
                <button
                  onClick={remove}
                  className="text-xs text-red-600 hover:underline transition"
                >
                  删除这个条目
                </button>
              </div>
            </div>

            {showEdit ? (
              <EditItemForm
                item={item}
                onSaved={(msg) => {
                  setMessage(msg);
                  setShowEdit(false);
                  load();
                }}
              />
            ) : (
              <div className="text-xs text-stone-400 space-y-1">
                <p>提醒间隔：每 {item.remindEveryMonths} 个月</p>
                {item.qtyNote && <p>备注：{item.qtyNote}</p>}
                {item.acquiredAt && (
                  <p>入仓：{item.acquiredAt.slice(0, 10)}</p>
                )}
              </div>
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
  currentCity,
  currentContainer,
  onSaved,
}: {
  itemId: string;
  currentScore: number | null;
  currentCity: string | null;
  currentContainer: string | null;
  onSaved: (message: string) => void;
}) {
  /**
   * 三项都**默认沿用当前仓储期**（没有则为空）。
   *
   * 跟快速品鉴的「可选项默认沿用上次」是同一个惯例（`nextTastingDefaults`）：
   * 换仓多半还是那个仓储条件，先把它摆出来让用户改，而不是让他从零再填一遍。
   *
   * ⚠️ 分数沿用了、城市和容器也必须一起沿用 —— 只沿用一半更糟：
   * 用户看到分数已经填好了，改一下就保存，于是**城市和容器被清空**，
   * 新仓储期看起来像是这条茶没在任何地方放过。
   *
   * 空的时候滑块会停在「标准仓」这个中性位置，读数写「未记录」——
   * 控件指着的数与「有没有记过」永远一致，不会出现「文字说没记、轨道却指着 50」。
   */
  const [score, setScore] = useState<number | null>(currentScore);
  const [city, setCity] = useState(currentCity ?? "");
  const [container, setContainer] = useState(currentContainer ?? "");
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
      <StorageSlider value={score} onChange={setScore} className="mb-2" />
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

/** 改条目：名字、入仓时间、备注、提醒间隔。 */
function EditItemForm({
  item,
  onSaved,
}: {
  item: ItemData;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(item.name ?? "");
  const [qtyNote, setQtyNote] = useState(item.qtyNote ?? "");
  const [acquiredAt, setAcquiredAt] = useState(
    item.acquiredAt ? item.acquiredAt.slice(0, 10) : "",
  );
  const [remindEveryMonths, setRemindEveryMonths] = useState(
    item.remindEveryMonths,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/cellar/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          qtyNote: qtyNote.trim() || null,
          acquiredAt: acquiredAt
            ? new Date(`${acquiredAt}T00:00:00.000Z`).toISOString()
            : null,
          remindEveryMonths,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "保存失败");
        return;
      }
      onSaved("已保存");
    } catch {
      setError("保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="text-xs text-stone-500">名称（自建茶用）</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-stone-500">备注（如「还剩半饼」）</span>
        <input
          value={qtyNote}
          onChange={(e) => setQtyNote(e.target.value)}
          className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="text-xs text-stone-500">入仓日期</span>
          <input
            type="date"
            value={acquiredAt}
            onChange={(e) => setAcquiredAt(e.target.value)}
            className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-stone-500">提醒间隔（月）</span>
          <input
            type="number"
            min={1}
            max={60}
            value={remindEveryMonths}
            onChange={(e) => setRemindEveryMonths(Number(e.target.value))}
            className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg text-sm"
          />
        </label>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="px-4 py-2 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 disabled:opacity-40"
      >
        {busy ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
