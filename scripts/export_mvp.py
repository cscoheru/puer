#!/usr/bin/env python3 -u
"""
导出 100 条笔记（含图片，压缩到合理尺寸）用于 MVP 开发。
"""

import os, sys, re, json, html as html_mod, inspect, ssl, time, socket
from io import BytesIO
import hashlib

# 兼容
if not hasattr(inspect, "getargspec"):
    inspect.getargspec = inspect.getfullargspec
ssl._create_default_https_context = ssl._create_unverified_context

from PIL import Image
from evernote.api.client import EvernoteClient
from evernote.edam.notestore.ttypes import NoteFilter, NotesMetadataResultSpec
from evernote.edam.type.ttypes import NoteSortOrder

AUTH_TOKEN = "S=s32:U=6dc7e8:E=19e3bc39e55:C=19e3b8cafd5:P=5fd:A=en-web:V=2:H=a30e7dc65ab1aec758b47932c396d48b"
NOTEBOOK_GUID = "d2cb6933-e741-40cb-95aa-579c201bc826"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
IMAGES_DIR = os.path.join(OUTPUT_DIR, "images")
MAX_NOTES = 100
MAX_IMAGE_SIZE = 1200  # px (longest edge)
JPEG_QUALITY = 82


def compress_image(data: bytes) -> bytes:
    """压缩图片到合理尺寸"""
    img = Image.open(BytesIO(data))
    # 等比缩放
    if max(img.size) > MAX_IMAGE_SIZE:
        ratio = MAX_IMAGE_SIZE / max(img.size)
        new_size = (int(img.width * ratio), int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    # 转 JPEG 压缩
    buf = BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def strip_enml(enml: str, guid_map: dict) -> str:
    """清理 ENML，替换图片引用"""
    content = enml
    content = re.sub(r'<\?xml[^>]*\?>', '', content)
    content = re.sub(r'<!DOCTYPE[^>]*>', '', content)
    body_match = re.search(r'<(?:body|en-note)[^>]*>(.*?)</(?:body|en-note)>', content, re.DOTALL)
    if body_match:
        content = body_match.group(1)

    # 替换 en-media 为 <img>
    def replace_media_with_img(m):
        hash_val = m.group(1)
        if hash_val and hash_val in guid_map:
            return f'<img src="images/{guid_map[hash_val]}" alt="" style="max-width:100%">'
        mtype = m.group(2) or "附件"
        return f'<em style="color:#999">[{mtype}]</em>'

    content = re.sub(
        r'<en-media[^>]*hash="([^"]*)"[^>]*type="([^"]*)"[^>]*/>',
        replace_media_with_img, content,
    )
    content = re.sub(r'<en-media[^>]*/>', r'<em style="color:#999">[附件]</em>', content)
    content = re.sub(r'<en-todo[^>]*checked="true"[^>]*/>', '☑ ', content)
    content = re.sub(r'<en-todo[^>]*/>', '☐ ', content)
    content = re.sub(r'\s*\n\s*', '\n', content)
    return content.strip()


def main():
    os.makedirs(IMAGES_DIR, exist_ok=True)

    print("=" * 60)
    print(f"  导出前 {MAX_NOTES} 条笔记（含压缩图片）")
    print("=" * 60)

    client = EvernoteClient(token=AUTH_TOKEN, china=True, service_host="app.yinxiang.com")
    note_store = client.get_note_store()

    # 获取笔记列表
    print("\n[1/3] 获取笔记列表...", flush=True)
    note_filter = NoteFilter()
    note_filter.notebookGuid = NOTEBOOK_GUID
    note_filter.order = NoteSortOrder.UPDATED
    note_filter.ascending = False

    spec = NotesMetadataResultSpec()
    spec.includeTitle = True

    meta = note_store.findNotesMetadata(AUTH_TOKEN, note_filter, 0, MAX_NOTES, spec)
    note_metas = meta.notes
    print(f"  获取到 {len(note_metas)} 篇笔记", flush=True)

    # 逐个下载
    print(f"\n[2/3] 下载笔记（含图片）...", flush=True)
    imported = []
    img_counter = 0

    for i, m in enumerate(note_metas, 1):
        # 设置 socket 超时，防止单条笔记卡死
        socket.setdefaulttimeout(120)
        try:
            note = note_store.getNote(AUTH_TOKEN, m.guid, True, True, False, False)
        except Exception as e:
            print(f"  [{i}/{MAX_NOTES}] {m.title}: 获取失败 - {e}", flush=True)
            continue
        finally:
            socket.setdefaulttimeout(None)

        # 处理图片资源
        guid_map = {}  # md5 hash -> filename
        resources = note.resources or []
        for ri, rsrc in enumerate(resources):
            if not rsrc.data or not rsrc.data.body:
                print(f"    资源 {ri}: 无数据，跳过", flush=True)
                continue
            if rsrc.mime and not rsrc.mime.startswith("image/"):
                print(f"    资源 {ri}: 非图片 ({rsrc.mime})，跳过", flush=True)
                continue
            try:
                print(f"    处理图片 {ri}/{len(resources)}: {len(rsrc.data.body) // 1024}KB {rsrc.mime}", flush=True)
                img_data = compress_image(rsrc.data.body)
                md5 = hashlib.md5(rsrc.data.body).hexdigest()
                ext = rsrc.mime.split("/")[-1] if rsrc.mime else "jpg"
                if ext == "jpeg":
                    ext = "jpg"
                fname = f"{md5[:12]}.{ext}"
                fpath = os.path.join(IMAGES_DIR, fname)
                with open(fpath, "wb") as f:
                    f.write(img_data)
                guid_map[md5] = fname
                img_counter += 1
                print(f"      -> {fname} ({len(img_data) // 1024}KB)", flush=True)
            except Exception as e:
                print(f"  图片处理失败: {e}", flush=True)

        # 清理内容
        content_html = strip_enml(note.content, guid_map)

        # 标签
        tags = []
        if note.tagGuids:
            try:
                tag_objs = note_store.getNoteTagList(AUTH_TOKEN, note.guid)
                tags = [t.name for t in tag_objs]
            except Exception:
                pass

        # 摘要
        plain_text = re.sub(r'<[^>]+>', '', content_html).strip()
        summary = plain_text[:200] + "..." if len(plain_text) > 200 else plain_text

        # 保存 JSON
        safe_title = re.sub(r'[^\w\s-]', '', note.title or "未命名").strip()[:50]
        safe_fn = re.sub(r'[\\/*?:"<>| ]', '_', safe_title) or "untitled"

        output = {
            "guid": note.guid,
            "title": note.title,
            "summary": summary,
            "tags": tags,
            "content_html": content_html,
            "images": list(guid_map.values()),
            "created": note.created,
            "updated": note.updated,
        }

        jpath = os.path.join(OUTPUT_DIR, f"{safe_fn}.json")
        with open(jpath, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        # HTML 预览
        with open(os.path.join(OUTPUT_DIR, f"{safe_fn}.html"), "w", encoding="utf-8") as f:
            tag_html = "".join(f'<span class="tag">{html_mod.escape(t)}</span>' for t in tags)
            f.write(f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>{html_mod.escape(note.title or "")}</title>
<style>
body {{ max-width: 720px; margin: 2em auto; padding: 0 1em; font: 16px/1.7 system-ui; color: #333; }}
h1 {{ font-size: 1.5em; color: #b45309; }}
.meta {{ color: #999; font-size: 0.85em; margin-bottom: 1.5em; }}
.tag {{ display: inline-block; background: #fef3c7; color: #92400e; padding: 0.1em 0.6em; border-radius: 4px; font-size: 0.8em; margin-right: 0.3em; }}
img {{ max-width: 100%; }}
</style></head>
<body>
<h1>{html_mod.escape(note.title or "")}</h1>
<div class="meta">{tag_html}</div>
{content_html}
</body></html>""")

        imported.append(output)
        print(f"  [{i}/{MAX_NOTES}] {note.title} ({len(guid_map)} img)", flush=True)
        time.sleep(0.3)

    # 索引
    index_path = os.path.join(OUTPUT_DIR, "_index.json")
    index_data = [{"title": n["title"], "summary": n["summary"], "tags": n["tags"], "images": len(n["images"])} for n in imported]
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_data, f, ensure_ascii=False, indent=2)

    # 统计
    total_img_size = sum(
        os.path.getsize(os.path.join(IMAGES_DIR, f))
        for f in os.listdir(IMAGES_DIR) if os.path.isfile(os.path.join(IMAGES_DIR, f))
    )

    print(f"\n[3/3] 完成!", flush=True)
    print(f"  笔记: {len(imported)} 条", flush=True)
    print(f"  图片: {img_counter} 张 ({total_img_size/1024/1024:.0f}MB)", flush=True)
    print(f"  位置: {OUTPUT_DIR}", flush=True)


if __name__ == "__main__":
    main()
