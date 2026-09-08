#!/usr/bin/env python3
"""M6 step 1: generate QA-format training samples with the teacher model.

Design constraints (v3 lessons):
  1. PERCEPTION/STYLE DOMAIN ONLY — aging/era/mark-number/identity questions
     are EXCLUDED (knowledge belongs in RAG, not weights — v3 proved SFT turns
     identity claims into hallucinations).
  2. Style rules injected (style-rules.md digest): 行话/透亮/琥珀/红浓 discipline.
  3. 3 red-dark correction cases (92下关沱/01下关8853/06福今砖) with the
     expert's 深橙红/褐红 verdicts as corrective QA pairs.
  4. ~15 free-writing 品鉴文案 samples (fixes the E13 repetition collapse:
     catalog-only SFT squeezes out free generation).

Output: data-engine/qa-pairs.jsonl {image, question, answer, qtype, note_title}
Resume-safe (append + seen by image+question).
"""
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "rag"))
from teacher_api import ask  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
COMBINED = f"{BASE}/sft-visual-combined-norm.jsonl"
OUT = f"{BASE}/qa-pairs.jsonl"
V1_IMG = f"{BASE}/dataset_v1/images"
CACHE = f"{BASE}/img-cache"
EVAL_IMG = f"{BASE}/../eval/images"

SYSTEM = """你是一位有二十年经验的普洱茶专家,正在为视觉模型制作训练答案。要求:
1 只描述图中可见的感知信息:颜色/形态/质地/版面印刷特征/文字内容。
2 严禁断言具体年份、唛号、厂家、价格——除非图中清晰可见相应文字。
3 风格规则:器物用行话(紫砂/青瓷/青花/汝窑);「透亮」只用于玻璃公道杯中确实透光见底的茶汤,品茗杯只说「明亮」;混浊如实说;汤色取档宁浅勿深;「琥珀」只用于干仓透亮老生茶;「红浓」只用于熟茶或湿仓生茶,干仓生茶(含老生茶)一律用深橙红/褐红/橙红/深栗;紧压茶条索说「紧结」不说「卷曲」。
4 回答直接、简洁、术语专业,2-5句话;品鉴文案题写100字左右。
5 不确定处明确说明,不编造。"""

Q_TEMPLATES = {
    "汤色": ["描述这杯茶汤的颜色与透亮度。",
             "从汤色判断这款茶的发酵程度与仓储状态,说明依据。",
             "一位资深茶客会如何描述这杯茶汤?颜色、亮度、清澈度分别怎么说?"],
    "叶底": ["根据叶底判断工艺与用料等级,说明依据与不确定性。",
             "描述叶底的状态(色泽/柔软度/完整度),判断大致采摘标准。"],
    "饼面": ["描述这个饼面的条索与色泽特征。",
             "从饼面看用料等级与压制松紧,说明依据。"],
    "饼背": ["描述饼窝特征与压制方式,判断松紧度。"],
    "版面": ["描述这个版面的印刷特征(颜色/版式/文字内容)。不要推测厂家与年代。"],
    "内飞或特写": ["解读图中内飞/特写的可见信息与鉴别特征(字体/版式),不确定的要说明。"],
    "大票或内票": ["解读图中大票/内票承载的信息及其在溯源中的角色。"],
    "其他": ["描述图中的主体与关键细节。"],
}
PLAN = {"汤色": 60, "叶底": 25, "饼面": 25, "饼背": 8, "版面": 15,
        "内飞或特写": 3, "大票或内票": 3, "其他": 6}
TASTING_N = 12  # free-writing 品鉴文案 (from 汤色/饼面 rows)

# red-dark correction pairs (expert verdicts, 2026-08-17)
RED_DARK_CASES = [
    {"img": f"{V1_IMG}/49e8acabf654.jpg", "title": "92下关八中商检沱",
     "answer_hint": "生茶,深汤色干仓老生茶,应描述为深橙红或褐红、透亮,不用红浓"},
    {"img": f"{V1_IMG}/fcaa14e9fcac.jpg", "title": "2001-下关8853",
     "answer_hint": "生茶,汤色深橙红或浅褐红,较为混浊如实说,不用红浓"},
    {"img": f"{V1_IMG}/51c90b717721.jpg", "title": "2006-福今布朗青砖",
     "answer_hint": "生茶,深橙红或褐红、近琥珀色、较为透亮,不用红浓"},
]

write_lock = threading.Lock()
seen = set()


def resolve_image(url):
    fn = url.split("/")[-1]
    for d in (V1_IMG, CACHE):
        p = f"{d}/{fn}"
        if os.path.exists(p):
            return p
    return None


def load_seen():
    if os.path.exists(OUT):
        for l in open(OUT, encoding="utf-8"):
            try:
                r = json.loads(l)
                seen.add(r["image"] + "|" + r["question"])
            except Exception:
                pass


def gen_one(img, question, qtype, title):
    key = img + "|" + question
    if key in seen:
        return None
    ans = ask(question, images=[img], system=SYSTEM, max_tokens=1200)
    if not ans:
        return None
    rec = {"image": img, "question": question, "answer": ans,
           "qtype": qtype, "note_title": title}
    with write_lock:
        seen.add(key)
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main():
    random.seed(42)
    load_seen()
    print(f"resume: {len(seen)} done")
    rows = [json.loads(l) for l in open(COMBINED, encoding="utf-8")]
    by_type = {}
    for r in rows:
        t = r["label"].split("|")[0].strip()
        by_type.setdefault(t, []).append(r)

    jobs = []
    for t, n in PLAN.items():
        pool = by_type.get(t, [])
        for r in random.sample(pool, min(n, len(pool))):
            img = resolve_image(r["image"])
            if not img:
                continue
            jobs.append((img, random.choice(Q_TEMPLATES[t]), t, r["note_title"]))
    # tasting free-writing samples
    tasting_pool = [r for r in by_type.get("汤色", []) + by_type.get("饼面", [])
                    if resolve_image(r["image"])]
    for r in random.sample(tasting_pool, TASTING_N):
        img = resolve_image(r["image"])
        jobs.append((img, "根据这张图为这款茶写一段100字左右的专业品鉴文案。", "品鉴文案", r["note_title"]))
    # red-dark corrective pairs
    for c in RED_DARK_CASES:
        q = (f"这杯茶汤颜色很深,可以用「红浓」来形容吗?请描述其颜色并说明用词依据。"
             f"(提示:{c['answer_hint']})")
        jobs.append((c["img"], q, "红浓纠正", c["title"]))

    print(f"planned {len(jobs)} QA jobs")
    done = fail = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(gen_one, *j) for j in jobs]
        for i, fut in enumerate(futs, 1):
            r = fut.result()
            if r:
                done += 1
            elif fut.exception() is None:
                pass
            else:
                fail += 1
            if i % 20 == 0 or i == len(futs):
                print(f"{i}/{len(futs)} +{done} fail={fail}", flush=True)
    print(f"DONE +{done} new, total {len(seen)} -> {OUT}")


if __name__ == "__main__":
    main()
