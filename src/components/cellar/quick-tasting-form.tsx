"use client";

import { useEffect, useRef, useState } from "react";
import { DELTA_LABELS, STAGE_LABELS } from "@/lib/tasting-extract/vocab";
import { DELTAS, STAGES } from "@/lib/tasting-extract/vocab";
import type { Delta, Stage } from "@/lib/tasting-extract/vocab";
import {
  buildTastingTags,
  CELLAR_MAX_DIM_TAGS,
  CELLAR_MAX_ELAPSED_SECONDS,
  CELLAR_MAX_VIDEOS,
  DIM_KEYS,
  DIM_LABELS,
  DIM_MAX,
  DIM_MIN,
  formatWaitRemaining,
  formatWaitMessage,
  overallScore,
  parseDims,
  tastingWaitRemainingMs,
  TASTING_MIN_INTERVAL_MS,
  toggleDimTag as toggleDimTagPure,
  type DimKey,
} from "@/lib/cellar";
import { uploadWithRetry } from "@/lib/upload-client";
import { VIDEO_ACCEPT } from "@/lib/upload-types";
import { resolveUploadFile } from "@/lib/upload-mime";
import ImageUploadGrid from "@/components/sessions/image-upload-grid";

/**
 * 品鉴记录（一个表单，两种展开度）。
 *
 * ## 为什么是「一个表单，两种展开度」
 *
 * 站长要的是两种东西：一种**快速品鉴**（几秒点完），一种**详细记录**
 * （整段文字 + 图片 + 视频）。但它们**是同一条记录** —— 不是两个入口、
 * 两种记录。所以这里做成一个表单：快速项默认展开，详细项点开展开，
 * 最后**一次保存写成一条**。
 *
 * 分成两个表单会有两个后果：用户要决定「这次记哪种」，而记完快速品鉴
 * 又想补张图时，只能再记一条 —— 那就变成两次品鉴，间隔规则立刻挡路。
 *
 * ## 四维：关键词 + 手动录入
 *
 * 每个维度一行 = 一行**关键词芯片**（取词库按维度分好的词）+ 一个
 * **1–10 手动数字输入**。芯片选中的词记进 `dimTags`（保留「属于哪一维」），
 * 同时并进扁平的 `descriptors`（导出格式依赖它）。
 *
 * ## 24 小时间隔
 *
 * 同一条茶的两次品鉴至少隔一天（2026-10-24 站长要求）。间隔按**服务端
 * 写入的 createdAt** 算，客户端传来的 tastedAt 伪造不了 —— 所以前端
 * 的倒计时只是提前告知，真正的闸门在服务端（409）。
 */

// 四维的 key 与中文标签只有一份 —— 在 `src/lib/cellar.ts`（DIM_KEYS /
// DIM_LABELS）。阶段/对照的取值也只有一份 —— 在 F1 的词表里。
const DIM_FIELDS = DIM_KEYS.map((key) => ({ key, label: DIM_LABELS[key] }));

/** 每个维度先显示几个词。词库最多的「滋味」有七十多个，全铺出来没法看。 */
const CHIPS_PREVIEW = 6;

/**
 * 视频的白名单与大小上限。
 *
 * MIME 列表与服务端（`upload-policy.ts`）共用一份 `upload-types.ts` ——
 * 之前评论区和茶仓各拼一遍，改了一处就会「提示说支持、服务端拒收」。
 *
 * 大小上限比服务端（100MB）小一半：手机拍的茶汤视频没必要传那么大，
 * 而 100MB 的片子要排队等 ffmpeg 转码，转码并发只有 2。
 */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export interface QuickTastingDefaults {
  grams: number | null;
  vessel: string | null;
  /** 上次有没有品鉴过（决定要不要问「比上次」）。 */
  hasPrevious: boolean;
  /** 上次的描述词（带出供参考，不默认选中）。 */
  previousDescriptors: string[];
  /**
   * 上一次品鉴记录的**创建时刻**（服务端写的，ISO 字符串）。
   *
   * 24 小时间隔按它算 —— 不能用 `tastedAt`（客户端给的，能伪造）。
   */
  lastCreatedAt: string | null;
}

/**
 * 一摞关键词芯片。
 *
 * 维度里的与通用的共用这一份 —— 两处各写一遍的话，改了形状忘了另一处，
 * 两摞芯片就会长得不一样。
 */
function ChipRow({
  tags,
  selected,
  onToggle,
  expanded,
  labelledBy,
}: {
  tags: string[];
  selected: string[];
  onToggle: (tag: string) => void;
  expanded: boolean;
  /** 指向维度标签的 id —— 让读屏软件念出这摞词属于哪一维。 */
  labelledBy?: string;
}) {
  if (tags.length === 0) return null;
  const shown = expanded ? tags : tags.slice(0, CHIPS_PREVIEW);
  return (
    <div
      className="flex flex-wrap gap-1.5 mt-1.5"
      role={labelledBy ? "group" : undefined}
      aria-labelledby={labelledBy}
    >
      {shown.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onToggle(tag)}
          aria-pressed={selected.includes(tag)}
          className={`px-2.5 min-h-[32px] inline-flex items-center text-xs rounded-full border transition ${
            selected.includes(tag)
              ? "border-amber-600 bg-amber-50 text-amber-800"
              : "border-stone-200 text-stone-500 hover:border-amber-300"
          }`}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}

export default function QuickTastingForm({
  itemId,
  defaults,
  vocabByDim = {},
  freeVocab = [],
  onSaved,
}: {
  itemId: string;
  defaults: QuickTastingDefaults;
  /** 按维度分好的关键词（每个维度自己的词）。 */
  vocabByDim?: Partial<Record<DimKey, string[]>>;
  /** 不属于任何维度的通用描述词。 */
  freeVocab?: string[];
  onSaved?: () => void;
}) {
  const [delta, setDelta] = useState<Delta | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [showDetailed, setShowDetailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // 四维分数。写进 state 的是**已校验**的整数 —— 服务端的 zod 会把
  // 越界/小数的整条请求打回 400，那样连合法的阶段、备注都存不进去。
  const [dims, setDims] = useState<Record<string, number>>({});
  // 报错**按维度**存 —— 四维是一块，笼统的报错会落在出错输入框下面
  // 好几行，读者根本不知道是哪一维错了。
  const [dimsError, setDimsError] = useState<Record<string, string>>({});
  // 按维度归类的关键词。
  const [dimTags, setDimTags] = useState<Record<string, string[]>>({});
  const [expandedDims, setExpandedDims] = useState<Record<string, boolean>>({});
  const [freeDescriptors, setFreeDescriptors] = useState<string[]>([]);
  const [showAllFree, setShowAllFree] = useState(false);
  const [note, setNote] = useState("");
  const [grams, setGrams] = useState<string>(
    defaults.grams != null ? String(defaults.grams) : "",
  );
  const [vessel, setVessel] = useState(defaults.vessel ?? "");
  const [images, setImages] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>([]);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  /** 服务端说的「最早可记时刻」（客户端时钟的毫秒数）。 */
  const [serverAllowedAt, setServerAllowedAt] = useState<number | null>(null);
  /** 维度词选到上限时的提示。 */
  const [dimTagError, setDimTagError] = useState("");
  // 视频的错误**就地显示** —— 共用卡片底部那个槽位的话，手机上要滚一屏
  // 才看得到，而视频输入在折叠区里。
  const [videoError, setVideoError] = useState("");

  // 计时起点放在 effect 里设（渲染期间调 Date.now() 是不纯的 —— React
  // 19 的 lint 会拦）。用户点保存时 effect 早就跑过了。
  const startedAt = useRef<number>(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  /**
   * 倒计时的「现在」。
   *
   * 每分钟刷新一次，好让「还需 12 小时」真的在走 —— 否则页面开着不动，
   * 提示会一直停在打开那一刻的数字上。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  /**
   * 计数基准取整到**分钟**。
   *
   * 服务端渲染与客户端 hydration 之间差的那几百毫秒，会让「还需 N 小时」
   * 在临界点上变样 —— 触发 React 的 hydration 不一致警告。取整到分钟后
   * 这点差异就消失了（倒计时本来就是每分钟跳一次）。
   */
  const nowMinute = Math.floor(now / 60_000) * 60_000;
  const localWait = tastingWaitRemainingMs(
    defaults.lastCreatedAt,
    new Date(nowMinute),
  );
  /**
   * 服务端 409 时给的权威剩余时间。
   *
   * 浏览器时钟可能与服务端差几分钟 —— 客户端觉得「能记了」，服务端说
   * 「还差 20 分钟」，那用户就只能反复点、反复看 409。收到 409 就把
   * 「可记时刻」按服务端的数字重算一次，按钮就老实等着了。
   */
  const serverWait =
    serverAllowedAt === null ? null : Math.max(0, serverAllowedAt - nowMinute);
  const waitMs = serverWait ?? localWait;
  const canRecord = waitMs === null;
  const waitText = waitMs === null ? null : formatWaitRemaining(waitMs);

  const handleToggleDimTag = (dim: string, tag: string) => {
    const cur = dimTags[dim] ?? [];
    if (!cur.includes(tag) && cur.length >= CELLAR_MAX_DIM_TAGS) {
      setDimTagError(
        `「${DIM_LABELS[dim as DimKey]}」最多选 ${CELLAR_MAX_DIM_TAGS} 个词`,
      );
      return;
    }
    setDimTagError("");
    setDimTags((prev) => toggleDimTagPure(prev, dim, tag));
  };

  const toggleFree = (tag: string) => {
    setFreeDescriptors((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const canSave =
    stage !== null &&
    (defaults.hasPrevious ? delta !== null : true) &&
    canRecord;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload: Record<string, unknown> = {
        stage,
        // 夹到服务端的上限：页面开久了（>24h）再记一条，原始值会被 400 打回，
        // 白白丢掉那一次品鉴。
        elapsedSeconds: Math.max(
          0,
          Math.min(
            CELLAR_MAX_ELAPSED_SECONDS,
            Math.round((Date.now() - startedAt.current) / 1000),
          ),
        ),
      };
      if (defaults.hasPrevious && delta) payload.deltaVsPrev = delta;
      if (Object.keys(dims).length) {
        // 兜一遍：客户端已经拦过越界与小数，这里防的是将来加字段时漏校验。
        const parsed = parseDims(dims);
        if (parsed.errors.length) {
          setError(parsed.errors.join("；"));
          return;
        }
        payload.dims = parsed.dims ?? undefined;
      }
      // 按维度归类的关键词 + 通用描述词 → dimTags 与扁平的 descriptors。
      // 夹上限在这一个纯函数里做（buildTastingTags），与服务端共用常量。
      const tags = buildTastingTags(dimTags, freeDescriptors);
      if (tags.descriptors.length) payload.descriptors = tags.descriptors;
      if (Object.keys(tags.dimTags).length) payload.dimTags = tags.dimTags;
      if (note.trim()) payload.note = note.trim();
      if (grams.trim()) payload.grams = Number(grams);
      if (vessel.trim()) payload.vessel = vessel.trim();
      if (images.length) payload.images = images;
      if (videos.length) payload.videos = videos;

      const res = await fetch(`/api/cellar/${itemId}/tastings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "保存失败");
        // 409 带着服务端算的剩余毫秒数 —— 用它把倒计时校正到服务端的时钟。
        if (res.status === 409 && typeof data.waitMs === "number") {
          setServerAllowedAt(Date.now() + data.waitMs);
        }
        return;
      }
      setMessage("已记录");
      // 刚存完一条 —— 下一条要等 24 小时。这里直接按服务的间隔常量算，
      // 不等父组件把新数据取回来（那之前按钮会短暂地又能点了）。
      setServerAllowedAt(Date.now() + TASTING_MIN_INTERVAL_MS);
      setDelta(null);
      setStage(null);
      setDims({});
      setDimsError({});
      setDimTags({});
      setFreeDescriptors([]);
      setNote("");
      setImages([]);
      setVideos([]);
      setVideoError("");
      setShowDetailed(false);
      startedAt.current = Date.now();
      onSaved?.();
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 与服务端同一份白名单；浏览器不给 type 时按扩展名补
    const resolved = resolveUploadFile(file, "video");
    if (!resolved) {
      setVideoError("只支持 MP4 / WebM / QuickTime(.mov) 视频");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setVideoError(`视频太大了（上限 ${MAX_VIDEO_BYTES / 1024 / 1024}MB）`);
      e.target.value = "";
      return;
    }
    setUploadingVideo(true);
    setVideoError("");
    try {
      const { url } = await uploadWithRetry(resolved.file, undefined, 3, "tea");
      setVideos((prev) => [...prev, url]);
    } catch (err) {
      setVideoError(
        err instanceof Error && err.message ? `视频上传失败：${err.message}` : "视频上传失败",
      );
    } finally {
      setUploadingVideo(false);
      e.target.value = "";
    }
  };

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-stone-800 shrink-0">记一条品鉴</h3>
        <button
          onClick={() => setShowDetailed((v) => !v)}
          aria-expanded={showDetailed}
          className="min-h-[44px] inline-flex items-center gap-1 px-2 -mr-2 rounded text-xs text-stone-600 hover:text-amber-700 transition"
        >
          {showDetailed ? "收起详细记录" : "详细记录"}
          <span aria-hidden="true">{showDetailed ? "▴" : "▾"}</span>
        </button>
      </div>

      {/* ① 比上次 —— 首次品鉴不显示 */}
      {defaults.hasPrevious && (
        <div className="mb-4">
          <p className="text-xs text-stone-500 mb-1.5">比上次</p>
          <div className="flex gap-2">
            {DELTAS.map((d) => (
              <button
                key={d}
                onClick={() => setDelta(d === delta ? null : d)}
                className={`flex-1 py-2 text-sm rounded-lg border transition ${
                  delta === d
                    ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                    : "border-stone-200 text-stone-600 hover:border-amber-300"
                }`}
              >
                {DELTA_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ② 状态阶段 */}
      <div className="mb-4">
        <p className="text-xs text-stone-500 mb-1.5">状态阶段</p>
        <div className="flex gap-2 flex-wrap">
          {STAGES.map((s) => (
            <button
              key={s}
              onClick={() => setStage(s === stage ? null : s)}
              className={`flex-1 min-w-[4.5rem] py-2 text-sm rounded-lg border transition ${
                stage === s
                  ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                  : "border-stone-200 text-stone-600 hover:border-amber-300"
              }`}
            >
              {STAGE_LABELS[s]}
            </button>
          ))}
        </div>
        {stage === null && (
          <p className="text-[0.7rem] text-stone-400 mt-1.5">
            选一个阶段才能保存
          </p>
        )}
      </div>

      {/* ③ 四维：关键词 + 手动打分 */}
      <div className="mb-4">
        <p className="text-xs text-stone-500 mb-1.5">
          四维（选关键词，或直接打 1–10 分）
        </p>
        <div className="space-y-3">
          {DIM_FIELDS.map((f) => {
            const chips = vocabByDim[f.key] ?? [];
            const selected = dimTags[f.key] ?? [];
            const expanded = expandedDims[f.key] === true;
            const dimId = `cellar-dim-${f.key}`;
            const err = dimsError[f.key];
            return (
              <div key={f.key}>
                <div className="flex items-center gap-2">
                  <span id={dimId} className="text-stone-600 w-12 shrink-0 text-sm">
                    {f.label}
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={DIM_MIN}
                    max={DIM_MAX}
                    step={1}
                    value={dims[f.key] ?? ""}
                    aria-invalid={err ? true : undefined}
                    aria-label={`${f.label}评分`}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) {
                        setDimsError((p) => {
                          const n = { ...p };
                          delete n[f.key];
                          return n;
                        });
                        setDims((prev) => {
                          const next = { ...prev };
                          delete next[f.key];
                          return next;
                        });
                        return;
                      }
                      const n = Number(v);
                      if (!Number.isInteger(n) || n < DIM_MIN || n > DIM_MAX) {
                        setDimsError((p) => ({
                          ...p,
                          [f.key]: `${f.label}要在 ${DIM_MIN}–${DIM_MAX} 之间（整数）`,
                        }));
                        return;
                      }
                      setDimsError((p) => {
                        const n = { ...p };
                        delete n[f.key];
                        return n;
                      });
                      setDims((prev) => ({ ...prev, [f.key]: n }));
                    }}
                    className={`w-20 px-2 py-1.5 border rounded text-sm ${
                      err ? "border-red-300" : "border-stone-200"
                    }`}
                  />
                  {dims[f.key] != null && (
                    <span className="text-xs text-stone-400">
                      {dims[f.key]}/10
                    </span>
                  )}
                  {/* 更多/收起放在标签旁边 —— 放在词摞末尾的话，展开七十多个词
                      之后它就被埋在最底下，滚半天都够不着。 */}
                  {chips.length > CHIPS_PREVIEW && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedDims((prev) => ({
                          ...prev,
                          [f.key]: !expanded,
                        }))
                      }
                      className="ml-auto text-xs text-amber-700 hover:underline"
                    >
                      {expanded ? "收起词" : `更多词（${chips.length}）`}
                    </button>
                  )}
                </div>
                {err && <p className="text-[0.7rem] text-red-600 mt-1">{err}</p>}
                <div className="ml-14">
                  <ChipRow
                    tags={chips}
                    selected={selected}
                    onToggle={(tag) => handleToggleDimTag(f.key, tag)}
                    expanded={expanded}
                    labelledBy={dimId}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {dimTagError && (
          <p className="text-[0.7rem] text-red-600 mt-1.5">{dimTagError}</p>
        )}
        {overallScore(dims) !== null && (
          <p className="text-[0.7rem] text-stone-400 mt-1.5">
            综合分 {overallScore(dims)}
          </p>
        )}
      </div>

      {/* ④ 详细记录 */}
      {showDetailed && (
        <div className="mb-4 pt-4 border-t border-stone-100 space-y-4">
          {defaults.previousDescriptors.length > 0 && (
            <p className="text-[0.7rem] text-stone-400">
              上次写的：{defaults.previousDescriptors.join(" / ")}
              <span className="ml-1">（只是参考，不默认勾选）</span>
            </p>
          )}

          {/* 整段文字 —— 可以粘贴 */}
          <label className="block text-sm">
            <span className="text-xs text-stone-500">这次的口感（可写一整段）</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              placeholder="这一泡从干杯到见底的变化、跟上次比差在哪、哪一段最值得记下来…"
              className="w-full mt-1 px-3 py-2 border border-stone-200 rounded text-sm resize-y leading-relaxed"
            />
          </label>

          {/* 通用描述词 */}
          {freeVocab.length > 0 && (
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xs text-stone-500">其他描述词</p>
                {freeVocab.length > CHIPS_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setShowAllFree((v) => !v)}
                    className="ml-auto text-xs text-amber-700 hover:underline"
                  >
                    {showAllFree ? "收起词" : `更多词（${freeVocab.length}）`}
                  </button>
                )}
              </div>
              <ChipRow
                tags={freeVocab}
                selected={freeDescriptors}
                onToggle={toggleFree}
                expanded={showAllFree}
              />
            </div>
          )}

          {/* 克重 / 器具 */}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-xs text-stone-500">投茶量（克）</span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                max={100}
                step={0.5}
                value={grams}
                onChange={(e) => setGrams(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 border border-stone-200 rounded text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-stone-500">器具</span>
              <input
                value={vessel}
                onChange={(e) => setVessel(e.target.value)}
                placeholder="盖碗"
                className="w-full mt-1 px-2 py-1.5 border border-stone-200 rounded text-sm"
              />
            </label>
          </div>

          {/* 图片 */}
          <div>
            <p className="text-xs text-stone-500 mb-1.5">图片</p>
            <ImageUploadGrid
              value={images}
              onChange={setImages}
              maxImages={9}
              category="tea"
              showCoverBadge={false}
            />
          </div>

          {/* 视频 */}
          <div>
            <p className="text-xs text-stone-500 mb-1.5">
              视频（最多 {CELLAR_MAX_VIDEOS} 段，MP4 / WebM / QuickTime）
            </p>
            <input
              type="file"
              accept={VIDEO_ACCEPT}
              onChange={handleVideo}
              disabled={uploadingVideo || videos.length >= 3}
              className="block w-full text-xs text-stone-600 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border file:border-stone-300 file:bg-white file:text-xs"
            />
            {uploadingVideo && (
              <p className="text-[0.7rem] text-stone-400 mt-1">上传中…</p>
            )}
            {videoError && (
              <p className="text-[0.7rem] text-red-600 mt-1">{videoError}</p>
            )}
            {videos.length > 0 && (
              <div className="mt-2 space-y-2">
                {videos.map((url) => (
                  <div key={url} className="flex items-center gap-2">
                    <video
                      src={url}
                      controls
                      className="w-28 h-20 rounded bg-stone-100 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setVideos((prev) => prev.filter((u) => u !== url))}
                      className="min-h-[44px] inline-flex items-center text-[0.7rem] text-stone-500 hover:text-red-600"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑤ 保存 —— 一次保存写成一条记录 */}
      {waitText && (
        <p className="text-xs text-amber-800 text-center mb-2">
          {formatWaitMessage(waitMs ?? 0)}
        </p>
      )}
      <button
        onClick={save}
        disabled={!canSave || saving}
        className="w-full py-2.5 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition disabled:opacity-40"
      >
        {saving ? "保存中…" : waitText ? waitText : "保存"}
      </button>

      {!defaults.hasPrevious && (
        <p className="text-[0.7rem] text-stone-400 mt-2 text-center">
          第一次品鉴没有「比上次」
        </p>
      )}

      {message && (
        <p className="text-xs text-emerald-700 mt-2 text-center">{message}</p>
      )}
      {error && (
        <p className="text-xs text-red-600 mt-2 text-center">{error}</p>
      )}
    </div>
  );
}
