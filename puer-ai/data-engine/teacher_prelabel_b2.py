#!/usr/bin/env python3
"""M4 batch-2: teacher prelabel WITH distilled rules (active-learning round 2).

Upgrades vs teacher_prelabel.py (batch 1):
1. rules-injected SYSTEM prompt — known teacher biases blocked at source
   (color over-report, 透亮 misuse, 琥珀 misuse, vessel jargon)
2. random sample from the remaining pool (batch 1 took note order = biased)
3. md5 dedup after download (same photo re-uploaded under different URLs)

Usage: python3 teacher_prelabel_b2.py [N]     # default 200
Output: review-queue-b2.jsonl (separate from batch 1)
"""
import base64
import hashlib
import json
import os
import random
import subprocess
import sys
import time
import requests

SESSION = requests.Session()
SESSION.trust_env = False  # domestic endpoint, bypass Clash

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
NOTES = f"{BASE}/tasting-notes-all.json"
QUEUE = f"{BASE}/review-queue-b2.jsonl"
CACHE = f"{BASE}/img-cache"

TOKEN = subprocess.run(
    ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
     "SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') FROM providers WHERE app_type='claude' AND name='百炼 Token Plan';"],
    capture_output=True, text=True).stdout.strip()

SYSTEM = """你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。描述一句话,含颜色/状态等可验证细节。
行规约束(必须遵守):
1 汤色颜色贴图取档宁浅勿深:橙黄勿说橙红,深橙勿说琥珀。
2 「透亮」只用于玻璃公道杯中确实透光见底的茶汤;品茗杯等小杯只说「明亮」;混浊就诚实说混浊。
3 「琥珀色」只用于干仓透亮老生茶;湿仓茶汤色用「红浓明亮」。
4 器物用行话:紫砂壶/青瓷/青花/汝窑;禁用深色茶壶/浅青色/浅蓝色/白底蓝花等说法。
5 紧压茶条索用「紧结」不用「卷曲」;叶片尚未泡开时不写「舒展完整」。
6 饼面/版面/内飞等一目了然的主体一句话说完不啰嗦;无破损不提破损;塑料膜/拍摄背景等环境物不写。"""

def fetch(url_path):
    fname = url_path.rsplit("/", 1)[-1]
    local = f"{CACHE}/{fname}"
    if not (os.path.exists(local) and os.path.getsize(local) > 1000):
        r = SESSION.get("https://puer.im" + url_path, timeout=60)
        if r.status_code != 200:
            return None
        open(local, "wb").write(r.content)
    return local

def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()

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

def process_one(p, title, known_md5, write_lock, fout, i, total):
    """download -> dedup -> teacher-label -> append one queue line (thread-safe)."""
    local = fetch(p)
    if not local:
        with write_lock:
            fout.write(json.dumps({"url": p, "note_title": title, "teacher_label": "",
                                   "expert_correction": "", "status": "fetch_fail"}, ensure_ascii=False) + "\n")
            fout.flush()
        return
    h = md5(local)
    if h in known_md5 and known_md5[h] != os.path.basename(local):
        with write_lock:
            fout.write(json.dumps({"url": p, "note_title": title, "teacher_label": "",
                                   "expert_correction": "", "status": f"dup_of:{known_md5[h]}"}, ensure_ascii=False) + "\n")
            fout.flush()
        print(f"[{i}/{total}] DUP {os.path.basename(local)} == {known_md5[h]}", flush=True)
        return
    known_md5[h] = os.path.basename(local)
    label = ask_teacher(local)
    with write_lock:
        fout.write(json.dumps({"url": p, "note_title": title, "teacher_label": label,
                               "expert_correction": "", "status": "pending"}, ensure_ascii=False) + "\n")
        fout.flush()
    print(f"[{i}/{total}] {os.path.basename(local)}: {label[:56] if label else 'TEACHER_FAIL'}", flush=True)

def main():
    from concurrent.futures import ThreadPoolExecutor
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    done = set()
    if os.path.exists(QUEUE):
        for l in open(QUEUE):
            try:
                done.add(json.loads(l)["url"])
            except Exception:
                pass
    notes = json.load(open(NOTES))
    pool, seen_set = [], set()
    for note in notes:
        for p in note.get("images") or []:
            if isinstance(p, str) and p.startswith("/uploads/") and p not in seen_set:
                seen_set.add(p)
                pool.append((p, note.get("title") or ""))
    # batch-1 urls are excluded (they live in review-queue.jsonl), sample the rest
    b1 = set()
    for l in open(f"{BASE}/review-queue.jsonl"):
        try:
            b1.add(json.loads(l)["url"])
        except Exception:
            pass
    rest = [(p, t) for p, t in pool if p not in b1 and p not in done]
    random.seed(42)
    random.shuffle(rest)
    todo = rest[:n]
    print(f"pool {len(pool)}, b1 {len(b1)}, b2 done {len(done)}, this batch {len(todo)}, workers {workers}", flush=True)

    # md5 index of everything already cached (batch-1 + earlier batch-2)
    known_md5 = {}
    for f in os.listdir(CACHE):
        p = f"{CACHE}/{f}"
        if os.path.isfile(p) and os.path.getsize(p) > 1000:
            try:
                known_md5.setdefault(md5(p), f)
            except Exception:
                pass

    write_lock = __import__("threading").Lock()
    with open(QUEUE, "a", encoding="utf-8") as fout:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(process_one, p, t, known_md5, write_lock, fout, i, len(todo))
                    for i, (p, t) in enumerate(todo, 1)]
            for f in futs:
                f.result()
    print("batch done ->", QUEUE)

if __name__ == "__main__":
    main()
