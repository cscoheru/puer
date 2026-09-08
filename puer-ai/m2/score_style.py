#!/usr/bin/env python3
"""M2 style-regression scorer: compare {base,student}-val.jsonl against gold labels.

Metrics (expert style convergence):
1. 琥珀 occurrence rate (gold ≈ 0)
2. 透亮 occurrence rate + whether限定公道杯 context
3. 器物行话: 青瓷/青花/紫砂 correct-family mentions vs 白底蓝花/浅蓝/浅青/深色茶壶 misnames
4. color-term agreement with gold (汤色 rows only, exact color-word overlap)
5. type-prefix accuracy (汤色/叶底/版面...)
"""
import json
import re
import sys

BASE = "/Users/kjonekong/Documents/puer-ai"
COLOR_WORDS = ["黄绿", "浅黄", "金黄", "橙黄", "橙黄偏绿", "橙色", "深橙", "橙红", "红浓",
               "栗红", "红褐", "深栗", "琥珀", "红亮", "明黄", "偏绿"]
BAD_TERMS = ["白底蓝花", "浅蓝色", "浅青色", "深色茶壶", "黑色茶壶"]
GOOD_TERMS = ["青瓷", "青花", "紫砂", "汝窑"]

def load(path):
    try:
        rows = [json.loads(l) for l in open(path)]
    except FileNotFoundError:
        return None
    for r in rows:
        # strip empty think blocks produced by base/student inference
        r["answer"] = re.sub(r"<think>.*?</think>\s*", "", r["answer"], flags=re.S).strip()
    return rows

def score(rows, tag):
    n = len(rows)
    amber = sum(1 for r in rows if "琥珀" in r["answer"])
    toul = sum(1 for r in rows if "透亮" in r["answer"])
    toul_g = sum(1 for r in rows if "透亮" in r["gold"])
    bad = [(r["row"], t) for r in rows for t in BAD_TERMS if t in r["answer"]]
    good = sum(1 for r in rows if any(t in r["answer"] for t in GOOD_TERMS))
    good_g = sum(1 for r in rows if any(t in r["gold"] for t in GOOD_TERMS))
    # type prefix accuracy
    def typ(s):
        return s.split("|")[0].strip()
    type_ok = sum(1 for r in rows if typ(r["answer"]) == typ(r["gold"]))
    # color agreement on 汤色 rows
    ts = [r for r in rows if typ(r["gold"]) == "汤色"]
    def color(s):
        found = [w for w in COLOR_WORDS if w in s]
        return found[0] if found else ""
    col_ok = sum(1 for r in ts if color(r["answer"]) and color(r["answer"]) == color(r["gold"]))
    print(f"== {tag} (n={n}) ==")
    print(f"琥珀: {amber}/{n} (gold {sum(1 for r in rows if '琥珀' in r['gold'])})")
    print(f"透亮: {toul}/{n} (gold {toul_g})")
    print(f"行话器物(青瓷/青花/紫砂/汝窑): pred {good} vs gold {good_g} | 误称: {len(bad)} {bad[:3]}")
    print(f"类型前缀准确: {type_ok}/{n}")
    print(f"汤色色档一致: {col_ok}/{len(ts)}")
    # show mismatches
    for r in ts:
        if color(r["answer"]) != color(r["gold"]):
            print(f"  #{r['row']} gold[{color(r['gold'])}] pred[{color(r['answer'])}] {r['answer'][:48]}")
    print()

def main():
    for tag in ["base", "student"]:
        rows = load(f"{BASE}/m2-artifacts/{tag}-val.jsonl")
        if rows:
            score(rows, tag)
        else:
            print(f"== {tag}: no file ==")

if __name__ == "__main__":
    main()
