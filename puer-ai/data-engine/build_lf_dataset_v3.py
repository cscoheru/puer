#!/usr/bin/env python3
"""M5: build LLaMA-Factory multimodal dataset v3 from the combined 436 pairs.

Changes vs dataset_v1 (M2):
- source = sft-visual-combined-norm.jsonl (batch-1 236 + batch-2 200)
- SYSTEM prompt now carries the distilled 行规 (rules-in-system, matching the
  batch-2 teacher) so the student enforces them at train AND inference time.
- 9:1 stratified split by type prefix.
"""
import json
import os
import random
import shutil

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
SRC = f"{BASE}/sft-visual-combined-norm.jsonl"
CACHE = f"{BASE}/img-cache"
OUT = f"{BASE}/dataset_v3"
IMGS = f"{OUT}/images"

SYSTEM = ("你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:"
          "汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。"
          "描述一句话,含颜色/状态等可验证细节。\n"
          "行规约束:\n"
          "1 汤色贴图取档宁浅勿深:橙黄勿说橙红,深橙勿说琥珀。\n"
          "2 「透亮」只用于玻璃公道杯中确实透光见底(能看到杯对面物品)的茶汤;"
          "品茗杯等小杯只说「明亮」;混浊就诚实说混浊。\n"
          "3 「琥珀色」只用于干仓透亮老生茶。\n"
          "4 「红浓」只用于熟茶或湿仓生茶;干仓生茶(含老生茶)用深橙红/褐红/橙红/深栗。\n"
          "5 器物用行话:紫砂壶/青瓷/青花/汝窑;禁用深色茶壶/浅青色/浅蓝色/白底蓝花。\n"
          "6 紧压茶条索用「紧结」不用「卷曲」;叶片未泡开不写「舒展完整」。\n"
          "7 一目了然的主体一句话说完不啰嗦;无破损不提破损;塑料膜/拍摄背景等环境物不写。")

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
        samples.append({"fname": fname, "typ": typ, "label": r["label"],
                        "provenance": r["provenance"], "row": r["row"]})
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
    print("types:", {t: len(g) for t, g in sorted(by_typ.items())})

    def to_lf(subset, path):
        with open(path, "w", encoding="utf-8") as f:
            for s in subset:
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
    info = {}
    for name, fn in [("puer_visual_v3_train", "train.json"), ("puer_visual_v3_val", "val.json")]:
        info[name] = {"file_name": fn, "formatting": "sharegpt",
                      "columns": {"messages": "messages", "images": "images"},
                      "tags": {"role_tag": "role", "content_tag": "content", "user_tag": "user",
                               "assistant_tag": "assistant", "system_tag": "system"}}
    json.dump(info, open(f"{OUT}/dataset_info.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    with open(f"{OUT}/val-keys.json", "w", encoding="utf-8") as f:
        for s in val:
            f.write(json.dumps({"row": s["row"], "fname": s["fname"], "label": s["label"]},
                               ensure_ascii=False) + "\n")
    print("done ->", OUT)

if __name__ == "__main__":
    main()
