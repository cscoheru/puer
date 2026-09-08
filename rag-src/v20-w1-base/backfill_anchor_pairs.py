#!/usr/bin/env python3
"""W4 anchor-pair 训练数据补采。

为什么: W3 评测发现 3 类 hard-negative:
  - 越陈越香: 5666 (八角亭2006越陈越香熟) 被 M3 误判为 5878 (八角亭2009金贡品)
  - 咖啡大益: 2608/3087 同 anchor, W3-HEIC iPhone 实拍 3 候选 dino_sim=0.84+ 全锚词命中
  - 八角亭金贡品: 5878 W2-1 dedup 路由到 9174 杨聘号 (跨 anchor)
需要为每个 anchor-pair 收集 (anchor, sku_a, sku_b) 三元组, 5-10 张图/SKU,
供 M3 fine-tune 用。

输入: /opt/puer-hub/rag-data/donghe-skus.jsonl + donghe-images/{sku}.jpeg
输出: /opt/puer-hub/rag-data/eval/anchor_pairs/pairs.json

回滚: rm -rf /opt/puer-hub/rag-data/eval/anchor_pairs/ 即可, 不影响其他数据
"""
import hashlib
import json
import os
import sys
from pathlib import Path

DONGHE_SKUS = "/opt/puer-hub/rag-data/donghe-skus.jsonl"
DONGHE_IMG_DIR = "/opt/puer-hub/rag-data/donghe-images"
OUT_DIR = "/opt/puer-hub/rag-data/eval/anchor_pairs"

ANCHOR_PAIRS = [
    # === 越陈越香 anchor ===
    ("越陈越香", "1933", "1705",
     "2004年 401 越陈越香普饼", "701 越陈越香"),
    ("越陈越香", "1668", "1657",
     "001 越陈越香", "901 越陈越香"),
    # === 咖啡大益 anchor ===
    ("咖啡大益", "3087", "2608",
     "2003年 917 咖啡大益7542", "2003年 918 咖啡大益7592"),
    ("大益唛号", "3087", "9505",
     "2003年 917 咖啡大益7542", "2501 金大益"),
    # === 八角亭 anchor ===
    ("八角亭", "5878", "5666",
     "八角亭2009年金贡品", "八角亭2006年越陈越香（熟）"),
    ("八角亭", "5878", "6712",
     "八角亭2009年金贡品", "八角亭2022年峻逸"),
    # === 班章 anchor ===
    ("班章", "1795", "9388",
     "2003年 班章四星青饼", "2501 班章四星孔雀生态茶(散提)"),
]


def file_sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_skus():
    skus = {}
    with open(DONGHE_SKUS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            skus[r["skuId"]] = r
    return skus


def find_unique_images(sku_id, max_n=5):
    img_dir = Path(DONGHE_IMG_DIR)
    candidates = sorted(list(img_dir.glob(f"{sku_id}.jpeg")) + list(img_dir.glob(f"{sku_id}.jpg")))
    if not candidates:
        return []
    seen_sha = set()
    out = []
    for p in candidates:
        if len(out) >= max_n:
            break
        try:
            sha = file_sha1(str(p))[:12]
        except Exception:
            continue
        if sha in seen_sha:
            continue
        seen_sha.add(sha)
        out.append({"filename": p.name, "sha1": sha, "abs_path": str(p)})
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    skus = load_skus()
    pairs_out = []
    n_with_data = 0
    for anchor, sku_a, sku_b, name_a, name_b in ANCHOR_PAIRS:
        imgs_a = find_unique_images(sku_a)
        imgs_b = find_unique_images(sku_b)
        rec = {
            "anchor": anchor,
            "sku_a": sku_a,
            "name_a": name_a,
            "sku_b": sku_b,
            "name_b": name_b,
            "imgs_a": imgs_a,
            "imgs_b": imgs_b,
            "tea_type_a": (skus.get(sku_a) or {}).get("tea_type"),
            "tea_type_b": (skus.get(sku_b) or {}).get("tea_type"),
        }
        pairs_out.append(rec)
        status = "OK" if (imgs_a and imgs_b) else "MISS"
        print(f"{status} {anchor} {sku_a}({len(imgs_a)}) <-> {sku_b}({len(imgs_b)})")
        if imgs_a and imgs_b:
            n_with_data += 1
    out_path = os.path.join(OUT_DIR, "pairs.json")
    with open(out_path, "w") as f:
        json.dump({"pairs": pairs_out, "n_total": len(pairs_out),
                   "n_with_data": n_with_data}, f, ensure_ascii=False, indent=2)
    print(f"\nwrote {out_path}: {n_with_data}/{len(pairs_out)} pairs with data")
    return 0 if n_with_data >= len(ANCHOR_PAIRS) * 0.7 else 1


if __name__ == "__main__":
    sys.exit(main())