#!/usr/bin/env python3
"""Deep-dive analysis for REPORT-b1-baseline.md."""
import json
from collections import defaultdict

scores = [json.loads(l) for l in open("/opt/puer-hub/rag-data/eval/scores.v5.jsonl")]
recall = [s for s in scores if s.get("score_mode") == "recall"]
v4_scores = [json.loads(l) for l in open("/opt/puer-hub/rag-data/eval/scores.v4-recall-2.jsonl")]
v4_recall = [s for s in v4_scores if s.get("score_mode") == "recall"]

# anchor-pair detail
print("=== ANCHOR-PAIR DETAIL (v5) ===")
cats = defaultdict(list)
for s in recall:
    cats[s.get("category", "?")].append(s)

ap = cats.get("anchor-pair-distinction", [])
for s in sorted(ap, key=lambda x: x.get("target_dino_rank") or 999):
    t1 = s.get("top1", {})
    name = t1.get("name", "?") or "?"
    rank = s.get("target_dino_rank")
    pool = s.get("target_in_pool")
    n_pool = s.get("n_pool")
    in_top5 = s.get("target_in_top5")
    note = "HIT" if pool else "MISS"
    print(f"  {s['case_id']}: rank={rank} pool={pool} n_pool={n_pool} top1={t1.get('skuId')} ({name[:25]}) [{note}]")

# v4 anchor-pair detail
print()
print("=== ANCHOR-PAIR DETAIL (v4) ===")
for s in sorted(v4_recall, key=lambda x: x.get("target_dino_rank") or 999):
    t1 = s.get("top1", {})
    name = t1.get("name", "?") or "?"
    rank = s.get("target_dino_rank")
    pool = s.get("target_in_pool")
    n_pool = s.get("n_pool")
    note = "HIT" if pool else "MISS"
    print(f"  {s['case_id']}: rank={rank} pool={pool} n_pool={n_pool} top1={t1.get('skuId')} ({name[:25]}) [{note}]")

# cross_year detail
print()
print("=== CROSS_YEAR DETAIL (v5) ===")
cy = cats.get("cross_year", [])
for s in sorted(cy, key=lambda x: x.get("target_dino_rank") or 999):
    t1 = s.get("top1", {})
    name = t1.get("name", "?") or "?"
    rank = s.get("target_dino_rank")
    pool = s.get("target_in_pool")
    n_pool = s.get("n_pool")
    note = "HIT" if pool else "MISS"
    print(f"  {s['case_id']}: rank={rank} pool={pool} n_pool={n_pool} top1={t1.get('skuId')} ({name[:25]}) [{note}]")

# synthetic detail
print()
print("=== SYNTHETIC SUMMARY ===")
synth = cats.get("synthetic", [])
hit = sum(1 for s in synth if s.get("target_in_pool"))
top1 = sum(1 for s in synth if s.get("target_dino_rank") == 1)
print(f"synthetic: n={len(synth)} pool_hit={hit}({hit*100.0/len(synth):.1f}%) top1={top1}({top1*100.0/len(synth):.1f}%)")
# by perturbation type
for suffix in ["rot15", "rot-15", "q30"]:
    sub = [s for s in synth if suffix in s.get("case_id", "")]
    if sub:
        h = sum(1 for s in sub if s.get("target_in_pool"))
        t = sum(1 for s in sub if s.get("target_dino_rank") == 1)
        print(f"  {suffix}: n={len(sub)} pool={h}({h*100.0/len(sub):.0f}%) top1={t}({t*100.0/len(sub):.0f}%)")

# partial_text detail
print()
print("=== PARTIAL_TEXT DETAIL ===")
pt = cats.get("partial_text", [])
for s in sorted(pt, key=lambda x: x.get("target_dino_rank") or 999):
    t1 = s.get("top1", {})
    name = t1.get("name", "?") or "?"
    rank = s.get("target_dino_rank")
    pool = s.get("target_in_pool")
    note = "HIT" if pool else "MISS"
    print(f"  {s['case_id']}: rank={rank} pool={pool} top1={t1.get('skuId')} ({name[:25]}) [{note}]")

# overall latency
print()
print("=== LATENCY ===")
lat = sorted([s["elapsed_s"] for s in recall])
n = len(lat)
print(f"p50={lat[n//2]:.3f}s p95={lat[int(n*0.95)]:.3f}s p99={lat[int(n*0.99)]:.3f}s max={max(lat):.3f}s")

# by category latency
print()
print("=== LATENCY BY CATEGORY ===")
for cat, items in sorted(cats.items()):
    lat = sorted([s["elapsed_s"] for s in items])
    n = len(lat)
    if n > 0:
        print(f"  {cat}: p50={lat[n//2]:.3f}s p95={lat[int(n*0.95)]:.3f}s max={max(lat):.3f}s")
