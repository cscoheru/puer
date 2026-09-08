#!/usr/bin/env python3
"""M6 step 2: assemble LLaMA-Factory dataset_v4 = catalog(436) + QA(~145).

v3 lessons baked in:
  - QA pairs keep the student in open-answer mode (v3's catalog-only squeeze
    degraded E-class reasoning: 6/12 -> 3.5/12).
  - SYSTEM adds the read-don't-guess law: transcribe visible text only; never
    INFER factory/era/mark-number from liquor color, leaf bottom or layout.
  - Red-dark single-image rule updated with the 2026-08-17 expert verdicts.

Split: 9:1 stratified by task kind (catalog vs QA). Images copied into
dataset_v4/images/ (catalog: url-hash names; QA: qa-<n>.jpg).
"""
import json
import os
import random
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE = os.path.dirname(os.path.abspath(__file__))
V3 = f"{BASE}/dataset_v3"
QA = f"{BASE}/qa-pairs.jsonl"
OUT = f"{BASE}/dataset_v4"

SYSTEM = """你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。描述一句话,含颜色/状态等可验证细节。
行规约束:
1 汤色颜色贴图取档宁浅勿深:橙黄勿说橙红,深橙勿说琥珀。
2 「透亮」只用于玻璃公道杯中确实透光见底的茶汤(能看到公道杯对面的物品);品茗杯等小杯只说「明亮」;混浊就诚实说混浊。
3 「琥珀色」只用于干仓透亮老生茶;湿仓茶汤色用「红浓明亮」。
4 「红浓」只用于熟茶或湿仓生茶;单张汤色图无法确认茶类时一律按干仓生茶档(深橙红/褐红/橙红/深栗),禁用红浓。
5 器物用行话:紫砂壶/青瓷/青花/汝窑;禁用深色茶壶/浅青色/浅蓝色/白底蓝花等说法。
6 紧压茶条索用「紧结」不用「卷曲」;叶片尚未泡开时不写「舒展完整」。
7 只转录图中可见文字;严禁从汤色、叶底、版式风格推断厂家、年代、唛号——图上没写的字不许出现。
8 饼面/版面/内飞等一目了然的主体一句话说完不啰嗦;无破损不提破损;塑料膜/拍摄背景等环境物不写。"""

SYSTEM_QA = """你是一位有二十年经验的普洱茶专家。请直接、简洁地回答,术语专业,不确定时明确说明。
行规约束:
1 汤色取档宁浅勿深;「透亮」只用于玻璃公道杯中确实透光见底的茶汤;「琥珀」只用于干仓透亮老生茶。
2 「红浓」只用于熟茶或湿仓生茶;单张汤色图无法确认茶类时一律按干仓生茶档(深橙红/褐红/橙红/深栗),禁用红浓。
3 器物用行话:紫砂壶/青瓷/青花/汝窑。
4 只转录图中可见文字;严禁从汤色、叶底、版式风格推断厂家、年代、唛号——图上没写的字不许出现。
5 描述限于可见的感知信息;品鉴文案可适度发挥但不得编造年份与身份。"""

USER_CATALOG = "编目这张图。"


def load_catalog():
    """v3 train+val pairs (already normalized), rebuilt into v4 messages."""
    pairs = []
    for split in ("train.json", "val.json"):
        with open(f"{V3}/{split}", encoding="utf-8") as f:
            text = f.read().strip()
        try:
            recs = json.loads(text)          # JSON array
        except json.JSONDecodeError:
            recs = [json.loads(l) for l in text.splitlines() if l.strip()]  # JSONL
        for r in recs:
            msgs = r["messages"]
            img = r["images"][0]
            gold = next(m["content"] for m in msgs if m["role"] == "assistant")
            pairs.append({"kind": "catalog", "image": img, "gold": gold})
    return pairs


def resolve_any(p):
    if os.path.exists(p):
        return p
    for cand in (f"{BASE}/{p}",
                 f"{BASE}/dataset_v1/images/{os.path.basename(p)}",
                 f"{BASE}/img-cache/{os.path.basename(p)}"):
        if os.path.exists(cand):
            return cand
    return None


def main():
    random.seed(42)
    os.makedirs(f"{OUT}/images", exist_ok=True)

    catalog = load_catalog()
    qa_rows = [json.loads(l) for l in open(QA, encoding="utf-8")] if os.path.exists(QA) else []
    print(f"catalog {len(catalog)}, qa {len(qa_rows)}")

    samples = []
    for c in catalog:
        src = f"{V3}/{c['image']}"
        fn = os.path.basename(c["image"])
        shutil.copy(src, f"{OUT}/images/{fn}")
        samples.append({
            "kind": "catalog",
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": f"<image>{USER_CATALOG}"},
                         {"role": "assistant", "content": c["gold"]}],
            "images": [f"images/{fn}"],
        })
    for i, q in enumerate(qa_rows):
        fn = f"qa-{i:04d}.jpg"
        src = resolve_any(q["image"])
        if not src:
            print(f"WARN: qa image missing: {q['image']}"); continue
        shutil.copy(src, f"{OUT}/images/{fn}")
        samples.append({
            "kind": "qa",
            "messages": [{"role": "system", "content": SYSTEM_QA},
                         {"role": "user", "content": f"<image>{q['question']}"},
                         {"role": "assistant", "content": q["answer"]}],
            "images": [f"images/{fn}"],
        })

    # stratified 9:1 by kind
    cats = [s for s in samples if s["kind"] == "catalog"]
    qas = [s for s in samples if s["kind"] == "qa"]
    random.shuffle(cats); random.shuffle(qas)
    n_cat_val = max(1, round(len(cats) * 0.1))
    n_qa_val = max(1, round(len(qas) * 0.1))
    val = cats[:n_cat_val] + qas[:n_qa_val]
    train = cats[n_cat_val:] + qas[n_qa_val:]
    random.shuffle(train); random.shuffle(val)

    for split, data in (("train.json", train), ("val.json", val)):
        out = []
        for s in data:
            out.append({"messages": s["messages"], "images": s["images"]})
        json.dump(out, open(f"{OUT}/{split}", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    json.dump({
        "puer_visual_v4_train": {"file_name": "train.json", "formatting": "sharegpt",
                                  "columns": {"messages": "messages", "images": "images"},
                                  "tags": {"role_tag": "role", "content_tag": "content",
                                            "user_tag": "user", "assistant_tag": "assistant"}},
        "puer_visual_v4_val": {"file_name": "val.json", "formatting": "sharegpt",
                                "columns": {"messages": "messages", "images": "images"},
                                "tags": {"role_tag": "role", "content_tag": "content",
                                          "user_tag": "user", "assistant_tag": "assistant"}},
    }, open(f"{OUT}/dataset_info.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"train {len(train)} (catalog {len(cats)-n_cat_val} + qa {len(qas)-n_qa_val}) | "
          f"val {len(val)} (catalog {n_cat_val} + qa {n_qa_val}) -> {OUT}")


if __name__ == "__main__":
    main()
