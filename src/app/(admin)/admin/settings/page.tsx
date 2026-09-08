"use client";

import { useState, useEffect } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Keyword {
  id: string;
  keyword: string;
  category: string;
  isActive: boolean;
}

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: string;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
}

interface ContentCheckResult {
  flagged: boolean;
  matches: string[];
}

interface LevelConfigItem {
  level: number;
  name: string;
  expRequired: number;
  daysRequired: number;
  postsRequired: number;
  commentsLikedRequired: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CATEGORY_BADGE: Record<string, string> = {
  political: "bg-red-100 text-red-700",
  adult: "bg-pink-100 text-pink-700",
  gambling: "bg-orange-100 text-orange-700",
  investment: "bg-yellow-100 text-yellow-700",
  "off-topic": "bg-blue-100 text-blue-700",
  general: "bg-gray-100 text-gray-600",
};

const CATEGORY_LABEL: Record<string, string> = {
  political: "政治",
  adult: "色情",
  gambling: "赌博",
  investment: "投资",
  "off-topic": "偏题",
  general: "通用",
};

const ANNOUNCEMENT_TYPE: Record<string, { label: string; className: string }> = {
  info: { label: "通知", className: "bg-blue-100 text-blue-700" },
  warning: { label: "警告", className: "bg-amber-100 text-amber-800" },
  maintenance: { label: "维护", className: "bg-red-100 text-red-700" },
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  /* ---------- Keywords state ---------- */
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [kwLoading, setKwLoading] = useState(true);
  const [newKw, setNewKw] = useState("");
  const [newKwCat, setNewKwCat] = useState("general");
  const [kwSubmitting, setKwSubmitting] = useState(false);

  /* ---------- Announcements state ---------- */
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annLoading, setAnnLoading] = useState(true);
  const [annTitle, setAnnTitle] = useState("");
  const [annContent, setAnnContent] = useState("");
  const [annType, setAnnType] = useState("info");
  const [annExpires, setAnnExpires] = useState("");
  const [annSubmitting, setAnnSubmitting] = useState(false);

  /* ---------- Content test state ---------- */
  const [testContent, setTestContent] = useState("");
  const [testResult, setTestResult] = useState<ContentCheckResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  /* ---------- Level config state ---------- */
  const [levelConfigs, setLevelConfigs] = useState<LevelConfigItem[]>([]);
  const [lvLoading, setLvLoading] = useState(true);
  const [lvEditing, setLvEditing] = useState<number | null>(null);
  const [lvForm, setLvForm] = useState<LevelConfigItem>({ level: 0, name: "", expRequired: 0, daysRequired: 0, postsRequired: 0, commentsLikedRequired: 0 });
  const [lvAdding, setLvAdding] = useState(false);
  const [lvNewForm, setLvNewForm] = useState<Partial<LevelConfigItem>>({ name: "", expRequired: 0, daysRequired: 0, postsRequired: 0, commentsLikedRequired: 0 });
  const [lvSubmitting, setLvSubmitting] = useState(false);

  useEffect(() => {
    fetchKeywords();
    fetchAnnouncements();
    fetchLevelConfigs();
  }, []);

  /* ==================== Keywords ==================== */

  const fetchKeywords = async () => {
    setKwLoading(true);
    try {
      const res = await fetch("/api/admin/keywords");
      const data = await res.json();
      setKeywords(data.keywords || data || []);
    } catch {
      /* ignore */
    } finally {
      setKwLoading(false);
    }
  };

  const addKeyword = async () => {
    if (!newKw.trim()) return;
    setKwSubmitting(true);
    try {
      await fetch("/api/admin/keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: newKw.trim(), category: newKwCat }),
      });
      setNewKw("");
      fetchKeywords();
    } catch {
      /* ignore */
    } finally {
      setKwSubmitting(false);
    }
  };

  const toggleKeyword = async (id: string, isActive: boolean) => {
    await fetch(`/api/admin/keywords/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    fetchKeywords();
  };

  const deleteKeyword = async (id: string) => {
    if (!confirm("确定删除该敏感词？")) return;
    await fetch(`/api/admin/keywords/${id}`, { method: "DELETE" });
    fetchKeywords();
  };

  /* ==================== Announcements ==================== */

  const fetchAnnouncements = async () => {
    setAnnLoading(true);
    try {
      const res = await fetch("/api/admin/announcements");
      const data = await res.json();
      setAnnouncements(data.announcements || data || []);
    } catch {
      /* ignore */
    } finally {
      setAnnLoading(false);
    }
  };

  const createAnnouncement = async () => {
    if (!annTitle.trim() || !annContent.trim()) return;
    setAnnSubmitting(true);
    try {
      const body: Record<string, string> = {
        title: annTitle.trim(),
        content: annContent.trim(),
        type: annType,
      };
      if (annExpires) body.expiresAt = annExpires;

      await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAnnTitle("");
      setAnnContent("");
      setAnnType("info");
      setAnnExpires("");
      fetchAnnouncements();
    } catch {
      /* ignore */
    } finally {
      setAnnSubmitting(false);
    }
  };

  const deactivateAnnouncement = async (id: string) => {
    await fetch(`/api/admin/announcements/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    fetchAnnouncements();
  };

  const deleteAnnouncement = async (id: string) => {
    if (!confirm("确定删除该公告？")) return;
    await fetch(`/api/admin/announcements/${id}`, { method: "DELETE" });
    fetchAnnouncements();
  };

  /* ==================== Content Test ==================== */

  const checkContent = async () => {
    if (!testContent.trim()) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: testContent }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch {
      /* ignore */
    } finally {
      setTestLoading(false);
    }
  };

  /* ==================== Level Config ==================== */

  const fetchLevelConfigs = async () => {
    setLvLoading(true);
    try {
      const res = await fetch("/api/admin/level-config");
      const data = await res.json();
      setLevelConfigs(data.levels || []);
    } catch { /* ignore */ }
    finally { setLvLoading(false); }
  };

  const saveLevel = async (cfg: LevelConfigItem) => {
    setLvSubmitting(true);
    try {
      await fetch(`/api/admin/level-config/${cfg.level}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      setLvEditing(null);
      fetchLevelConfigs();
    } catch { /* ignore */ }
    finally { setLvSubmitting(false); }
  };

  const addLevel = async () => {
    const nextLevel = levelConfigs.length > 0 ? levelConfigs[levelConfigs.length - 1].level + 1 : 0;
    setLvSubmitting(true);
    try {
      await fetch("/api/admin/level-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: nextLevel, ...lvNewForm }),
      });
      setLvAdding(false);
      setLvNewForm({ name: "", expRequired: 0, daysRequired: 0, postsRequired: 0, commentsLikedRequired: 0 });
      fetchLevelConfigs();
    } catch { /* ignore */ }
    finally { setLvSubmitting(false); }
  };

  const deleteLevel = async (level: number) => {
    if (!confirm("确定删除该等级？")) return;
    await fetch(`/api/admin/level-config/${level}`, { method: "DELETE" });
    fetchLevelConfigs();
  };

  /* ==================== Render ==================== */

  return (
    <div className="max-w-4xl mx-auto py-8 space-y-0">
      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-6">
        系统设置
      </h1>

      {/* ========== Section 1: Keywords ========== */}
      <section className="bg-white border border-stone-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-stone-800 mb-4">
          敏感词管理
        </h2>

        {/* Add form */}
        <div className="flex items-center gap-2 mb-4">
          <input
            value={newKw}
            onChange={(e) => setNewKw(e.target.value)}
            placeholder="输入敏感词"
            className="flex-1 text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-300"
          />
          <select
            value={newKwCat}
            onChange={(e) => setNewKwCat(e.target.value)}
            className="text-sm border border-stone-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-amber-300"
          >
            {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button
            onClick={addKeyword}
            disabled={kwSubmitting || !newKw.trim()}
            className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition disabled:opacity-50"
          >
            添加
          </button>
        </div>

        {/* Table */}
        {kwLoading ? (
          <p className="text-stone-400 text-sm text-center py-4">加载中...</p>
        ) : keywords.length === 0 ? (
          <p className="text-stone-400 text-sm text-center py-4">
            暂无敏感词
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-4 py-2 text-stone-600 font-medium">
                  关键词
                </th>
                <th className="text-left px-4 py-2 text-stone-600 font-medium">
                  分类
                </th>
                <th className="text-left px-4 py-2 text-stone-600 font-medium">
                  状态
                </th>
                <th className="text-right px-4 py-2 text-stone-600 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((kw) => (
                <tr
                  key={kw.id}
                  className="border-b border-stone-100 hover:bg-stone-50 transition"
                >
                  <td className="px-4 py-2 text-stone-800">{kw.keyword}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        CATEGORY_BADGE[kw.category] || CATEGORY_BADGE.general
                      }`}
                    >
                      {CATEGORY_LABEL[kw.category] || kw.category}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => toggleKeyword(kw.id, kw.isActive)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        kw.isActive ? "bg-amber-600" : "bg-stone-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          kw.isActive ? "translate-x-5" : ""
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deleteKeyword(kw.id)}
                      className="text-xs text-stone-400 hover:text-red-500 transition"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ========== Section 2: Announcements ========== */}
      <section className="bg-white border border-stone-200 rounded-lg p-6 border-t-0 rounded-t-none">
        <h2 className="text-lg font-semibold text-stone-800 mb-4">
          公告管理
        </h2>

        {/* Create form */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center gap-2">
            <input
              value={annTitle}
              onChange={(e) => setAnnTitle(e.target.value)}
              placeholder="公告标题"
              className="flex-1 text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-300"
            />
            <select
              value={annType}
              onChange={(e) => setAnnType(e.target.value)}
              className="text-sm border border-stone-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-amber-300"
            >
              {Object.entries(ANNOUNCEMENT_TYPE).map(([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={annContent}
            onChange={(e) => setAnnContent(e.target.value)}
            placeholder="公告内容"
            rows={3}
            className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-300 resize-none"
          />
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-stone-500">过期时间（可选）</label>
              <input
                type="date"
                value={annExpires}
                onChange={(e) => setAnnExpires(e.target.value)}
                className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-300"
              />
            </div>
            <button
              onClick={createAnnouncement}
              disabled={annSubmitting || !annTitle.trim() || !annContent.trim()}
              className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition disabled:opacity-50"
            >
              发布公告
            </button>
          </div>
        </div>

        {/* List */}
        {annLoading ? (
          <p className="text-stone-400 text-sm text-center py-4">加载中...</p>
        ) : announcements.length === 0 ? (
          <p className="text-stone-400 text-sm text-center py-4">暂无公告</p>
        ) : (
          <div className="space-y-2">
            {announcements.map((ann) => {
              const typeInfo = ANNOUNCEMENT_TYPE[ann.type] || {
                label: ann.type,
                className: "bg-gray-100 text-gray-600",
              };
              return (
                <div
                  key={ann.id}
                  className="flex items-center gap-3 p-3 border border-stone-200 rounded-lg hover:border-amber-200 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-stone-800">
                        {ann.title}
                      </span>
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs ${typeInfo.className}`}
                      >
                        {typeInfo.label}
                      </span>
                      {!ann.isActive && (
                        <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                          已停用
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-400 mt-0.5 truncate">
                      {ann.content}
                    </p>
                    <p className="text-xs text-stone-400 mt-0.5">
                      {new Date(ann.createdAt).toLocaleDateString("zh-CN")}
                      {ann.expiresAt &&
                        ` · 过期: ${new Date(ann.expiresAt).toLocaleDateString("zh-CN")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {ann.isActive && (
                      <button
                        onClick={() => deactivateAnnouncement(ann.id)}
                        className="text-xs text-stone-500 hover:text-amber-700 transition"
                      >
                        停用
                      </button>
                    )}
                    <button
                      onClick={() => deleteAnnouncement(ann.id)}
                      className="text-xs text-stone-400 hover:text-red-500 transition"
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ========== Section: Level Config ========== */}
      <section className="bg-white border border-stone-200 rounded-lg p-6 border-t-0 rounded-t-none">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-stone-800">等级系统配置</h2>
          <button
            onClick={() => setLvAdding(true)}
            className="px-3 py-1.5 text-xs bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
          >
            + 添加等级
          </button>
        </div>

        {lvLoading ? (
          <p className="text-stone-400 text-sm text-center py-4">加载中...</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-3 py-2 text-stone-600 font-medium">等级</th>
                <th className="text-left px-3 py-2 text-stone-600 font-medium">名称</th>
                <th className="text-center px-3 py-2 text-stone-600 font-medium">经验</th>
                <th className="text-center px-3 py-2 text-stone-600 font-medium">天数</th>
                <th className="text-center px-3 py-2 text-stone-600 font-medium">帖子</th>
                <th className="text-center px-3 py-2 text-stone-600 font-medium">获赞评论</th>
                <th className="text-right px-3 py-2 text-stone-600 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {levelConfigs.map((cfg) => (
                <tr key={cfg.level} className="border-b border-stone-100 hover:bg-stone-50">
                  {lvEditing === cfg.level ? (
                    <>
                      <td className="px-3 py-2 text-stone-600">Lv.{cfg.level}</td>
                      <td className="px-3 py-2">
                        <input
                          value={lvForm.name}
                          onChange={(e) => setLvForm({ ...lvForm, name: e.target.value })}
                          className="w-full px-2 py-1 text-sm border border-stone-200 rounded focus:outline-none focus:ring-1 focus:ring-amber-300"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" value={lvForm.expRequired} onChange={(e) => setLvForm({ ...lvForm, expRequired: Number(e.target.value) })}
                          className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" value={lvForm.daysRequired} onChange={(e) => setLvForm({ ...lvForm, daysRequired: Number(e.target.value) })}
                          className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" value={lvForm.postsRequired} onChange={(e) => setLvForm({ ...lvForm, postsRequired: Number(e.target.value) })}
                          className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" value={lvForm.commentsLikedRequired} onChange={(e) => setLvForm({ ...lvForm, commentsLikedRequired: Number(e.target.value) })}
                          className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => saveLevel(lvForm)} disabled={lvSubmitting}
                          className="px-2 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 disabled:opacity-50">保存</button>
                        <button onClick={() => setLvEditing(null)} className="px-2 py-1 text-xs text-stone-500 hover:text-stone-700 ml-1">取消</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-stone-600">Lv.{cfg.level}</td>
                      <td className="px-3 py-2 text-stone-800 font-medium">{cfg.name}</td>
                      <td className="px-3 py-2 text-center text-stone-600">{cfg.expRequired}</td>
                      <td className="px-3 py-2 text-center text-stone-600">{cfg.daysRequired}</td>
                      <td className="px-3 py-2 text-center text-stone-600">{cfg.postsRequired}</td>
                      <td className="px-3 py-2 text-center text-stone-600">{cfg.commentsLikedRequired}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => { setLvEditing(cfg.level); setLvForm(cfg); }}
                          className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 rounded">编辑</button>
                        {cfg.level !== 0 && (
                          <button onClick={() => deleteLevel(cfg.level)}
                            className="px-2 py-1 text-xs text-stone-400 hover:text-red-500 ml-1">删除</button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {lvAdding && (
                <tr className="border-b border-stone-100 bg-amber-50/50">
                  <td className="px-3 py-2 text-stone-500">新</td>
                  <td className="px-3 py-2">
                    <input value={lvNewForm.name || ""} onChange={(e) => setLvNewForm({ ...lvNewForm, name: e.target.value })} placeholder="等级名称"
                      className="w-full px-2 py-1 text-sm border border-stone-200 rounded focus:outline-none focus:ring-1 focus:ring-amber-300" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" value={lvNewForm.expRequired || 0} onChange={(e) => setLvNewForm({ ...lvNewForm, expRequired: Number(e.target.value) })}
                      className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" value={lvNewForm.daysRequired || 0} onChange={(e) => setLvNewForm({ ...lvNewForm, daysRequired: Number(e.target.value) })}
                      className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" value={lvNewForm.postsRequired || 0} onChange={(e) => setLvNewForm({ ...lvNewForm, postsRequired: Number(e.target.value) })}
                      className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" value={lvNewForm.commentsLikedRequired || 0} onChange={(e) => setLvNewForm({ ...lvNewForm, commentsLikedRequired: Number(e.target.value) })}
                      className="w-20 px-2 py-1 text-sm border border-stone-200 rounded text-center focus:outline-none" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={addLevel} disabled={lvSubmitting || !lvNewForm.name}
                      className="px-2 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 disabled:opacity-50">添加</button>
                    <button onClick={() => setLvAdding(false)} className="px-2 py-1 text-xs text-stone-500 hover:text-stone-700 ml-1">取消</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {/* ========== Section 3: Content Test ========== */}
      <section className="bg-white border border-stone-200 rounded-lg p-6 border-t-0 rounded-t-none">
        <h2 className="text-lg font-semibold text-stone-800 mb-4">
          内容测试
        </h2>
        <p className="text-sm text-stone-500 mb-3">
          输入文本内容，检测是否包含敏感词。
        </p>

        <textarea
          value={testContent}
          onChange={(e) => setTestContent(e.target.value)}
          placeholder="输入待检测内容..."
          rows={4}
          className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-amber-300 resize-none"
        />

        <button
          onClick={checkContent}
          disabled={testLoading || !testContent.trim()}
          className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition disabled:opacity-50"
        >
          {testLoading ? "检测中..." : "检测"}
        </button>

        {testResult && (
          <div className="mt-4">
            {testResult.flagged ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700 font-medium">
                  检测到敏感词
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {testResult.matches.map((m, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">未检测到敏感词</p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
