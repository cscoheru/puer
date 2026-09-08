"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import ImageExt from "@tiptap/extension-image";
import LinkExt from "@tiptap/extension-link";
import { useCallback, useEffect, useRef, useState } from "react";

interface RichEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
}

type Level = 1 | 2 | 3 | 4 | 5 | 6;

const COLORS = [
  { label: "默认", value: "#374151" },  // text-stone-700
  { label: "红色", value: "#dc2626" },
  { label: "蓝色", value: "#2563eb" },
  { label: "绿色", value: "#16a34a" },
  { label: "橙色", value: "#ea580c" },
  { label: "紫色", value: "#9333ea" },
  { label: "灰色", value: "#9ca3af" },
];

export default function RichEditor({ value, onChange, placeholder, minHeight = 300 }: RichEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
      }),
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      Color,
      ImageExt.configure({ inline: false }),
      LinkExt.configure({ openOnClick: false }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-stone prose-sm md:prose-base max-w-none focus:outline-none px-4 py-3 min-h-[200px]",
      },
    },
  });

  // Sync external `value` changes into the editor. useEditor only consumes the
  // initial `value`, so without this, swapping the edited draft (or any parent
  // state change) leaves the editor showing stale content. `emitUpdate: false`
  // is the Tiptap v3 options shape (v2's positional boolean is gone) and keeps
  // setContent from re-firing onChange → parent setState → loop.
  useEffect(() => {
    if (!editor) return;
    if (value === undefined) return;
    const norm = (s: string) => (s === "<p></p>" ? "" : s);
    if (norm(editor.getHTML()) === norm(value)) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  const toggleLink = useCallback(() => {
    if (!editor) return;
    if (showLinkInput) {
      setShowLinkInput(false);
      return;
    }
    const previousUrl = editor.getAttributes("link").href || "";
    setLinkUrl(previousUrl);
    setShowLinkInput(true);
  }, [editor, showLinkInput]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    if (linkUrl) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setShowLinkInput(false);
  }, [editor, linkUrl]);

  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;

    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowed.includes(file.type)) {
      alert("只支持 JPG、PNG、GIF、WebP 格式");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("图片大小不能超过 5MB");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      editor.chain().focus().setImage({ src: url }).run();
    } catch (err) {
      alert("上传失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [editor]);

  const applyColor = useCallback((color: string) => {
    if (!editor) return;
    editor.chain().focus().setColor(color).run();
    setShowColorPicker(false);
  }, [editor]);

  if (!editor) return null;

  const ToolBtn = ({ onClick, active, title, children }: {
    onClick: () => void; active?: boolean; title: string; children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded hover:bg-stone-200 transition text-sm ${
        active ? "bg-stone-200 text-amber-800" : "text-stone-600"
      }`}
    >
      {children}
    </button>
  );

  const Divider = () => <span className="w-px h-5 bg-stone-300 mx-1 shrink-0" />;

  return (
    <div className="border border-stone-300 rounded-lg overflow-hidden bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 bg-stone-50 border-b border-stone-200">
        <ToolBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="加粗">
          <strong>B</strong>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="斜体">
          <em>I</em>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="下划线">
          <span className="underline">U</span>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} title="删除线">
          <span className="line-through">S</span>
        </ToolBtn>

        <Divider />

        <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 as Level }).run()}
          active={editor.isActive("heading", { level: 2 })} title="标题 2">
          <span className="font-bold text-xs">H2</span>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 as Level }).run()}
          active={editor.isActive("heading", { level: 3 })} title="标题 3">
          <span className="font-bold text-xs">H3</span>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 4 as Level }).run()}
          active={editor.isActive("heading", { level: 4 })} title="标题 4">
          <span className="font-bold text-xs">H4</span>
        </ToolBtn>

        <Divider />

        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("left").run()}
          active={editor.isActive({ textAlign: "left" })} title="左对齐">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14v2H1zm0 4h10v2H1zm0 4h12v2H1zm0 4h8v2H1z"/></svg>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("center").run()}
          active={editor.isActive({ textAlign: "center" })} title="居中">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14v2H1zm2 4h10v2H3zm1 4h12v2H4zm2 4h8v2H6z"/></svg>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("right").run()}
          active={editor.isActive({ textAlign: "right" })} title="右对齐">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14v2H1zm4 4h10v2H5zm2 4h12v2H7zm6 4h8v2H13z"/></svg>
        </ToolBtn>

        <Divider />

        <ToolBtn onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")} title="无序列表">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3-1h10v2H5zm-3 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3-1h10v2H5zm-3 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3-1h10v2H5z"/></svg>
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")} title="有序列表">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h1v1H2zm2-1h10v2H4zm-2 5h1v1H2zm2-1h10v2H4zm-2 5h1v1H2zm2-1h10v2H4z"/></svg>
        </ToolBtn>

        <Divider />

        {/* Color picker */}
        <div className="relative">
          <ToolBtn onClick={() => setShowColorPicker(!showColorPicker)}
            active={showColorPicker} title="文字颜色">
            <span style={{ color: "#dc2626" }}>A</span>
          </ToolBtn>
          {showColorPicker && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg p-2 z-50 flex gap-1">
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => applyColor(c.value)}
                  className="w-6 h-6 rounded-full border border-stone-300 hover:scale-110 transition"
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                />
              ))}
            </div>
          )}
        </div>

        {/* Link */}
        <ToolBtn onClick={toggleLink} active={editor.isActive("link")} title="链接">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </ToolBtn>

        {/* Image */}
        <ToolBtn onClick={() => fileRef.current?.click()} title={uploading ? "上传中..." : "插入图片"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </ToolBtn>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>

      {/* Link input */}
      {showLinkInput && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200">
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="输入链接地址..."
            className="flex-1 text-sm px-2 py-1 border border-stone-300 rounded focus:outline-none focus:border-amber-500"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && applyLink()}
          />
          <button type="button" onClick={applyLink} className="text-xs px-2 py-1 bg-amber-800 text-white rounded hover:bg-amber-900">确定</button>
          <button type="button" onClick={() => setShowLinkInput(false)} className="text-xs px-2 py-1 text-stone-500 hover:text-stone-700">取消</button>
        </div>
      )}

      {/* Editor */}
      <EditorContent editor={editor} style={{ minHeight }} />

      {/* Uploading indicator */}
      {uploading && (
        <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
          <span className="text-sm text-stone-500">上传中...</span>
        </div>
      )}
    </div>
  );
}
