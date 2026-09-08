#!/usr/bin/env python3
"""F1 acceptance checker.

Reads the F1 pool capture + (optionally) the B3-v2 capture for LOST diff
and reports the two acceptance criteria from the 12:05 Cursor directive:

  - cases whose compare-set contains >=1 candidate with via=sibling:*    >= 10/90
  - anchor-pair cases whose expected reaches the compare set             >= 8/28

LOST detection: cases that were in the b3v2 compare set but are no longer
in the F1 compare set (same definition = target_in_pool). The b3v2 file
needs only `score_mode == "recall"` rows for LOST (the verdict rows have
no target_in_pool). Expectation: sibling reserved slots surface more
expected siblings without evicting ones the B3-v2 path already caught.
"""
import json
import sys
from collections import Counter, defaultdict

NEW = sys.argv[1] if len(sys.argv) > 1 \
    else "/opt/puer-hub/rag-data/eval/scores.v5.f1.pool.jsonl"
OLD = sys.argv[2] if len(sys.argv) > 2 \
    else "/opt/puer-hub/rag-data/eval/scores.v5.b3v2.jsonl"
MANIFEST = "/opt/puer-hub/rag-data/eval/manifest.v5.jsonl"

cases = {}
with open(MANIFEST, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        r = json.loads(line)
        cases[r["case_id"]] = r

def _read(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("score_mode") != "recall":
                continue
            out[r["case_id"]] = r
    return out

new = _read(NEW)
old = _read(OLD)

# Filter: eval-aware = expect_refusal != True (matches the 90-case e12 denom)
eval_ids = [cid for cid, c in cases.items() if not c.get("expect_refusal")]
refusal_ids = [cid for cid, c in cases.items() if c.get("expect_refusal")]

def _expected_in_compare(rec, expected):
    if not rec or not expected:
        return False
    for c in (rec.get("candidates") or []):
        sids = [str(s) for s in (c.get("skuIds") or [])] + [str(c.get("skuId"))]
        if str(expected) in sids:
            return True
    return False

def _has_sibling_via(rec):
    return any(str(c.get("via", "")).startswith("sibling:")
               for c in (rec.get("candidates") or []))

per_cat = defaultdict(lambda: {"sib_cases": 0, "exp_in": 0, "total": 0})
sib_cases_total = 0
exp_in_total = 0
exp_in_by_cat = Counter()
inject_count_dist = Counter()  # how many sibling slots per case
lost = 0
gained = 0
unchanged = 0

for cid in eval_ids:
    cat = cases[cid].get("category")
    expected = cases[cid].get("expected_sku")
    rec = new.get(cid)
    if not rec:
        continue
    sib = _has_sibling_via(rec)
    exp_in = _expected_in_compare(rec, expected)
    n_sib = sum(1 for c in (rec.get("candidates") or [])
                if str(c.get("via", "")).startswith("sibling:"))
    if sib:
        sib_cases_total += 1
    if exp_in:
        exp_in_total += 1
        exp_in_by_cat[cat] += 1
    per_cat[cat]["total"] += 1
    if sib:
        per_cat[cat]["sib_cases"] += 1
    if exp_in:
        per_cat[cat]["exp_in"] += 1
    inject_count_dist[n_sib] += 1
    # LOST vs old
    old_in = bool(old.get(cid) and old[cid].get("target_in_pool"))
    new_in = bool(rec.get("target_in_pool"))
    if old_in and not new_in:
        lost += 1
    elif new_in and not old_in:
        gained += 1
    elif old_in == new_in:
        unchanged += 1

print(f"=== F1 acceptance (denominator: {len(eval_ids)} eval-aware) ===")
print(f"sibling-via cases            : {sib_cases_total:>3} / {len(eval_ids)}   "
      f"(target ≥ 10/90)")
anchor_total = sum(d["total"] for c, d in per_cat.items()
                   if c == "anchor-pair-distinction")
anchor_in = per_cat["anchor-pair-distinction"]["exp_in"]
print(f"anchor-pair exp in compare   : {anchor_in:>3} / {anchor_total}   "
      f"(target ≥ 8/28)")
print()
print("=== per-category (exp in compare) ===")
for cat in sorted(per_cat):
    d = per_cat[cat]
    print(f"  {cat:<28} exp_in {d['exp_in']:>2}/{d['total']:<2}  "
          f"sib_cases {d['sib_cases']:>2}/{d['total']}")
print()
print("=== sibling-slot distribution per case ===")
for n in sorted(inject_count_dist):
    print(f"  {n} sibling slot(s) : {inject_count_dist[n]}")
print()
total_compare_pool_hits = sum(1 for r in new.values() if r.get("target_in_pool"))
print(f"=== LOST vs b3v2 (recall target_in_pool) ===")
print(f"  LOST (b3v2 yes -> F1 no) : {lost}")
print(f"  GAINED                    : {gained}")
print(f"  unchanged                 : {unchanged}")
print(f"  total target_in_pool (F1) : {total_compare_pool_hits}")

# Save JSON for the report generator
import os
out_json = "/opt/puer-hub/rag-data/eval/f1_check.json"
try:
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({
            "sibling_cases": sib_cases_total,
            "denom": len(eval_ids),
            "anchor_in": anchor_in,
            "anchor_total": anchor_total,
            "per_category": {k: dict(v) for k, v in per_cat.items()},
            "lost": lost,
            "gained": gained,
            "inject_slots_dist": dict(inject_count_dist),
        }, f, ensure_ascii=False, indent=2)
    print(f"\nWROTE {out_json}")
except OSError as e:
    print(f"\n(JSON save skipped: {e})")