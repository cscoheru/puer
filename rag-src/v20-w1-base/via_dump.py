#!/usr/bin/env python3
"""Dump via composition of anchor-pair candidates from e12 capture,
to confirm active-anchor detection never fired (zero via=sibling:*)."""
import json

rows = {}
with open("/opt/puer-hub/rag-data/eval/scores.v5.e12.jsonl") as f:
    for line in f:
        line = line.strip()
        if line:
            r = json.loads(line)
            rows[r["case_id"]] = r

via_counter = {}
for cid in sorted(rows):
    r = rows[cid]
    if r.get("category") != "anchor-pair-distinction":
        continue
    for v in r.get("verdicts") or []:
        via = str(v.get("via", ""))
        key = via.split(":")[0] if ":" in via else (via or "dino/self")
        via_counter[key] = via_counter.get(key, 0) + 1

print("via-prefix distribution across all anchor-pair verdicts:")
for k, c in sorted(via_counter.items(), key=lambda x: -x[1]):
    print(f"  {k:<14} {c}")

print()
for cid in ["v5-anchor-pair-distinction-001", "v5-anchor-pair-distinction-003",
            "v5-anchor-pair-distinction-013", "v5-anchor-pair-distinction-019"]:
    r = rows[cid]
    print(f"=== {cid} q={r.get('query_skuId')} anchor={r.get('anchor')!r} "
          f"expected={r.get('expected_sku')}")
    for v in r.get("verdicts") or []:
        print(f"    sku={str(v.get('skuId')):>5} "
              f"verdict={str(v.get('verdict')):>22} "
              f"via={str(v.get('via')):>20} dino={v.get('dino_sim')}")
