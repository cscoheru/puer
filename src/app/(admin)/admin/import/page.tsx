"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function ImportPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [importType, setImportType] = useState("tasting");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  if (session && (session.user as any).role !== "admin") {
    return (
      <div className="text-center py-20 text-stone-400">仅管理员可访问此页面</div>
    );
  }

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("type", importType);

    try {
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8">
      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-2">印象笔记导入</h1>
      <p className="text-sm text-stone-500 mb-8">
        上传 .enex 导出文件，笔记将以草稿形式导入，可在内容管理中编辑后发布。
      </p>

      <div className="space-y-5 bg-white p-6 rounded-xl border border-stone-200">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">内容类型</label>
          <select
            value={importType}
            onChange={(e) => setImportType(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm"
          >
            <option value="tasting">品鉴笔记</option>
            <option value="article">深度文章</option>
            <option value="discussion">讨论帖</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">ENEX 文件</label>
          <input
            type="file"
            accept=".enex"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm text-stone-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber-50 file:text-amber-800 hover:file:bg-amber-100"
          />
          {file && (
            <p className="text-xs text-stone-400 mt-1">
              {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
            </p>
          )}
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          <p className="font-medium mb-1">印象笔记导出方法：</p>
          <ol className="list-decimal list-inside space-y-0.5 text-amber-700">
            <li>打开印象笔记桌面客户端</li>
            <li>选中要导出的笔记（可全选 Ctrl+A）</li>
            <li>右键 → 导出为... → 选择 .enex 格式</li>
            <li>如笔记超过 500 篇，建议分批导出（每批 200-500 篇）</li>
          </ol>
        </div>

        <button
          onClick={handleImport}
          disabled={!file || loading}
          className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
        >
          {loading ? "导入中..." : "开始导入"}
        </button>

        {error && (
          <div className="p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="p-4 bg-green-50 rounded-lg border border-green-200">
            <p className="font-medium text-green-800 text-sm">
              导入完成：{result.imported} 篇成功，{result.errors} 篇失败
            </p>
            {result.errors > 0 && (
              <p className="text-xs text-green-600 mt-1">
                失败原因：{result.errorDetails?.map((e: any) => e.error).join("; ")}
              </p>
            )}
            <button
              onClick={() => router.push("/admin/drafts")}
              className="mt-3 text-sm text-amber-700 hover:text-amber-900 font-medium"
            >
              查看草稿列表 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
