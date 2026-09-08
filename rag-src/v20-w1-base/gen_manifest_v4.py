#!/usr/bin/env python3
"""W4 anchor-pair eval manifest 生成。

读取 pairs.json, 每个 pair 生成 2 cases:
  - case "X→Y": query=X 的图, expected=Y 的图 (rank-1 应是 SKU B)
  - case "Y→X": 镜像

score_mode=verdict: M3 必须区分出 "不同 SKU 同 anchor",
期望 forbidden_verdicts=[same_product] (M3 若说 same_product 即错)。

输出: /opt/puer-hub/rag-data/eval/manifest.v4.jsonl
"""
import json
import os
import sys

PAIRS = "/opt/puer-hub/rag-data/eval/anchor_pairs/pairs.json"
OUT = "/opt/puer-hub/rag-data/eval/manifest.v4.jsonl"


def main():
    pairs = json.loads(open(PAIRS).read())["pairs"]
    out = []
    for p in pairs:
        if not p["imgs_a"] or not p["imgs_b"]:
            continue
        # 用 SKU A 的图当 query, 期望 SKU B 命中 (rank-1 == B)
        for direction, qimg, qsku, qname, gsku, gname in [
            ("a→b", p["imgs_a"][0], p["sku_a"], p["name_a"], p["sku_b"], p["name_b"]),
            ("b→a", p["imgs_b"][0], p["sku_b"], p["name_b"], p["sku_a"], p["name_a"]),
        ]:
            case_id = f"w4-anchor-{p['anchor']}-{qsku}-vs-{gsku}-{direction}"
            case = {
                "case_id": case_id,
                "image_path": f"donghe-images/{qimg['filename']}",
                "image_abs": qimg["abs_path"],
                "image_type": "jpeg",
                "ocr_text": "",
                "expected_sku": gsku,
                "expected_name": gname,
                "allowed_verdicts": ["same_series_variant", "uncertain"],
                "forbidden_verdicts": ["same_product"],
                "category": "anchor-pair-distinction",
                "tags": ["must-include", "w4-anchor-pair", f"w4-anchor-{p['anchor']}"],
                "score_modes": ["recall", "verdict"],
                "notes": (
                    f"W4 anchor-pair: query={qsku}({qname}) same anchor '{p['anchor']}' as "
                    f"ground-truth {gsku}({gname}). M3 必须区分两者, 不能判 same_product。"
                    f"image_sha1={qimg['sha1']}."
                ),
            }
            out.append(case)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        for c in out:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"wrote {OUT}: {len(out)} cases from {len(pairs)} pairs")
    return 0


if __name__ == "__main__":
    sys.exit(main())