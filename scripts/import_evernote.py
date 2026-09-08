#!/usr/bin/env python3 -u
"""
印象笔记茶品笔记导出脚本
使用 Developer Token，增量导出为 JSON/HTML 文件。
支持断点续传——已导出的笔记不会重复下载。
运行方式:
  python3 -u scripts/import_evernote.py
"""

import os
import sys
import re
import json
import html as html_mod
import inspect
import ssl
import time
import glob

# Python 3.14+ 兼容
if not hasattr(inspect, "getargspec"):
    inspect.getargspec = inspect.getfullargspec

ssl._create_default_https_context = ssl._create_unverified_context

# 使用浏览器会话 auth cookie（比 Developer Token 限流宽松很多）
AUTH_TOKEN = "S=s32:U=6dc7e8:E=19edac1640f:C=19e40429c0f:P=5fd:A=en-web:V=2:H=0eb485b44c443b08fb4630c7b24d5330"
NOTEBOOK_GUID = "d2cb6933-e741-40cb-95aa-579c201bc826"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
# 记录已导出的笔记 GUID，用于断点续传
STATE_FILE = os.path.join(OUTPUT_DIR, "_export_state.json")


def strip_enml(enml):
    content = enml
    content = re.sub(r'<\?xml[^>]*\?>', '', content)
    content = re.sub(r'<!DOCTYPE[^>]*>', '', content)
    body_match = re.search(r'<(?:body|en-note)[^>]*>(.*?)</(?:body|en-note)>', content, re.DOTALL)
    if body_match:
        content = body_match.group(1)
    content = re.sub(r'<en-media[^>]*type="([^"]*)"[^>]*/>',
                     r'<em style="color:#999">[附件: \1]</em>', content)
    content = re.sub(r'<en-media[^>]*/>', r'<em style="color:#999">[附件]</em>', content)
    content = re.sub(r'<en-todo[^>]*checked="true"[^>]*/>', '☑ ', content)
    content = re.sub(r'<en-todo[^>]*/>', '☐ ', content)
    content = re.sub(r'\s*\n\s*', '\n', content)
    return content.strip()


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"exported_guids": [], "all_guids": []}


def save_state(state):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, ensure_ascii=False)


IMAGES_DIR = os.path.join(OUTPUT_DIR, "images")


def save_note(note, note_store, state):
    """保存单条笔记到文件，成功后记录 GUID"""
    title = note.title or "未命名笔记"
    safe_title = re.sub(r'[^\w\s-]', '', title).strip()[:50]
    safe_filename = re.sub(r'[\\/*?:"<>| ]', '_', safe_title) or "untitled"

    # 避免文件名冲突
    filepath = os.path.join(OUTPUT_DIR, f"{safe_filename}.json")
    if os.path.exists(filepath):
        safe_filename = f"{safe_filename}_{note.guid[:8]}"

    content_html = strip_enml(note.content)

    tags = []
    if note.tagGuids:
        try:
            tag_objs = note_store.getNoteTagList(AUTH_TOKEN, note.guid)
            tags = [t.name for t in tag_objs]
        except Exception:
            pass

    # ── 处理图片资源 ──
    os.makedirs(IMAGES_DIR, exist_ok=True)
    image_filenames = []
    if note.resources:
        for res in note.resources:
            mime = getattr(res, "mime", "") or ""
            if not mime.startswith("image/"):
                continue
            filename = getattr(res.attributes, "fileName", None) or f"{res.guid[:12]}.jpg"
            # Use a short hash-based name for dedup
            import hashlib
            data = res.data.body if res.data and res.data.body else b""
            if not data:
                continue
            filehash = hashlib.md5(data).hexdigest()[:12]
            ext = os.path.splitext(filename)[1] or ".jpg"
            img_filename = f"{filehash}{ext}"
            img_path = os.path.join(IMAGES_DIR, img_filename)
            if not os.path.exists(img_path):
                with open(img_path, "wb") as f:
                    f.write(data)
            image_filenames.append(img_filename)
            # Insert <img> tag into content
            img_tag = f'<img src="{img_filename}" alt="" style="max-width:100%">'
            content_html = content_html.replace(
                f'<en-media hash="{res.data.bodyHash}"',
                img_tag,
                1,
            ) or content_html + img_tag

    plain_text = re.sub(r'<[^>]+>', '', content_html).strip()
    summary = plain_text[:200] + "..." if len(plain_text) > 200 else plain_text

    output = {
        "guid": note.guid,
        "title": title,
        "summary": summary,
        "tags": tags,
        "content_html": content_html,
        "images": image_filenames,
        "created": note.created,
        "updated": note.updated,
    }

    filepath = os.path.join(OUTPUT_DIR, f"{safe_filename}.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    html_filepath = os.path.join(OUTPUT_DIR, f"{safe_filename}.html")
    with open(html_filepath, "w", encoding="utf-8") as f:
        f.write(f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>{html_mod.escape(title)}</title>
<style>
body {{ max-width: 720px; margin: 2em auto; padding: 0 1em; font: 16px/1.7 system-ui; color: #333; }}
h1 {{ font-size: 1.5em; color: #b45309; }}
.meta {{ color: #999; font-size: 0.85em; margin-bottom: 1.5em; }}
.tag {{ display: inline-block; background: #fef3c7; color: #92400e; padding: 0.1em 0.6em;
        border-radius: 4px; font-size: 0.8em; margin-right: 0.3em; }}
img {{ max-width: 100%; }}
</style></head>
<body>
<h1>{html_mod.escape(title)}</h1>
<div class="meta">{', '.join(f'<span class="tag">{html_mod.escape(t)}</span>' for t in tags)}</div>
{content_html}
</body></html>""")

    # 记录已导出
    state["exported_guids"].append(note.guid)
    save_state(state)
    return output


def call_safely(fn, *args, **kwargs):
    """带速率限制处理的 API 调用"""
    while True:
        try:
            return fn(*args, **kwargs)
        except EDAMSystemException as e:
            if e.errorCode == EDAMErrorCode.RATE_LIMIT_REACHED:
                wait = e.rateLimitDuration if hasattr(e, 'rateLimitDuration') and e.rateLimitDuration else 60
                print(f"\n  [!] 触发限流，等待 {wait} 秒...", flush=True)
                # 分小段等待，方便中断
                for _ in range(wait):
                    time.sleep(1)
                print(f"  [*] 继续...", flush=True)
            else:
                raise


def main():
    print("=" * 60)
    print("  印象笔记 → 网站素材 导出工具")
    print("  支持断点续传，已导出的不会重复下载")
    print("=" * 60)

    from evernote.api.client import EvernoteClient
    from evernote.edam.notestore.ttypes import NoteFilter, NotesMetadataResultSpec
    from evernote.edam.type.ttypes import NoteSortOrder
    from evernote.edam.error.ttypes import EDAMSystemException, EDAMErrorCode

    # 全局引用，给 call_safely 用
    globals()["EDAMSystemException"] = EDAMSystemException
    globals()["EDAMErrorCode"] = EDAMErrorCode

    client = EvernoteClient(token=AUTH_TOKEN, china=True, service_host="app.yinxiang.com")
    note_store = client.get_note_store()
    print("\n[1/3] 连接成功！")

    state = load_state()
    exported_guids = set(state.get("exported_guids", []))
    all_guids = state.get("all_guids", [])

    # ── Phase 1: 获取所有笔记 GUID（如果还没有） ──
    if not all_guids:
        print("\n[2/3] 获取笔记列表...", flush=True)
        filter_ = NoteFilter()
        filter_.notebookGuid = NOTEBOOK_GUID
        filter_.order = NoteSortOrder.UPDATED
        filter_.ascending = False

        spec = NotesMetadataResultSpec()
        spec.includeTitle = True

        offset = 0
        page_size = 100

        while True:
            print(f"  获取列表: {offset}+", end="", flush=True)
            meta = call_safely(
                note_store.findNotesMetadata,
                AUTH_TOKEN, filter_, offset, page_size, spec,
            )
            print(f" → {len(meta.notes)} 条", flush=True)

            for n in meta.notes:
                all_guids.append({"guid": n.guid, "title": n.title})

            offset += page_size
            if not meta.notes or offset >= meta.totalNotes:
                break
            time.sleep(1)

        state["all_guids"] = all_guids
        save_state(state)
        print(f"  共 {len(all_guids)} 篇笔记", flush=True)
    else:
        print(f"\n[2/3] 已有笔记列表: {len(all_guids)} 篇", flush=True)

    # ── Phase 2: 逐个下载笔记内容 ──
    pending = [n for n in all_guids if n["guid"] not in exported_guids]
    done_count = len(exported_guids)
    total = len(all_guids)

    print(f"\n[3/3] 下载笔记内容...", flush=True)
    print(f"  已完成: {done_count}, 剩余: {len(pending)}", flush=True)

    if not pending:
        print("  全部笔记已导出，无需下载", flush=True)
    else:
        for i, item in enumerate(pending, 1):
            guid = item["guid"]
            title = item["title"]
            try:
                note = call_safely(
                    note_store.getNote,
                    AUTH_TOKEN, guid, True, True, False, False,
                )
                save_note(note, note_store, state)
                print(f"  [{done_count + i}/{total}] {title}", flush=True)
                time.sleep(0.5)  # 礼貌性延迟
            except Exception as e:
                print(f"  [{done_count + i}/{total}] {title}: {e}", flush=True)

    # ── 生成索引 ──
    print("\n生成索引...", flush=True)
    imported = []
    for fpath in sorted(glob.glob(os.path.join(OUTPUT_DIR, "*.json"))):
        if os.path.basename(fpath) == "_export_state.json":
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            imported.append(json.load(f))

    index_path = os.path.join(OUTPUT_DIR, "_index.json")
    index_data = [{"title": n["title"], "summary": n["summary"], "tags": n["tags"]} for n in imported]
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_data, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 60}", flush=True)
    print(f"  导出完成!", flush=True)
    print(f"  位置: {OUTPUT_DIR}", flush=True)
    print(f"  共 {len(imported)} 篇笔记", flush=True)
    print(f"{'=' * 60}", flush=True)


if __name__ == "__main__":
    main()
