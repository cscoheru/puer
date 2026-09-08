#!/usr/bin/env python3
"""v3 style-regression scorer: extends score_style.py with v3 type-name
normalization (gold labels are v1-era; v3 student answers use canonical
merged type names). Compares base / student-v2 / student-v3 on the same
val-25 set so versions are directly comparable.

Canonical merge map (from normalize_v3_types.py, deterministic):
  内飞 / 特写 -> 内飞或特写; 大票 -> 大票或内票; 砖面 -> 饼面; 砖背 -> 饼背
Also adds a 红浓 usage count (rule added in v3: 红浓 only for 熟茶/湿仓).
"""
import json
import re

BASE = "/Users/kjonekong/Documents/puer-ai/m2-artifacts"
RUNS = {
    "base": f"{BASE}/base-val.jsonl",
    "student-v2": f"{BASE}/student-val.jsonl",
    "student-v3": f"{BASE}/v3/student-val.jsonl",
    "student-v4": f"{BASE}/v4/student-val.jsonl",
}
COLOR_WORDS = ["黄绿", "浅黄", "金黄", "橙黄", "橙黄偏绿", "橙色", "深橙", "橙红", "红浓",
               "栗红", "红褐", "深栗", "琥珀", "红亮", "明黄", "偏绿", "酱油色", "深栗色"]
BAD_TERMS = ["白底蓝花", "浅蓝色", "浅青色", "深色茶壶", "黑色茶壶"]
GOOD_TERMS = ["青瓷", "青花", "紫砂", "汝窑"]
TYPE_MAP = {"内飞": "内飞或特写", "特写": "内飞或特写", "大票": "大票或内票",
            "砖面": "饼面", "砖背": "饼背"}

def load(path):
    rows = [json.loads(l) for l in open(path)]
    for r in rows:
        # strip empty/padded think blocks produced at inference time
        r["answer"] = re.sub(r"<think>.*?</think>\s*", "", r["answer"], flags=re.S).strip()
    return rows

def typ(s, norm):
    t = s.split("|")[0].strip()
    if norm:
        t = TYPE_MAP.get(t, t)
    return t

def color(s):
    found = [w for w in COLOR_WORDS if w in s]
    return found[0] if found else ""

def score(rows, tag, norm_types):
    n = len(rows)
    amber = sum(1 for r in rows if "琥珀" in r["answer"])
    hong = sum(1 for r in rows if "红浓" in r["answer"])
    hong_g = sum(1 for r in rows if "红浓" in r["gold"])
    toul = sum(1 for r in rows if "透亮" in r["answer"])
    toul_g = sum(1 for r in rows if "透亮" in r["gold"])
    bad = [(r["row"], t) for r in rows for t in BAD_TERMS if t in r["answer"]]
    good = sum(1 for r in rows if any(t in r["answer"] for t in GOOD_TERMS))
    good_g = sum(1 for r in rows if any(t in r["gold"] for t in GOOD_TERMS))
    type_ok = sum(1 for r in rows if typ(r["answer"], norm_types) == typ(r["gold"], norm_types))
    ts = [r for r in rows if typ(r["gold"], norm_types) == "汤色"]
    col_ok = sum(1 for r in ts if color(r["answer"]) and color(r["answer"]) == color(r["gold"]))
    print(f"== {tag} (n={n}, norm_types={norm_types}) ==")
    print(f"琥珀: {amber} (gold {sum(1 for r in rows if '琥珀' in r['gold'])}) | "
          f"红浓: {hong} (gold {hong_g}) | 透亮: {toul} (gold {toul_g})")
    print(f"行话器物 pred {good} vs gold {good_g} | 非行话误称: {len(bad)} {bad[:4]}")
    print(f"类型前缀准确: {type_ok}/{n} | 汤色色档一致: {col_ok}/{len(ts)}")
    for r in ts:
        if color(r["answer"]) != color(r["gold"]):
            print(f"  #{r['row']} gold[{color(r['gold'])}] pred[{color(r['answer'])}] {r['answer'][:44]}")
    print()

def main():
    for tag, path in RUNS.items():
        try:
            rows = load(path)
        except FileNotFoundError:
            print(f"== {tag}: no file ==\n"); continue
        # base never saw merged names; v2 answers are v1-era names; v3+ uses canonical
        score(rows, tag, norm_types=(tag in ("student-v3", "student-v4")))

if __name__ == "__main__":
    main()
