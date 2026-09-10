"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import VoteButton from "@/components/vote-button";
import MessageButton from "@/components/message-button";
import { uploadWithRetry } from "@/lib/upload-client";
import { sanitizeHtml } from "@/lib/sanitize";

interface Author {
  id: string;
  username: string;
  nickname?: string | null;
  avatar: string | null;
  level: number;
}

interface CommentRaw {
  id: string;
  content: string;
  images: string[];
  createdAt: string;
  parentId: string | null;
  upvotes: number;
  downvotes: number;
  initialVote: number;
  author: Author;
}

interface CommentNode extends CommentRaw {
  replies: CommentNode[];
}

interface CommentSectionProps {
  articleId: string;
  articleAuthorId?: string;
}

const EMOJI_CATEGORIES = [
  { name: "表情", emojis: ["😀","😃","😄","😁","😅","😂","🤣","😊","😇","🥰","😍","🤩","😘","😋","😛","😜","🤪","😝","🤗","🤔","😐","😏","😒","🙄","😬","😮","😌","😔","😪","😴","😷","🥳","🥺","😢","😭","😱","😤","😡","🤬","💀","👻","🤡"] },
  { name: "手势", emojis: ["👍","👎","👊","✊","🤛","🤜","👏","🙌","👐","🤝","🙏","✌️","🤟","🤘","👌","✋","💪","👋","🤙","💅","🫵","🖕"] },
  { name: "爱心", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💕","💞","💖","💘","💝","💔","❣️"] },
  { name: "茶点", emojis: ["🍵","🫖","🍃","🌿","☕","🍪","🎂","🍩","🍫","🍬","🍭","🧊","🥤","🧋","🍶","🥂","🍺"] },
  { name: "其他", emojis: ["🔥","✨","⭐","🌟","💫","⚡","🎉","🎊","🎈","🎁","🎀","📸","📷","🎥","🎵","🎶","💬","💭","👀","🗿","🎯","🎲"] },
];

const COLORS = ["#DC2626","#EA580C","#D97706","#65A30D","#16A34A","#0891B2","#2563EB","#7C3AED","#DB2777","#78716C"];

const FONT_SIZES = [
  { label: "小", value: "0.85em", icon: "A⁻" },
  { label: "中", value: "1em", icon: "A" },
  { label: "大", value: "1.3em", icon: "A⁺" },
  { label: "特大", value: "1.7em", icon: "A⁺⁺" },
];

function buildTree(comments: CommentRaw[]): CommentNode[] {
  const map = new Map<string, CommentNode>();
  const roots: CommentNode[] = [];
  for (const c of comments) {
    map.set(c.id, { ...c, replies: [] });
  }
  for (const c of comments) {
    const node = map.get(c.id)!;
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return new Date(dateStr).toLocaleDateString("zh-CN");
}

function AuthorPanel({ author, postNumber, isOP }: { author: Author; postNumber: number; isOP: boolean }) {
  return (
    <div className="md:w-40 lg:w-44 shrink-0 md:bg-stone-50 md:p-3 md:border-r md:border-stone-200 md:text-center">
      <div className="w-10 h-10 md:w-14 md:h-14 lg:w-16 lg:h-16 rounded-full bg-amber-100 flex items-center justify-center text-sm md:text-base text-amber-700 overflow-hidden mx-auto">
        {author.avatar ? (
          <img src={author.avatar} alt="" className="w-full h-full object-cover" />
        ) : (
          author.username[0]
        )}
      </div>
      <Link
        href={`/user/${author.id}`}
        className="block text-sm font-medium text-stone-700 hover:text-amber-800 mt-1.5 truncate"
      >
        {author.username}
      </Link>
      <span className="text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded inline-block mt-0.5">
        Lv.{author.level}
      </span>
      {isOP && (
        <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded inline-block ml-1">
          楼主
        </span>
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function wrapSelection(ta: HTMLTextAreaElement, open: string, close: string): string {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end);
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(end);
  return before + open + (selected || "文本") + close + after;
}

export default function CommentSection({ articleId, articleAuthorId }: CommentSectionProps) {
  const { data: session } = useSession();
  const [comments, setComments] = useState<CommentRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; username: string; content: string } | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showColor, setShowColor] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaUpload, setMediaUpload] = useState<{ file: File; preview: string } | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editImages, setEditImages] = useState<string[]>([]);
  const [editUploading, setEditUploading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/comments?articleId=${articleId}`)
      .then((res) => res.json())
      .then((data) => setComments(Array.isArray(data) ? data : []))
      .catch(() => setError("加载评论失败"))
      .finally(() => setLoading(false));
  }, [articleId]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false);
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setShowColor(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const tree = buildTree(comments);

  let commentCounter = 2;
  function assignNumbers(nodes: CommentNode[]): number[] {
    const nums: number[] = [];
    for (const n of nodes) {
      nums.push(commentCounter++);
      if (n.replies.length > 0) nums.push(...assignNumbers(n.replies));
    }
    return nums;
  }
  const postNumbersFlat = assignNumbers(tree);
  const postNumberMap = new Map<string, number>();
  let idx = 0;
  function mapNumbers(nodes: CommentNode[]) {
    for (const n of nodes) {
      postNumberMap.set(n.id, postNumbersFlat[idx++]);
      if (n.replies.length > 0) mapNumbers(n.replies);
    }
  }
  mapNumbers(tree);

  const handleReply = (author: Author, snippet: string, _id: string) => {
    setReplyTo({ id: _id, username: author.username, content: snippet });
    // Quote: first 2 lines only, rest replaced with ellipsis
    const plain = stripHtml(snippet);
    const lines = plain.split('\n');
    const truncated = lines.slice(0, 2).join('\n') + (lines.length > 2 ? '\n...' : '');
    setText(`> ${truncated}\n\n`);
  };

  const insertFormat = (open: string, close: string) => {
    if (!textRef.current) return;
    const ta = textRef.current;
    setText(wrapSelection(ta, open, close));
    setTimeout(() => { ta.focus(); }, 0);
  };

  const insertColor = (color: string) => {
    if (!textRef.current) return;
    const ta = textRef.current;
    setText(wrapSelection(ta, `<span style="color:${color}">`, "</span>"));
    setShowColor(false);
    setTimeout(() => { ta.focus(); }, 0);
  };

  const insertFontSize = (size: string) => {
    if (!textRef.current) return;
    const ta = textRef.current;
    setText(wrapSelection(ta, `<span style="font-size:${size}">`, "</span>"));
    setTimeout(() => { ta.focus(); }, 0);
  };

  const insertEmoji = (emoji: string) => {
    if (!textRef.current) return;
    const ta = textRef.current;
    const start = ta.selectionStart;
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(ta.selectionEnd);
    setText(before + emoji + after);
    setShowEmoji(false);
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + emoji.length; }, 0);
  };

  const handleMediaSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
    if (!allowed.includes(file.type)) {
      setError("只支持 JPG/PNG/GIF/WebP 或 MP4/WebM 视频");
      return;
    }
    const preview = URL.createObjectURL(file);
    setMediaUpload({ file, preview });
    setUploading(true);
    setError("");
    try {
      const result = await uploadWithRetry(file);
      setMediaUrl(result.url);
    } catch {
      setError("上传失败");
      setMediaUpload(null);
      setMediaUrl(null);
    } finally {
      setUploading(false);
    }
  };

  const handleEditImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setEditUploading(true);
    try {
      const results = await Promise.all(Array.from(files).map((f) => uploadWithRetry(f)));
      setEditImages((prev) => [...prev, ...results.map((r) => r.url)]);
    } catch {
      setError("图片上传失败");
    } finally {
      setEditUploading(false);
      e.target.value = "";
    }
  };

  const removeMedia = () => {
    if (mediaUpload?.preview.startsWith("blob:")) URL.revokeObjectURL(mediaUpload.preview);
    setMediaUpload(null);
    setMediaUrl(null);
    const input = document.getElementById("media-upload-input") as HTMLInputElement | null;
    if (input) input.value = "";
  };

  const startEdit = (node: CommentNode) => {
    setEditingId(node.id);
    setEditText(node.content);
    setEditImages([...node.images]);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
    setEditImages([]);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const plain = editText.replace(/<[^>]*>/g, "").trim();
    if (!plain) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/comments/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText.trim(), images: editImages }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "编辑失败");
        return;
      }
      const updated = await res.json();
      setComments((prev) => prev.map((c) => (c.id === editingId ? { ...c, content: updated.content, images: updated.images } : c)));
      cancelEdit();
    } catch {
      setError("编辑失败，请重试");
    } finally {
      setEditSaving(false);
    }
  };

  const deleteComment = async (id: string) => {
    try {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "删除失败");
        return;
      }
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch {
      setError("删除失败，请重试");
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const plainText = text.replace(/<[^>]*>/g, "").trim();
    if (!plainText) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articleId,
          content: text.trim(),
          parentId: replyTo?.id || null,
          images: mediaUrl ? [mediaUrl] : [],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "发布失败");
        return;
      }
      const newComment = await res.json();
      setComments((prev) => [...prev, newComment]);
      setText("");
      setReplyTo(null);
      setMediaUpload(null);
      setMediaUrl(null);
      setError("");
    } catch {
      setError("发布失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  function renderComment(node: CommentNode, depth: number = 0) {
    const num = postNumberMap.get(node.id) || 0;
    const isOP = node.author.id === articleAuthorId;
    const isOwner = session?.user?.id === node.author.id;
    const isEditing = editingId === node.id;
    const isDeleting = deleteConfirmId === node.id;

    return (
      <div key={node.id} className={depth > 0 ? "ml-4 md:ml-8 border-l-2 border-stone-200 pl-3 md:pl-4" : ""}>
        <div className="border border-stone-200 rounded-lg mb-3 overflow-hidden">
          <div className="md:hidden flex items-center gap-2 px-3 py-2 bg-stone-50 border-b border-stone-200">
            <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center text-xs text-amber-700 overflow-hidden shrink-0">
              {node.author.avatar ? (
                <img src={node.author.avatar} alt="" className="w-full h-full object-cover" />
              ) : (
                node.author.username[0]
              )}
            </div>
            <Link href={`/user/${node.author.id}`} className="text-sm font-medium text-stone-700 hover:text-amber-800">
              {node.author.username}
            </Link>
            <span className="text-xs text-stone-400">Lv.{node.author.level}</span>
            {isOP && <span className="text-xs px-1 py-0.5 bg-amber-100 text-amber-700 rounded">楼主</span>}
            <span className="text-xs text-stone-400 ml-auto">#{num}</span>
          </div>
          <div className="md:flex">
            <AuthorPanel author={node.author} postNumber={num} isOP={isOP} />
            <div className="flex-1 min-w-0 p-3 md:p-4">
              <div className="flex items-center gap-2 text-xs text-stone-400 mb-2">
                <span className="font-mono">#{num}</span>
                <span>·</span>
                <span>{timeAgo(node.createdAt)}</span>
                {replyTo?.id === node.id && (
                  <span className="text-amber-600 font-medium">← 正在回复此楼</span>
                )}
              </div>

              {isEditing ? (
                /* ── Edit mode ── */
                <div className="space-y-2">
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={4}
                    maxLength={1000}
                    className="w-full px-3 py-2 rounded border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm resize-none"
                  />
                  {/* Edit images */}
                  <div className="flex flex-wrap gap-2">
                    {editImages.map((url, i) => (
                      <div key={i} className="relative w-14 h-14">
                        <img src={url} alt="" className="w-full h-full object-cover rounded border border-stone-200" />
                        <button type="button" onClick={() => setEditImages((prev) => prev.filter((_, j) => j !== i))} className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] rounded-full flex items-center justify-center">&times;</button>
                      </div>
                    ))}
                    <label className="w-14 h-14 border-2 border-dashed border-stone-300 rounded flex items-center justify-center text-stone-400 hover:border-amber-400 hover:text-amber-500 transition cursor-pointer">
                      <span className="text-lg leading-none">+</span>
                      <input type="file" accept="image/*" multiple onChange={handleEditImageUpload} disabled={editUploading} className="hidden" />
                    </label>
                  </div>
                  {editUploading && <p className="text-xs text-amber-600">上传中...</p>}
                  <div className="flex gap-2">
                    <button onClick={cancelEdit} className="px-3 py-1 text-xs border border-stone-300 rounded text-stone-600 hover:bg-stone-50">取消</button>
                    <button onClick={saveEdit} disabled={editSaving || !editText.replace(/<[^>]*>/g, "").trim()} className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
                      {editSaving ? "保存中..." : "保存"}
                    </button>
                  </div>
                </div>
              ) : (
                /* ── View mode ── */
                <>
                  <div
                    className="text-sm text-stone-700 leading-relaxed [&_span]:inline [&_b]:font-bold [&_i]:italic"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(node.content) }}
                  />

                  {/* Images */}
                  {node.images && node.images.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {node.images.map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                          {url.match(/\.(mp4|webm|mov)$/i) ? (
                            <video src={url} className="w-28 h-28 md:w-32 md:h-32 object-cover rounded-lg border border-stone-200" />
                          ) : (
                            <img src={url} alt="" className="w-28 h-28 md:w-32 md:h-32 object-cover rounded-lg border border-stone-200 hover:opacity-90 transition" />
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 mt-3">
                <VoteButton
                  refId={node.id}
                  type="comment"
                  initialUpvotes={node.upvotes}
                  initialDownvotes={node.downvotes}
                  initialValue={node.initialVote}
                  size="sm"
                />
                <button
                  onClick={() => handleReply(node.author, node.content, node.id)}
                  className="text-xs text-stone-400 hover:text-amber-700 transition ml-1"
                >
                  引用
                </button>
                <MessageButton targetId={node.author.id} targetName={node.author.nickname || node.author.username} />
                {isOwner && !isEditing && (
                  <>
                    <button onClick={() => startEdit(node)} className="text-xs text-stone-400 hover:text-blue-600 transition ml-1">编辑</button>
                    <button onClick={() => setDeleteConfirmId(node.id)} className="text-xs text-stone-400 hover:text-red-600 transition ml-1">删除</button>
                  </>
                )}
              </div>

              {/* Delete confirmation */}
              {isDeleting && (
                <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs flex items-center gap-2">
                  <span className="text-red-700">确认删除此回复？</span>
                  <button onClick={() => deleteComment(node.id)} className="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600">删除</button>
                  <button onClick={() => setDeleteConfirmId(null)} className="px-2 py-1 border border-stone-300 rounded text-stone-600 hover:bg-stone-50">取消</button>
                </div>
              )}
            </div>
          </div>
        </div>
        {node.replies.length > 0 && (
          <div>
            {node.replies.map((child) => renderComment(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="mt-6 border-t border-stone-200 pt-6">
      <h2 className="text-base font-bold text-stone-800 mb-4">
        回复 ({comments.length})
      </h2>

      {error && (
        <div className="p-3 mb-4 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
          {error}
          <button onClick={() => setError("")} className="float-right font-bold">&times;</button>
        </div>
      )}

      {/* Comment form */}
      {session?.user ? (
        <form onSubmit={handleSubmit} className="mb-6">
          {replyTo && (
            <div className="text-xs text-stone-500 bg-stone-50 px-3 py-2 rounded border-l-2 border-amber-500 mb-2 flex items-center gap-2">
              <span>回复 @{replyTo.username}：</span>
              <span className="truncate flex-1 text-stone-400">{stripHtml(replyTo.content).slice(0, 60)}</span>
              <button
                type="button"
                onClick={() => { setReplyTo(null); setText(""); }}
                className="text-stone-400 hover:text-stone-600 shrink-0"
              >
                取消
              </button>
            </div>
          )}

          {/* Formatting toolbar */}
          <div className="flex items-center gap-0.5 mb-1.5 flex-wrap">
            <button type="button" onClick={() => insertFormat("<b>", "</b>")} className="w-7 h-7 flex items-center justify-center text-sm font-bold text-stone-600 hover:bg-stone-100 rounded" title="粗体">B</button>
            <button type="button" onClick={() => insertFormat("<i>", "</i>")} className="w-7 h-7 flex items-center justify-center text-sm italic text-stone-600 hover:bg-stone-100 rounded" title="斜体"><i>I</i></button>
            <span className="w-px h-5 bg-stone-300 mx-1" />
            {FONT_SIZES.map((fs) => (
              <button key={fs.value} type="button" onClick={() => insertFontSize(fs.value)} className="w-7 h-7 flex items-center justify-center text-xs text-stone-600 hover:bg-stone-100 rounded" title={fs.label}>
                {fs.icon}
              </button>
            ))}
            <span className="w-px h-5 bg-stone-300 mx-1" />
            <div className="relative" ref={colorRef}>
              <button type="button" onClick={() => setShowColor(!showColor)} className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded" title="文字颜色">
                <span className="w-3.5 h-3.5 rounded-full bg-gradient-to-br from-red-500 via-blue-500 to-green-500" />
              </button>
              {showColor && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-stone-200 rounded-lg shadow-lg p-2 flex gap-1 z-10">
                  {COLORS.map((c) => (
                    <button key={c} type="button" onClick={() => insertColor(c)} className="w-6 h-6 rounded-full border border-stone-300 hover:scale-110 transition" style={{ backgroundColor: c }} title={c} />
                  ))}
                </div>
              )}
            </div>
            <span className="w-px h-5 bg-stone-300 mx-1" />
            <div className="relative" ref={emojiRef}>
              <button type="button" onClick={() => setShowEmoji(!showEmoji)} className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded" title="表情">
                😊
              </button>
              {showEmoji && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-stone-200 rounded-lg shadow-lg p-2 z-10 w-[280px] max-h-52 overflow-y-auto">
                  {EMOJI_CATEGORIES.map((cat) => (
                    <div key={cat.name} className="mb-1">
                      <div className="text-[0.625rem] text-stone-400 mb-0.5">{cat.name}</div>
                      <div className="flex flex-wrap gap-0.5">
                        {cat.emojis.map((e) => (
                          <button key={e} type="button" onClick={() => insertEmoji(e)} className="w-7 h-7 flex items-center justify-center text-base hover:bg-stone-100 rounded">
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Media upload button */}
            <label className="w-7 h-7 flex items-center justify-center text-sm text-stone-600 hover:bg-stone-100 rounded cursor-pointer" title="上传图片/视频">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              <input id="media-upload-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm" className="hidden" onChange={handleMediaSelect} />
            </label>
          </div>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="写下你的想法...支持粗体、颜色、emoji 和图片"
            rows={4}
            maxLength={1000}
            className="w-full px-4 py-3 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition text-sm resize-none"
          />

          {/* Media preview */}
          {mediaUpload && (
            <div className="mt-2 relative inline-block">
              {mediaUpload.file.type.startsWith("video/") ? (
                <video src={mediaUpload.preview} className="h-20 rounded-lg border border-stone-200" />
              ) : (
                <img src={mediaUpload.preview} alt="" className="h-20 rounded-lg border border-stone-200" />
              )}
              <button type="button" onClick={removeMedia} disabled={uploading} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600 disabled:opacity-50">
                ✕
              </button>
              {uploading && <div className="absolute inset-0 bg-black/30 rounded-lg flex items-center justify-center"><span className="text-white text-xs">上传中...</span></div>}
            </div>
          )}

          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-stone-400">
              {text.replace(/<[^>]*>/g, "").length}/1000
              <span className="ml-2 text-stone-300">支持 HTML 标签</span>
            </span>
            <button
              type="submit"
              disabled={submitting || !text.replace(/<[^>]*>/g, "").trim() || uploading}
              className="px-4 py-1.5 bg-amber-800 hover:bg-amber-900 disabled:bg-stone-300 text-white text-sm rounded-lg transition"
            >
              {submitting ? "提交中..." : "提交回复"}
            </button>
          </div>
        </form>
      ) : (
        <div className="mb-6 p-4 bg-stone-50 rounded-lg text-center text-sm text-stone-500 border border-stone-200">
          <Link href="/login" className="text-amber-700 hover:text-amber-900 font-medium">登录</Link>
          <span> 后即可回复</span>
        </div>
      )}

      {/* Comment list */}
      {loading ? (
        <div className="text-center py-8 text-sm text-stone-400">
          <span className="inline-block animate-pulse">加载中...</span>
        </div>
      ) : tree.length === 0 ? (
        <p className="text-center py-8 text-sm text-stone-400">暂无回复，来说两句吧</p>
      ) : (
        <div>
          {tree.map((node) => renderComment(node, 0))}
        </div>
      )}
    </section>
  );
}
