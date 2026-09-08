#!/usr/bin/env python3
"""Download all Donghe SKU images (public OSS links) with polite concurrency.

Resume-safe: skips existing files >1KB. Failures logged to
donghe-img-failed.txt for a final retry pass. Files: rag/donghe-images/{skuId}.jpeg
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
SKUS = f"{HERE}/donghe-skus.jsonl"
IMG_DIR = f"{HERE}/donghe-images"
FAILED = f"{HERE}/donghe-img-failed.txt"
WORKERS = 8
TIMEOUT = 25
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

os.makedirs(IMG_DIR, exist_ok=True)
SESSION = requests.Session()
SESSION.headers["User-Agent"] = UA

done = fail = 0
t0 = time.time()


def fetch_one(rec):
    sid = rec["skuId"]
    url = rec.get("img")
    if not url:
        return sid, False
    path = f"{IMG_DIR}/{sid}.jpeg"
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        return sid, True
    for attempt in range(3):
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            if r.status_code == 200 and len(r.content) > 1024:
                tmp = path + ".part"
                with open(tmp, "wb") as f:
                    f.write(r.content)
                os.replace(tmp, path)
                return sid, True
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))
    return sid, False


def main():
    rows = [json.loads(l) for l in open(SKUS, encoding="utf-8")]
    print(f"to download: {len(rows)} (workers={WORKERS})")
    failures = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_one, r): r["skuId"] for r in rows}
        for i, fut in enumerate(as_completed(futs), 1):
            sid, ok = fut.result()
            if ok:
                global done
                done += 1
            else:
                global fail
                fail += 1
                failures.append(sid)
            if i % 500 == 0 or i == len(rows):
                rate = i / max(time.time() - t0, 1)
                eta = (len(rows) - i) / max(rate, 0.01)
                print(f"{i}/{len(rows)} ok={done} fail={fail} {rate:.1f}/s eta {eta/60:.0f}min", flush=True)
    with open(FAILED, "w") as f:
        f.write("\n".join(failures))
    print(f"DONE ok={done} fail={fail} -> {IMG_DIR} ({len(os.listdir(IMG_DIR))} files)")


if __name__ == "__main__":
    main()
