#!/usr/bin/env python3
"""M1-C: teacher (qwen3.7-plus) prelabels note-linked images -> expert review queue.

Usage: python3 teacher_prelabel.py [N]   # N = batch size (default 20)
Resumable: skips images already in review-queue.jsonl. Teacher output is a
DRAFT label — the expert correction column is the actual training signal.
"""
import base64
import json
import os
import subprocess
import sys
import time
import requests

# domestic endpoints only — bypass Clash proxy inherited from env
SESSION = requests.Session()
SESSION.trust_env = False

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
NOTES = f"{BASE}/tasting-notes-all.json"
QUEUE = f"{BASE}/review-queue.jsonl"
CACHE = f"{BASE}/img-cache"
os.makedirs(CACHE, exist_ok=True)

TOKEN = subprocess.run(
    ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
     "SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') FROM providers WHERE app_type='claude' AND name='百炼 Token Plan';"],
    capture_output=True, text=True).stdout.strip()

SYSTEM = "你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。描述一句话,含颜色/状态等可验证细节。"

def fetch(url_path):
    fname = url_path.rsplit("/", 1)[-1]
    local = f"{CACHE}/{fname}"
    if not (os.path.exists(local) and os.path.getsize(local) > 1000):
        r = SESSION.get("https://puer.im" + url_path, timeout=60)
        if r.status_code != 200:
            return None
        open(local, "wb").write(r.content)
    return local

def ask_teacher(local):
    data = base64.b64encode(open(local, "rb").read()).decode()
    body = {"model": "qwen3.7-plus", "max_tokens": 4000, "system": SYSTEM,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": "编目这张图。"}]}]}
    for attempt in range(3):
        try:
            r = SESSION.post("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
                headers={"x-api-key": TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json=body, timeout=120)
            r.raise_for_status()
            ans = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
            if ans:
                return ans
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    return ""

def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    done = set()
    if os.path.exists(QUEUE):
        for l in open(QUEUE):
            try:
                done.add(json.loads(l)["url"])
            except Exception:
                pass
    notes = json.load(open(NOTES))
    # build unique image list (note-linked, evernote uploads preferred)
    seen = []
    seen_set = set()
    for note in notes:
        for p in note.get("images") or []:
            if isinstance(p, str) and p.startswith("/uploads/") and p not in seen_set:
                seen_set.add(p)
                seen.append((p, note.get("title") or ""))
    todo = [(p, t) for p, t in seen if p not in done][:n]
    print(f"queue done: {len(done)}, batch: {len(todo)} (of {len(seen)} unique)")
    with open(QUEUE, "a", encoding="utf-8") as f:
        for p, title in todo:
            local = fetch(p)
            label = ask_teacher(local) if local else ""
            f.write(json.dumps({"url": p, "note_title": title, "teacher_label": label,
                                "expert_correction": "", "status": "pending"}, ensure_ascii=False) + "\n")
            f.flush()
            print(f"{p.rsplit('/',1)[-1]}: {label[:60] if label else 'FAIL'}")
    print("batch done ->", QUEUE)

if __name__ == "__main__":
    main()
