"use client";

import { useEffect, useRef, useState } from "react";

interface AiComposePanelProps {
  /** 当前标题（可为空）—— 只作为上下文传给模型，不让它生成标题 */
  title: string;
  boardName: string;
  tea: { id: string; name: string; brand: string; year: number } | null;
  /** 当前正文 HTML —— 判断会不会覆盖已有内容，以及生成期间是否被改过 */
  content: string;
  onDraft: (html: string) => void;
  onClose: () => void;
}

/** 正文里有没有实际内容：纯文字、图片、视频都算「有」，别静默覆盖。 */
function hasSubstance(html: string): boolean {
  if (/<(img|video)\b/i.test(html)) return true;
  return html.replace(/<[^>]*>/g, "").trim().length > 0;
}

/**
 * 发帖页的「AI 创作」面板（2026-11-06）。
 *
 * 可见性由服务端判定后经 `canUseAI` 传下来（/forum/new/page.tsx），
 * 本组件不做任何权限判断 —— 客户端拿不到 EDITOR_AUTHOR_UIDS，也不该抄一份。
 * 真正的闸门在 `POST /api/ai/compose`（站长 uid 白名单 / admin）。
 *
 * 产出是一段 HTML 正文：父组件的 RichEditor 会通过受控 value 自动刷新，
 * 这与后台草稿重写（admin/drafts）的「生成后原地替换」是同一套交互。
 */
export default function AiComposePanel({
  title,
  boardName,
  tea,
  content,
  onDraft,
  onClose,
}: AiComposePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // 一直指向最新正文：await 期间 prop 会变，闭包里的 content 是发起时的旧值。
  // 不能在 render 里写 ref（react-hooks/refs），放进 effect（每次渲染后同步一次）。
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // 面板被收起 / 卸载 = 用户放弃这次生成。请求必须跟着取消，否则
  // 10–25 秒后响应回来照样会 onDraft 覆盖正文，而且错误只能落在已卸载组件上。
  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    const idea = prompt.trim();
    if (!idea) {
      setError("请先写下想写的内容");
      return;
    }
    // 先确认再生成：正文已有内容时，先花 10–25 秒生成再问「要不要替换」，
    // 用户一旦点取消，这次模型调用就白烧了。
    const startedWith = contentRef.current;
    if (hasSubstance(startedWith) && !window.confirm("AI 初稿将替换当前正文，是否继续？")) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/ai/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: idea,
          title: title.trim() || undefined,
          boardName: boardName || undefined,
          tea: tea
            ? {
                name: tea.name,
                brand: tea.brand || undefined,
                year: tea.year >= 1900 && tea.year <= 2100 ? tea.year : undefined,
              }
            : undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "AI 创作失败");
      const html = typeof body?.html === "string" ? body.html : "";
      if (!html.trim()) throw new Error("AI 没有返回内容，请重试");

      // 生成期间作者又改了正文：再确认一次，别把这段等待里写的东西静默冲掉
      if (
        contentRef.current !== startedWith &&
        !window.confirm("正文在生成期间有改动，仍要用 AI 初稿替换吗？")
      ) {
        return;
      }

      onDraft(html);
      onClose();
    } catch (err) {
      // 收起面板 / 主动取消：不是失败，别报错
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "AI 创作失败");
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const hasContext = Boolean(title.trim() || boardName || tea);

  return (
    <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
      <p className="text-xs text-stone-500 mb-2">
        写下你想要的帖子内容，AI 会生成一篇初稿放进正文，你可以继续修改。
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={500}
        rows={3}
        disabled={busy}
        placeholder="想写什么？例如：分享今天喝的一泡 2019 冰岛生普，回甘明显，顺带聊聊仓储…"
        className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 disabled:opacity-60"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-stone-400">
          {hasContext ? "已带上标题 / 版块 / 关联茶品作为参考 · " : ""}
          {prompt.length}/500
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded-lg text-stone-600 hover:text-stone-800 disabled:opacity-50"
          >
            收起
          </button>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="text-xs px-3 py-1 rounded-lg bg-amber-800 text-white hover:bg-amber-900 transition disabled:opacity-60"
          >
            {busy ? "AI 创作中…" : "生成初稿"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
