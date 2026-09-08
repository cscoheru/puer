"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { uploadWithRetry } from "@/lib/upload-client";
import { sanitizeHtml } from "@/lib/sanitize";

interface CommentAuthor {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
}

interface Comment {
  id: string;
  content: string;
  images: string[];
  createdAt: string;
  parentId: string | null;
  upvotes: number;
  downvotes: number;
  author: CommentAuthor;
  initialVote: number;
}

interface Props {
  tastingNoteId: string;
}

const EMOJI_QUICK = ["😀","😂","😊","🥰","😍","🤔","😏","🙄","😢","😭","😤","😡","👍","👎","👊","🙏","💪","🔥","✨","❤️","💛","💚","💙","💜","🎉","🍵","🫖","🍃","🌿","☕","🍪"];

const COLORS = ["#DC2626","#EA580C","#D97706","#65A30D","#16A34A","#0891B2","#2563EB","#7C3AED","#DB2777","#78716C"];

export default function TastingNoteComments({ tastingNoteId }: Props) {
  const { data: session } = useSession();
  const [comments, setComments] = useState<Comment[]>([]);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showColor, setShowColor] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaUpload, setMediaUpload] = useState<{ file: File; preview: string } | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/comments?tastingNoteId=${tastingNoteId}`);
      if (res.ok) setComments(await res.json());
    } catch {}
  }, [tastingNoteId]);

  useEffect(() => { fetchComments(); }, [fetchComments]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false);
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setShowColor(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function wrapSelection(ta: HTMLTextAreaElement, open: string, close: string): string {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(end);
    return before + open + (selected || "文本") + close + after;
  }

  const insertFormat = (open: string, close: string) => {
    if (!textRef.current) return;
    setContent(wrapSelection(textRef.current, open, close));
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const insertColor = (color: string) => {
    if (!textRef.current) return;
    setContent(wrapSelection(textRef.current, `<span style="color:${color}">`, "</span>"));
    setShowColor(false);
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const insertFontSize = (size: string) => {
    if (!textRef.current) return;
    setContent(wrapSelection(textRef.current, `<span style="font-size:${size}">`, "</span>"));
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const insertEmoji = (emoji: string) => {
    if (!textRef.current) return;
    const ta = textRef.current;
    const start = ta.selectionStart;
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(ta.selectionEnd);
    setContent(before + emoji + after);
    setShowEmoji(false);
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + emoji.length; }, 0);
  };

  const handleMediaSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm"];
    if (!allowed.includes(file.type)) return;

    const preview = URL.createObjectURL(file);
    setMediaUpload({ file, preview });
    setUploading(true);
    try {
      const result = await uploadWithRetry(file);
      setMediaUrl(result.url);
    } catch {
      setMediaUpload(null);
      setMediaUrl(null);
    } finally {
      setUploading(false);
    }
  };

  const removeMedia = () => {
    if (mediaUpload?.preview.startsWith("blob:")) URL.revokeObjectURL(mediaUpload.preview);
    setMediaUpload(null);
    setMediaUrl(null);
    const input = document.getElementById("tn-media-input") as HTMLInputElement | null;
    if (input) input.value = "";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const plainText = content.replace(/<[^>]*>/g, "").trim();
    if (!plainText || plainText.length < 5) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tastingNoteId,
          content: content.trim(),
          images: mediaUrl ? [mediaUrl] : [],
        }),
      });
      if (res.ok) {
        setContent("");
        setMediaUpload(null);
        setMediaUrl(null);
        fetchComments();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const rootComments = comments.filter((c) => !c.parentId);

  return (
    <div>
      {/* Comment form */}
      {session?.user ? (
        <form onSubmit={handleSubmit} className="mb-6">
          {/* Toolbar */}
          <div className="flex items-center gap-0.5 mb-1.5 flex-wrap">
            <button type="button" onClick={() => insertFormat("<b>", "</b>")} className="w-7 h-7 flex items-center justify-center text-sm font-bold text-stone-600 hover:bg-stone-100 rounded" title="粗体">B</button>
            <button type="button" onClick={() => insertFormat("<i>", "</i>")} className="w-7 h-7 flex items-center justify-center text-sm italic text-stone-600 hover:bg-stone-100 rounded" title="斜体"><i>I</i></button>
            <span className="w-px h-5 bg-stone-300 mx-1" />
            <button type="button" onClick={() => insertFontSize("0.85em")} className="w-7 h-7 flex items-center justify-center text-xs text-stone-600 hover:bg-stone-100 rounded" title="小字">A⁻</button>
            <button type="button" onClick={() => insertFontSize("1.3em")} className="w-7 h-7 flex items-center justify-center text-xs text-stone-600 hover:bg-stone-100 rounded" title="大字">A⁺</button>
            <span className="w-px h-5 bg-stone-300 mx-1" />
            <div className="relative" ref={colorRef}>
              <button type="button" onClick={() => setShowColor(!showColor)} className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded" title="文字颜色">
                <span className="w-3.5 h-3.5 rounded-full bg-gradient-to-br from-red-500 via-blue-500 to-green-500" />
              </button>
              {showColor && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-stone-200 rounded-lg shadow-lg p-2 flex gap-1 z-10">
                  {COLORS.map((c) => (
                    <button key={c} type="button" onClick={() => insertColor(c)} className="w-6 h-6 rounded-full border border-stone-300 hover:scale-110 transition" style={{ backgroundColor: c }} />
                  ))}
                </div>
              )}
            </div>
            <span className="w-px h-5 bg-stone-300 mx-1" />
            <div className="relative" ref={emojiRef}>
              <button type="button" onClick={() => setShowEmoji(!showEmoji)} className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded" title="表情">😊</button>
              {showEmoji && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-stone-200 rounded-lg shadow-lg p-2 z-10 w-[232px] flex flex-wrap gap-0.5">
                  {EMOJI_QUICK.map((e) => (
                    <button key={e} type="button" onClick={() => insertEmoji(e)} className="w-7 h-7 flex items-center justify-center text-base hover:bg-stone-100 rounded">{e}</button>
                  ))}
                </div>
              )}
            </div>

            {/* Media upload */}
            <label className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded cursor-pointer" title="上传图片">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              <input id="tn-media-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm" className="hidden" onChange={handleMediaSelect} />
            </label>
          </div>

          <textarea
            ref={textRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="写下你的评论...支持粗体、颜色、emoji 和图片"
            rows={3}
            maxLength={1000}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 resize-none"
          />

          {mediaUpload && (
            <div className="mt-2 relative inline-block">
              {mediaUpload.file.type.startsWith("video/") ? (
                <video src={mediaUpload.preview} className="h-20 rounded-lg border border-stone-200" />
              ) : (
                <img src={mediaUpload.preview} alt="" className="h-20 rounded-lg border border-stone-200" />
              )}
              <button type="button" onClick={removeMedia} disabled={uploading} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600 disabled:opacity-50">✕</button>
              {uploading && <div className="absolute inset-0 bg-black/30 rounded-lg flex items-center justify-center"><span className="text-white text-xs">上传中...</span></div>}
            </div>
          )}

          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-stone-400">{content.replace(/<[^>]*>/g, "").length}/1000</span>
            <button
              type="submit"
              disabled={submitting || content.replace(/<[^>]*>/g, "").trim().length < 5 || uploading}
              className="px-4 py-2 bg-amber-800 text-white rounded-lg text-sm hover:bg-amber-900 disabled:opacity-50 transition"
            >
              {submitting ? "提交中..." : "发表评论"}
            </button>
          </div>
        </form>
      ) : (
        <div className="mb-6 p-4 bg-stone-50 rounded-lg text-center text-sm text-stone-500">
          <Link href="/login" className="text-amber-700 hover:text-amber-800">登录</Link> 后可以评论
        </div>
      )}

      {/* Comments list */}
      {rootComments.length > 0 ? (
        <div className="space-y-4">
          {rootComments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </div>
      ) : (
        <p className="text-center text-stone-400 py-8 text-sm">暂无评论</p>
      )}
    </div>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-xs text-amber-700 overflow-hidden shrink-0">
        {comment.author.avatar ? (
          <img src={comment.author.avatar} alt="" className="w-full h-full object-cover" />
        ) : (
          comment.author.username[0]
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-stone-700">{comment.author.username}</span>
          <span className="text-xs text-stone-400">{new Date(comment.createdAt).toLocaleDateString("zh-CN")}</span>
        </div>
        <div
          className="text-sm text-stone-600 mt-1 [&_span]:inline [&_b]:font-bold [&_i]:italic"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.content) }}
        />
        {comment.images && comment.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {comment.images.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                {url.match(/\.(mp4|webm|mov)$/i) ? (
                  <video src={url} className="w-28 h-28 object-cover rounded-lg border border-stone-200" />
                ) : (
                  <img src={url} alt="" className="w-28 h-28 object-cover rounded-lg border border-stone-200 hover:opacity-90 transition" />
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
