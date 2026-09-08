#!/usr/bin/env python3
"""Path-B revival condition check (Cursor 10:10).

Condition ②: count anchor-pair cases where the expected sibling IS in the B3
pool (target_in_pool=true in scores.v5.b3v2.jsonl) but did NOT reach the M3
compare set (absent from e12 verdicts). Threshold for Path-B revival: >=8/28.

Condition ① (anchor-pair loose top-1 after E1+E2 <20%) comes from e_replay's
per-category loose figure; printed here again for the single decision point.
"""
import json
import sys

B3 = "/opt/puer-hub/rag-data/eval/scores.v5.b3v2.jsonl"
E12 = "/opt/puer-hub/rag-data/eval/scores.v5.e12.jsonl"


def load(p):
    out = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


b3 = {r["case_id"]: r for r in load(B3)}
e12 = {r["case_id"]: r for r in load(E12)}

anchor = [c for c in e12.values()
          if c.get("category") == "anchor-pair-distinction"]
print(f"anchor-pair cases in e12: {len(anchor)}")

in_pool_not_compare = []
in_pool_total = 0
in_compare_total = 0
for c in anchor:
    cid = c["case_id"]
    exp = str(c.get("expected_sku"))
    pool_hit = bool(b3.get(cid, {}).get("target_in_pool"))
    compare_skus = {str(v.get("skuId")) for v in (c.get("verdicts") or [])}
    in_compare = exp in compare_skus
    if pool_hit:
        in_pool_total += 1
    if in_compare:
        in_compare_total += 1
    if pool_hit and not in_compare:
        in_pool_not_compare.append((cid, exp))

print(f"B3 pool hit (target_in_pool=true)       : {in_pool_total}/{len(anchor)}")
print(f"e12 compare-set reached                 : {in_compare_total}/{len(anchor)}")
print(f"pool-hit BUT not-in-compare (cond ②)    : {len(in_pool_not_compare)}/28 "
      f"(revival threshold >=8)")
for x in in_pool_not_compare:
    print(f"    {x}")

# condition ① anchor-pair loose top-1 from e12 live (R3)
VERDICT_FORBIDDEN_FALLBACK = None
n_loose = 0
n_aware = 0
for c in anchor:
    if c.get("expect_refusal"):
        continue
    exp = c.get("expected_sku")
    if exp is None:
        continue
    n_aware += 1
    best = c.get("best")
    if not best:
        continue
    forbidden = set(c.get("forbidden_verdicts") or [])
    sku_ok = str(best.get("skuId")) == str(exp)
    forb_best = bool(forbidden) and best.get("verdict") in forbidden
    if sku_ok and not forb_best:
        n_loose += 1
pct = 100.0 * n_loose / n_aware if n_aware else 0.0
print(f"\nCondition ① anchor-pair loose top-1 (e12 live): "
      f"{n_loose}/{n_aware} = {pct:.1f}%  (revival requires <20%)")
print(f"\nPATH-B VERDICT: "
      f"{'REVIVE (both conditions met)' if (len(in_pool_not_compare) >= 8 and pct < 20) else 'STAY REJECTED'}")
