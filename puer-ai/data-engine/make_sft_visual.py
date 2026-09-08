#!/usr/bin/env python3
"""M1-B: image manifest + expert keys -> visual instruction pairs (seed set).

Output: sft-visual-seed.jsonl — llava-style conversations with local image path.
Bulk visual pairs will come from teacher prelabel (M1-C) after expert review.
"""
import json
import os

MANIFEST = "/Users/kjonekong/Documents/puer-ai/eval/images/manifest.jsonl"
OUT = "/Users/kjonekong/Documents/puer-ai/data-engine/sft-visual-seed.jsonl"

rows = [json.loads(l) for l in open(MANIFEST)]
n = 0
with open(OUT, "w", encoding="utf-8") as f:
    for r in rows:
        tag = r["tag"]
        ident = r.get("actual_identity") or r.get("note_title", "")
        if ident.startswith(("（资料）", "(资料)")):
            ident = ident.replace("（资料）", "").replace("(资料)", "").strip()
        img = f"/Users/kjonekong/Documents/puer-ai/eval/images/{tag}.jpg"
        if not os.path.exists(img):
            continue
        # pair 1: what is this image type
        f.write(json.dumps({
            "image": img,
            "conversations": [
                {"from": "human", "value": f"<image>\n这张图属于普洱茶评测的哪类素材(汤色/叶底/饼面/饼背/版面/内票/大票)?"},
                {"from": "gpt", "value": r["type"]},
            ],
        }, ensure_ascii=False) + "\n")
        # pair 2: identity QA (only when title is an actual SKU-ish identity)
        if any(c.isdigit() for c in ident) and len(ident) >= 6:
            f.write(json.dumps({
                "image": img,
                "conversations": [
                    {"from": "human", "value": "<image>\n这饼茶的茶品身份是什么(尽可能给出厂家/唛号/年代)?"},
                    {"from": "gpt", "value": f"该图为「{ident}」的{r['type']}素材。" + (f"(注:{r['identity_fix']})" if r.get("identity_fix") else "")},
                ],
            }, ensure_ascii=False) + "\n")
        n += 1

print(f"images covered: {n}, output: {OUT}")
