#!/usr/bin/env python3
"""M2 step 1: build LLaMA-Factory multimodal dataset from sft-visual-final.jsonl.

Output: dataset_v1/{train.json, val.json, images/, dataset_info.json}
- Same task framing as the teacher (catalog one-liner) for distillation consistency.
- 9:1 train/val split, stratified by image type prefix (汤色/叶底/版面/饼面/...).
"""
import json
import os
import random
import shutil

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
SRC = f"{BASE}/sft-visual-final-norm.jsonl"  # vessel-term normalized (M2.5a)
CACHE = f"{BASE}/img-cache"
OUT = f"{BASE}/dataset_v1"
IMGS = f"{OUT}/images"

SYSTEM = ("你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:"
          "汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。"
          "描述一句话,含颜色/状态等可验证细节。")

random.seed(42)

def main():
    os.makedirs(IMGS, exist_ok=True)
    rows = [json.loads(l) for l in open(SRC)]
    samples = []
    for r in rows:
        fname = r["image"].rsplit("/", 1)[-1]
        src = f"{CACHE}/{fname}"
        if not os.path.exists(src):
            print(f"SKIP missing image: {fname}")
            continue
        typ = r["label"].split("|")[0].strip()
        samples.append({
            "fname": fname, "typ": typ, "label": r["label"],
            "provenance": r["provenance"], "row": r["row"],
        })
    # stratified split by type
    by_typ = {}
    for s in samples:
        by_typ.setdefault(s["typ"], []).append(s)
    train, val = [], []
    for typ, group in sorted(by_typ.items()):
        random.shuffle(group)
        n_val = max(1, round(len(group) * 0.1)) if len(group) >= 2 else (1 if len(group) > 5 else 0)
        val.extend(group[:n_val])
        train.extend(group[n_val:])
    random.shuffle(train)
    random.shuffle(val)
    print(f"total {len(samples)} | train {len(train)} | val {len(val)}")
    print("val types:", {t: sum(1 for s in val if s["typ"] == t) for t in sorted(set(s['typ'] for s in val))})

    def to_lf(samples, path):
        with open(path, "w", encoding="utf-8") as f:
            for s in samples:
                shutil.copy(f"{CACHE}/{s['fname']}", f"{IMGS}/{s['fname']}")
                f.write(json.dumps({
                    "messages": [
                        {"role": "system", "content": SYSTEM},
                        {"role": "user", "content": "<image>编目这张图。"},
                        {"role": "assistant", "content": s["label"]},
                    ],
                    "images": [f"images/{s['fname']}"],
                }, ensure_ascii=False) + "\n")

    to_lf(train, f"{OUT}/train.json")
    to_lf(val, f"{OUT}/val.json")
    info = {
        "puer_visual_v1_train": {
            "file_name": "train.json", "formatting": "sharegpt",
            "columns": {"messages": "messages", "images": "images"},
            "tags": {"role_tag": "role", "content_tag": "content", "user_tag": "user",
                     "assistant_tag": "assistant", "system_tag": "system"},
        },
        "puer_visual_v1_val": {
            "file_name": "val.json", "formatting": "sharegpt",
            "columns": {"messages": "messages", "images": "images"},
            "tags": {"role_tag": "role", "content_tag": "content", "user_tag": "user",
                     "assistant_tag": "assistant", "system_tag": "system"},
        },
    }
    json.dump(info, open(f"{OUT}/dataset_info.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    # sidecar mapping for later style-regression scoring (row -> final label)
    with open(f"{OUT}/val-keys.json", "w", encoding="utf-8") as f:
        for s in val:
            f.write(json.dumps({"row": s["row"], "fname": s["fname"], "label": s["label"]},
                               ensure_ascii=False) + "\n")
    print("done ->", OUT)

if __name__ == "__main__":
    main()
