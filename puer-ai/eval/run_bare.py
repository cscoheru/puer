#!/usr/bin/env python3
"""Bare-run the 80 text questions against multiple general models.

Anthropic-compatible endpoints, thinking disabled where supported.
Resumable: skips (model, id) already answered in results/<model>/answers.jsonl.
Usage: python3 run_bare.py <model_key>   # glm5.3 | deepseek | kimi
"""
import json
import os
import sys
import time
import concurrent.futures as cf
import requests

BASE = "/Users/kjonekong/Documents/puer-ai/eval"
QUESTIONS = [json.loads(l) for l in open(f"{BASE}/questions.jsonl")]

MODELS = {
    "glm5.3": {
        "url": "https://open.bigmodel.cn/api/anthropic/v1/messages",
        "token_env": "GLM_TOKEN",
        "model": "glm-5.3",
        "no_think": True,
    },
    "deepseek": {
        "url": "https://api.deepseek.com/anthropic/v1/messages",
        "token_env": "DS_TOKEN",
        "model": "deepseek-v4-flash",
        "no_think": False,
    },
    "kimi": {
        "url": "https://api.moonshot.cn/anthropic/v1/messages",
        "token_env": "KIMI_TOKEN",
        "model": "kimi-k2.7-code-highspeed",
        "no_think": False,
    },
}

SYSTEM = (
    "你是一位有二十年经验的普洱茶专家。请直接、简洁地回答问题,"
    "不要客套,不确定时明确说明不确定。"
)

def call_once(cfg, q):
    body = {
        "model": cfg["model"],
        "max_tokens": 6000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": f"{q['id']}. {q['question']}"}],
    }
    if cfg["no_think"]:
        body["thinking"] = {"type": "disabled"}
    r = requests.post(
        cfg["url"],
        headers={
            "x-api-key": cfg["token"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return text.strip()

def run_one(cfg, out_path, done, q):
    if q["id"] in done:
        return None
    for attempt in range(3):
        try:
            ans = call_once(cfg, q)
            if not ans:
                raise ValueError("empty text response")
            return {"id": q["id"], "answer": ans}
        except Exception as e:
            if attempt == 2:
                return {"id": q["id"], "answer": "", "error": str(e)[:200]}
            time.sleep(3 * (attempt + 1))

def main():
    key = sys.argv[1]
    cfg = dict(MODELS[key])
    cfg["token"] = os.environ[cfg.pop("token_env")]
    out_dir = f"{BASE}/results/{key}"
    os.makedirs(out_dir, exist_ok=True)
    out_path = f"{out_dir}/answers.jsonl"
    done = set()
    if os.path.exists(out_path):
        for l in open(out_path):
            try:
                r = json.loads(l)
                # Only skip rows that actually produced an answer
                if r.get("answer") and not r.get("error"):
                    done.add(r["id"])
            except Exception:
                pass
    todo = [q for q in QUESTIONS if q["id"] not in done]
    print(f"[{key}] {len(done)} done, {len(todo)} to run")
    lock_write = open(out_path, "a", encoding="utf-8")
    n_ok = n_err = 0
    with cf.ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(run_one, cfg, out_path, done, q) for q in todo]
        for i, fut in enumerate(cf.as_completed(futures), 1):
            res = fut.result()
            if res is None:
                continue
            lock_write.write(json.dumps(res, ensure_ascii=False) + "\n")
            lock_write.flush()
            if res.get("error"):
                n_err += 1
                print(f"  [{i}/{len(todo)}] {res['id']} ERROR {res['error'][:80]}")
            else:
                n_ok += 1
                if i % 10 == 0 or i == len(todo):
                    print(f"  [{i}/{len(todo)}] ok")
    lock_write.close()
    print(f"[{key}] finished: {n_ok} ok, {n_err} error")

if __name__ == "__main__":
    main()
