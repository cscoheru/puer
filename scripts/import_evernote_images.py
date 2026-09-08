#!/usr/bin/env python3 -u
"""
Evernote 笔记图片提取脚本（4 线程并发版）
每线程设 120s 传输超时，防止 SSL 无限阻塞。

运行方式:
  python3 -u scripts/import_evernote_images.py
"""

import os, sys, json, glob, hashlib, ssl, inspect, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

if not hasattr(inspect, "getargspec"):
    inspect.getargspec = inspect.getfullargspec

ssl._create_default_https_context = ssl._create_unverified_context

AUTH_TOKEN = "S=s32:U=6dc7e8:E=19edac1640f:C=19e40429c0f:P=5fd:A=en-web:V=2:H=0eb485b44c443b08fb4630c7b24d5330"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
IMAGES_DIR = os.path.join(OUTPUT_DIR, "images")
STATE_FILE = os.path.join(OUTPUT_DIR, "_image_state.json")

MAX_DIM = 1200
JPEG_QUALITY = 82
WORKERS = 4
TIMEOUT = 120  # 秒
CHECKPOINT_EVERY = 30


def compress_image(data, filename):
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > MAX_DIM:
            ratio = MAX_DIM / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        ext = os.path.splitext(filename)[1].lower()
        if ext in (".png", ".gif"):
            img.save(buf, format="PNG", optimize=True)
        else:
            img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception:
        return data


def process_note(guid, data, fpath):
    from evernote.api.client import EvernoteClient
    from evernote.edam.error.ttypes import EDAMSystemException, EDAMErrorCode, EDAMNotFoundException

    title = data.get("title", "未知")

    for attempt in range(3):
        try:
            c = EvernoteClient(token=AUTH_TOKEN, china=True, service_host="app.yinxiang.com")
            ns = c.get_note_store()
            ns._client._oprot.trans.setTimeout(TIMEOUT * 1000)
            note = ns.getNote(AUTH_TOKEN, guid, False, True, False, False)
            break
        except EDAMSystemException as e:
            if e.errorCode == 19:
                w = getattr(e, "rateLimitDuration", 60) or 60
                return (guid, title, 0, f"限流 {w}s")
            if attempt == 2:
                return (guid, title, 0, f"API: {e}")
            time.sleep(2)
        except EDAMNotFoundException:
            return (guid, title, 0, "不存在")
        except Exception as e:
            if attempt == 2:
                return (guid, title, 0, f"{type(e).__name__}: {str(e)[:60]}")
            time.sleep(2)

    resources = note.resources or []
    img_resources = [r for r in resources if getattr(r, "mime", "").startswith("image/")]
    if not img_resources:
        return (guid, title, 0, None)

    os.makedirs(IMAGES_DIR, exist_ok=True)
    saved_images = []
    content_html = data.get("content_html", "")

    for res in img_resources:
        raw_data = res.data.body if res.data else None
        if not raw_data:
            continue
        filename = getattr(res.attributes, "fileName", None) or f"{res.guid[:12]}.jpg"
        compressed = compress_image(raw_data, filename)
        filehash = hashlib.md5(compressed).hexdigest()[:12]
        ext = os.path.splitext(filename)[1].lower() or ".jpg"
        ext = ".jpg" if ext in (".jpeg", "") else ext
        if ext not in (".jpg", ".png", ".gif", ".webp"):
            ext = ".jpg"
        img_filename = f"{filehash}{ext}"
        img_path = os.path.join(IMAGES_DIR, img_filename)
        if not os.path.exists(img_path):
            with open(img_path, "wb") as f:
                f.write(compressed)
        saved_images.append(img_filename)
        if res.data.bodyHash:
            bh = res.data.bodyHash.hex() if isinstance(res.data.bodyHash, bytes) else res.data.bodyHash
            if bh in content_html:
                content_html = content_html.replace(f'<en-media hash="{bh}"', f'<img src="{img_filename}" alt="" style="max-width:100%">', 1)

    if saved_images:
        data["images"] = saved_images
        data["content_html"] = content_html
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    return (guid, title, len(saved_images), None)


def main():
    print("=" * 60)
    print("  印象笔记 → 图片提取（4 线程并发版）")
    print(f"  超时: {TIMEOUT}s, 压缩: {MAX_DIM}px, JPEG {JPEG_QUALITY}%")
    print("=" * 60, flush=True)

    state = json.load(open(STATE_FILE)) if os.path.exists(STATE_FILE) else {"processed_guids": []}
    processed = set(state["processed_guids"])

    notes = {}
    for fpath in sorted(glob.glob(os.path.join(OUTPUT_DIR, "*.json"))):
        if os.path.basename(fpath).startswith("_"):
            continue
        try:
            with open(fpath, "r") as f:
                d = json.load(f)
            g = d.get("guid")
            if g and g not in notes:
                notes[g] = (d, fpath)
        except Exception:
            pass

    pending = [(g, notes[g]) for g in notes if g not in processed]
    total = len(notes)
    done = len(processed)
    print(f"  共 {total} 篇，已完成 {done}，剩余 {len(pending)}", flush=True)
    if not pending:
        print("  全部完成！", flush=True)
        return

    state_lock = threading.Lock()
    completed = done

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(process_note, g, d, fp): (g, d.get("title", "")) for g, (d, fp) in pending}
        for fut in as_completed(futs):
            guid, title, count, error = fut.result()
            with state_lock:
                completed += 1
                if count > 0 or error:
                    status = f"→ {count} 张图" if not error else f"✗ {error}"
                    print(f"  [{completed}/{total}] {title[:50]:50s} {status}", flush=True)
                state["processed_guids"].append(guid)
                if (completed - done) % CHECKPOINT_EVERY == 0:
                    json.dump(state, open(STATE_FILE, "w"), ensure_ascii=False)

    json.dump(state, open(STATE_FILE, "w"), ensure_ascii=False)

    # Cleanup duplicate JSONs
    print("\n  图片总数:", len(os.listdir(IMAGES_DIR)), flush=True)
    print("清理重复 JSON...", flush=True)
    seen = {}
    for fpath in sorted(glob.glob(os.path.join(OUTPUT_DIR, "*.json"))):
        if os.path.basename(fpath).startswith("_"):
            continue
        try:
            with open(fpath) as f:
                g = json.load(f).get("guid")
            if g:
                if g in seen:
                    os.remove(fpath)
                else:
                    seen[g] = fpath
        except Exception:
            pass
    print(f"  清理后: {len(seen)} 篇笔记", flush=True)
    print("=" * 60, flush=True)


if __name__ == "__main__":
    main()
