"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { sanitizeHtml } from "@/lib/sanitize";

const RichEditor = dynamic(() => import("@/components/rich-editor"), { ssr: false });

interface Author {
  id: string;
  username: string;
  avatar: string | null;
  level?: number;
  karma?: number;
}

interface Comment {
  id: string;
  content: string;
  createdAt: string;
  author: { id: string; username: string; avatar: string | null };
}

interface Article {
  id: string;
  title: string;
  content: string;
  status: string;
  isPinned: boolean;
  isEssence: boolean;
  viewCount: number;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  type: string;
  images: string[] | null;
  videoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastRepliedAt: string | null;
  author: Author;
  board: { id: string; name: string; slug: string } | null;
  comments: Comment[];
}

// Article.images is a Json column; tolerate non-string entries.
function asImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string");
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: "bg-green-100 text-green-700",
    draft: "bg-yellow-100 text-yellow-700",
    archived: "bg-gray-100 text-gray-500",
  };
  const labels: Record<string, string> = {
    published: "已发布",
    draft: "草稿",
    archived: "已归档",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || "bg-stone-100 text-stone-500"}`}>
      {labels[status] || status}
    </span>
  );
}

export default function ArticleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingContent, setEditingContent] = useState(false);
  const [contentDraft, setContentDraft] = useState("");

  useEffect(() => {
    fetchArticle();
  }, [id]);

  const fetchArticle = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/articles/${id}`);
      if (!res.ok) {
        let msg = "加载文章详情失败";
        try {
          const body = await res.json();
          if (typeof body?.error === "string" && body.error) msg = body.error;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(msg);
      }
      const data = await res.json();
      setArticle(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载文章详情失败");
    } finally {
      setLoading(false);
    }
  };

  const updateArticle = async (body: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/articles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setArticle((prev) => prev ? { ...prev, ...data.article } : prev);
    } catch {
      setError("操作失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("确定删除？此操作不可撤销。")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/articles/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.push("/admin/content");
    } catch {
      setError("删除失败");
      setActionLoading(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!confirm("确定删除此评论？")) return;
    try {
      const res = await fetch(`/api/admin/comments/${commentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setArticle((prev) => prev ? { ...prev, comments: prev.comments.filter((c) => c.id !== commentId) } : prev);
    } catch {
      setError("删除评论失败");
    }
  };

  if (loading) {
    return <div className="text-center py-20 text-stone-400 text-sm">加载中...</div>;
  }

  if (error && !article) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <div className="p-4 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">{error}</div>
        <Link href="/admin/content" className="inline-block mt-4 text-sm text-amber-700 hover:text-amber-900">
          &larr; 返回列表
        </Link>
      </div>
    );
  }

  if (!article) return null;

  // Defensive: drafts are owned by /admin/drafts (the API already 404s them,
  // but never render a mutating surface for a draft here either).
  if (article.status === "draft") {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <div className="p-4 text-sm text-amber-800 bg-amber-50 rounded-lg border border-amber-200">
          该帖子是草稿，请到「草稿审校」中查看和操作。
        </div>
        <Link href="/admin/drafts" className="inline-block mt-4 text-sm text-amber-700 hover:text-amber-900">
          前往草稿审校 &rarr;
        </Link>
      </div>
    );
  }

  const mediaImages = asImages(article.images);

  const statusActions: { label: string; targetStatus: string; className: string }[] = [];
  if (article.status !== "published") {
    statusActions.push({ label: "发布", targetStatus: "published", className: "bg-green-600 hover:bg-green-700 text-white" });
  }
  if (article.status !== "archived") {
    statusActions.push({ label: "归档", targetStatus: "archived", className: "bg-stone-600 hover:bg-stone-700 text-white" });
  }

  return (
    <div className="max-w-5xl mx-auto py-6">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-6">
        <Link href="/admin/content" className="text-sm text-amber-700 hover:text-amber-900 font-medium">
          &larr; 返回内容列表
        </Link>
        <StatusBadge status={article.status} />
      </div>

      {/* Admin action bar */}
      <div className="flex flex-wrap items-center gap-2 mb-6 p-4 bg-white border border-stone-200 rounded-lg">
        {statusActions.map((action) => (
          <button
            key={action.targetStatus}
            onClick={() => updateArticle({ status: action.targetStatus })}
            disabled={actionLoading}
            className={`px-4 py-2 text-sm rounded-lg transition disabled:opacity-50 ${action.className}`}
          >
            {action.label}
          </button>
        ))}
        <button
          onClick={() => updateArticle({ isPinned: !article.isPinned })}
          disabled={actionLoading}
          className={`px-4 py-2 text-sm rounded-lg transition disabled:opacity-50 ${
            article.isPinned
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-amber-800 text-white hover:bg-amber-900"
          }`}
        >
          {article.isPinned ? "取消置顶" : "置顶"}
        </button>
        <button
          onClick={() => updateArticle({ isEssence: !article.isEssence })}
          disabled={actionLoading}
          className={`px-4 py-2 text-sm rounded-lg transition disabled:opacity-50 ${
            article.isEssence
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "bg-red-600 text-white hover:bg-red-700"
          }`}
        >
          {article.isEssence ? "取消精华" : "加精"}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => {
            if (editingContent) {
              setEditingContent(false);
            } else {
              setContentDraft(article.content);
              setEditingContent(true);
            }
          }}
          className="px-4 py-2 text-sm bg-blue-50 text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-100 transition"
        >
          {editingContent ? "取消编辑" : "编辑内容"}
        </button>
        <button
          onClick={handleDelete}
          disabled={actionLoading}
          className="px-4 py-2 text-sm bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition disabled:opacity-50"
        >
          删除
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">{error}</div>
      )}

      <div className="flex gap-6">
        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="bg-white border border-stone-200 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-2">
              {editingTitle ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        updateArticle({ title: titleDraft });
                        setArticle((prev) => prev ? { ...prev, title: titleDraft } : prev);
                        setEditingTitle(false);
                      }
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                    className="flex-1 text-xl font-serif font-bold text-stone-800 border border-amber-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-amber-400"
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      updateArticle({ title: titleDraft });
                      setArticle((prev) => prev ? { ...prev, title: titleDraft } : prev);
                      setEditingTitle(false);
                    }}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-sm bg-amber-800 text-white rounded hover:bg-amber-900 disabled:opacity-50"
                  >保存</button>
                  <button onClick={() => setEditingTitle(false)} className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50">取消</button>
                </div>
              ) : (
                <>
                  <h1 className="text-xl font-serif font-bold text-stone-800">{article.title}</h1>
                  <button
                    onClick={() => { setTitleDraft(article.title); setEditingTitle(true); }}
                    className="text-xs text-stone-400 hover:text-amber-600 transition shrink-0"
                    title="编辑标题"
                  >✏️</button>
                </>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-stone-400 mb-6">
              <span>{article.author?.username}</span>
              <span>{new Date(article.createdAt).toLocaleString("zh-CN")}</span>
              {article.board && <span>{article.board.name}</span>}
            </div>

            {/* Media: image gallery + video (drafts keep body text-only; media
                lives in images[]/videoUrl, so show it here for review) */}
            {(mediaImages.length > 0 || article.videoUrl) && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-stone-700 mb-2">
                  媒体（{mediaImages.length} 图{article.videoUrl ? " · 含视频" : ""}）
                </h3>
                {mediaImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {mediaImages.slice(0, 12).map((src, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={src}
                        alt={`图 ${i + 1}`}
                        className="w-20 h-20 object-cover rounded border border-stone-200"
                      />
                    ))}
                    {mediaImages.length > 12 && (
                      <span className="text-xs text-stone-400 self-center">
                        +{mediaImages.length - 12} 更多
                      </span>
                    )}
                  </div>
                )}
                {article.videoUrl && (
                  <video
                    src={article.videoUrl}
                    controls
                    preload="metadata"
                    className="mt-2 max-h-72 w-full rounded border border-stone-200"
                  />
                )}
              </div>
            )}

            {editingContent ? (
              <div className="space-y-3">
                <RichEditor value={contentDraft} onChange={setContentDraft} minHeight={400} />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      updateArticle({ content: contentDraft });
                      setArticle((prev) => prev ? { ...prev, content: contentDraft } : prev);
                      setEditingContent(false);
                    }}
                    disabled={actionLoading}
                    className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50"
                  >保存内容</button>
                  <button onClick={() => setEditingContent(false)} className="px-4 py-2 text-sm border border-stone-300 rounded-lg hover:bg-stone-50">取消</button>
                </div>
              </div>
            ) : (
              <div
                className="prose prose-stone prose-sm max-w-none text-stone-700"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(article.content) }}
              />
            )}
          </div>

          {/* Comments section */}
          <div className="mt-6">
            <h2 className="text-lg font-serif font-bold text-stone-800 mb-4">
              评论 ({article.comments?.length || 0})
            </h2>

            {!article.comments || article.comments.length === 0 ? (
              <p className="text-sm text-stone-400 py-4">暂无评论</p>
            ) : (
              <div className="space-y-2">
                {article.comments.map((comment) => (
                  <div key={comment.id} className="flex items-start gap-3 p-4 bg-white border border-stone-200 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-stone-700">{comment.author?.username}</span>
                        <span className="text-xs text-stone-400">
                          {new Date(comment.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <p className="text-sm text-stone-600 line-clamp-3">{comment.content}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteComment(comment.id)}
                      className="shrink-0 text-xs text-stone-400 hover:text-red-500 transition"
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-64 shrink-0 space-y-4">
          {/* Author info */}
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-3">作者信息</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-stone-500">用户名</span>
                <span className="text-stone-800">{article.author?.username}</span>
              </div>
              {article.author?.level !== undefined && (
                <div className="flex justify-between">
                  <span className="text-stone-500">等级</span>
                  <span className="text-stone-800">Lv.{article.author.level}</span>
                </div>
              )}
              {article.author?.karma !== undefined && (
                <div className="flex justify-between">
                  <span className="text-stone-500">声望</span>
                  <span className="text-stone-800">{article.author.karma}</span>
                </div>
              )}
            </div>
          </div>

          {/* Metadata */}
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-3">文章信息</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-stone-500">板块</span>
                <span className="text-stone-800">{article.board?.name || "-"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">类型</span>
                <span className="text-stone-800">{article.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">置顶</span>
                <span className={article.isPinned ? "text-amber-600" : "text-stone-400"}>
                  {article.isPinned ? "是" : "否"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">精华</span>
                <span className={article.isEssence ? "text-red-500" : "text-stone-400"}>
                  {article.isEssence ? "是" : "否"}
                </span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-3">统计数据</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-stone-500">浏览</span>
                <span className="text-stone-800 tabular-nums">{article.viewCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">回复</span>
                <span className="text-stone-800 tabular-nums">{article.replyCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">点赞</span>
                <span className="text-stone-800 tabular-nums">{article.upvotes}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">踩</span>
                <span className="text-stone-800 tabular-nums">{article.downvotes}</span>
              </div>
            </div>
          </div>

          {/* Timestamps */}
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-3">时间</h3>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-stone-500 block text-xs">创建时间</span>
                <span className="text-stone-700">{new Date(article.createdAt).toLocaleString("zh-CN")}</span>
              </div>
              <div>
                <span className="text-stone-500 block text-xs">更新时间</span>
                <span className="text-stone-700">{new Date(article.updatedAt).toLocaleString("zh-CN")}</span>
              </div>
              {article.lastRepliedAt && (
                <div>
                  <span className="text-stone-500 block text-xs">最后回复</span>
                  <span className="text-stone-700">{new Date(article.lastRepliedAt).toLocaleString("zh-CN")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
