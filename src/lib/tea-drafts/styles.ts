/**
 * Creative styles for the grounded rewrite (Phase D) — the "多种风格的创作"
 * half of the draft pipeline.
 *
 * Dispatch is deterministic: `styleFor(noteId)` is a pure hash of the note id,
 * so the same note is always rewritten the same way and a batch of notes
 * spreads across the whole set without anyone choosing. That is what makes the
 * rewrite reproducible and unit-testable, and it is also why the style does NOT
 * need to be persisted to drive a manual re-rewrite: the admin "重写" action can
 * recompute it from the note id alone.
 *
 * A style is only ever prompt text. It never reaches the title, the public
 * `tags`, or any scoring input — a draft's ranking must not depend on which
 * voice it happened to be written in.
 *
 * Pure: no DB, no network, no model. Safe under `node --test`.
 */

export interface TeaDraftStyle {
  /** Stable key — persisted in `Article.aiOriginal.style` for human display. */
  readonly key: StyleKey;
  /** Human label shown in the admin draft list. */
  readonly label: string;
  /** Voice/tone instruction appended to the rewrite prompt. */
  readonly voice: string;
}

export type StyleKey = "veteran" | "report" | "story" | "caveat" | "casual";

/**
 * The style set. Order is part of the contract only in that `STYLES[i]` must
 * stay at index `i` for `styleFor` to keep assigning the same style to a given
 * note; reordering silently re-voices every future draft, which is harmless for
 * content but breaks the "same note, same style" reproducibility the re-rewrite
 * action relies on. Append new styles at the end instead.
 */
export const STYLES: readonly TeaDraftStyle[] = [
  {
    key: "veteran",
    label: "老茶客口吻",
    voice:
      "语气像一位喝了多年普洱的老茶友在闲聊：口语、松弛，敢下判断，会说「这茶我不会再买」这类带个人偏好的话。不用小标题。",
  },
  {
    key: "report",
    label: "品鉴报告体",
    voice:
      "写成一份简短的品鉴记录：用小标题分「外观」「香气」「汤色」「口感」「叶底」几项，逐项一两句。只写笔记里实际观察到的项，没观察到的项直接省略，不要补写。",
  },
  {
    key: "story",
    label: "故事叙事",
    voice:
      "从这次开汤的场景写起（什么时候、在哪、和谁、用什么器具），按时间顺序写到喝完的感受，像在讲一件刚发生的事。",
  },
  {
    key: "caveat",
    label: "避坑测评",
    voice:
      "重点写不足与劝退点：哪里做得不好、什么情况下别买、什么人不适合。口感描述为辅。诚实地讲问题，不要为了凑好评而美化。",
  },
  {
    key: "casual",
    label: "日常分享",
    voice:
      "短平快，像发一条朋友圈：三五句话讲清这茶怎么样，语气轻，不要长篇大论，不要分段标题。",
  },
] as const;

/** Fast lookup by key. Built once at module load. */
const BY_KEY: ReadonlyMap<StyleKey, TeaDraftStyle> = new Map(
  STYLES.map((s) => [s.key, s] as const),
);

/**
 * The style for a key, or `null` if the key is not in the set.
 *
 * Accepts a missing key: `aiOriginal.style` is persisted JSON and predates the
 * style dispatch, so "absent" is a real state callers must be able to ask about
 * without first type-guarding. Absent and unknown are deliberately the same
 * answer — neither names a voice, so neither may be rendered as one.
 */
export function styleByKey(key: string | null | undefined): TeaDraftStyle | null {
  if (key == null) return null;
  return BY_KEY.get(key as StyleKey) ?? null;
}

/**
 * Deterministic style dispatch: `hash(noteId) % STYLES.length`.
 *
 * The hash is the classic `h = h*31 + c` in the `<<5` form, kept identical to
 * `hot-rank.ts`'s `jitterSeed`/`jitterAmount` so the codebase has one string
 * hash rather than three. `Math.abs` is taken before the modulo because the
 * accumulator is a signed 32-bit value and a negative remainder would index out
 * of the set.
 *
 * `Math.abs(-2147483648)` is `2147483648`, not representable as int32 — but it
 * is still a non-negative number and `% length` of it is in range, so it cannot
 * produce an out-of-bounds index either.
 */
export function styleFor(noteId: string): TeaDraftStyle {
  let h = 0;
  const s = typeof noteId === "string" ? noteId : "";
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return STYLES[Math.abs(h) % STYLES.length]!;
}
