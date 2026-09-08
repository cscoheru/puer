#!/usr/bin/env python3
"""M5: deterministic type-prefix normalization on the combined v3 pairs.

Zero-hallucination mappings (type prefix only; descriptions untouched):
  - fix '·' separator -> '|' (1 malformed label)
  - 内飞/特写 -> 内飞或特写 ; 大票 -> 大票或内票
  - 砖面 -> 饼面 ; 砖背 -> 饼背   (shape variants fold into canonical types)
  - strip trailing whitespace
"""
import json
import collections

F = "/Users/kjonekong/Documents/puer-ai/data-engine/sft-visual-combined-norm.jsonl"
TYPE_MAP = {"内飞": "内飞或特写", "特写": "内飞或特写",
            "大票": "大票或内票", "砖面": "饼面", "砖背": "饼背"}

rows = [json.loads(l) for l in open(F, encoding="utf-8")]
changed = collections.Counter()
for r in rows:
    l = r["label"]
    orig = l
    if " · " in l and "|" not in l:      # malformed separator
        l = l.replace(" · ", " | ", 1)
        changed["separator"] += 1
    l = l.strip()
    typ, sep, rest = l.partition("|")
    typ = typ.strip()
    if typ in TYPE_MAP:
        l = f"{TYPE_MAP[typ]} | {rest.strip()}"
        changed[f"{typ}->{TYPE_MAP[typ]}"] += 1
    else:
        l = f"{typ} | {rest.strip()}"
    if l != orig:
        r["label"] = l

with open(F, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

# verify all canonical now
CANON = {"汤色", "叶底", "饼面", "饼背", "版面", "内飞或特写", "大票或内票", "其他"}
c = collections.Counter(r["label"].split("|")[0].strip() for r in rows)
bad = {t: n for t, n in c.items() if t not in CANON}
print("changes:", dict(changed))
print("type dist:", dict(sorted(c.items(), key=lambda x: -x[1])))
print("non-canonical remaining:", bad or "NONE")
