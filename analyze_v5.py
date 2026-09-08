#!/usr/bin/env python3
"""Parse v5 scores and print summary."""
import json
from collections import defaultdict

scores = [json.loads(l) for l in open("/opt/puer-hub/rag-data/eval/scores.v5.jsonl")]
recall = [s for s in scores if s.get("score_mode") == "recall"]

# Overall
total = len(recall)
pool_hit = sum(1 for s in recall if s.get("target_in_pool"))
top1 = sum(1 for s in recall if s.get("target_dino_rank") == 1)
top5 = sum(1 for s in recall if s.get("target_in_top5"))
ranks = [s["target_dino_rank"] for s in recall if s.get("target_dino_rank")]
latencies = [s["elapsed_s"] for s in recall]

print("=== OVERALL ===")
print(f"total={total} pool_hit={pool_hit}({pool_hit*100.0/total:.1f}%) top1={top1}({top1*100.0/total:.1f}%) top5={top5}({top5*100.0/total:.1f}%)")
if ranks:
    ranks.sort()
    print(f"rank: mean={sum(ranks)/len(ranks):.1f} median={ranks[len(ranks)//2]} max={max(ranks)}")
latencies.sort()
p95_idx = int(len(latencies) * 0.95)
print(f"latency: p50={latencies[len(latencies)//2]:.3f}s p95={latencies[p95_idx]:.3f}s max={max(latencies):.3f}s")

# Per-category
print()
print("=== BY CATEGORY ===")
cats = defaultdict(list)
for s in recall:
    cats[s.get("category", "?")].append(s)
for cat, sitems in sorted(cats.items()):
    n = len(sitems)
    ph = sum(1 for s in sitems if s.get("target_in_pool"))
    t1 = sum(1 for s in sitems if s.get("target_dino_rank") == 1)
    t5 = sum(1 for s in sitems if s.get("target_in_top5"))
    rnk = [s["target_dino_rank"] for s in sitems if s.get("target_dino_rank")]
    rnk.sort()
    mean_r = f"{sum(rnk)/len(rnk):.1f}" if rnk else "N/A"
    print(f"{cat}: n={n} pool={ph}({ph*100.0/n:.1f}%) top1={t1}({t1*100.0/n:.1f}%) top5={t5}({t5*100.0/n:.1f}%) mean_rank={mean_r}")
    # Show top-1 details
    t1_cases = [s for s in sitems if s.get("target_dino_rank") == 1]
    for sc in t1_cases:
        top1_sku = sc.get("top1", {})
        name = top1_sku.get("name", "?") or "?"
        print(f"  [{sc['case_id']}] top1_sku={top1_sku.get('skuId')} ({name[:30]})")

# v4 comparison for anchor-pair
print()
print("=== V4 vs V5 ANCHOR-PAIR COMPARISON ===")
v4_scores = [json.loads(l) for l in open("/opt/puer-hub/rag-data/eval/scores.v4-recall-2.jsonl")]
v4_recall = [s for s in v4_scores if s.get("score_mode") == "recall"]
v4_total = len(v4_recall)
v4_pool_hit = sum(1 for s in v4_recall if s.get("target_in_pool"))
v4_top1 = sum(1 for s in v4_recall if s.get("target_dino_rank") == 1)
v4_top5 = sum(1 for s in v4_recall if s.get("target_in_top5"))
print(f"v4 anchor-pair: n={v4_total} pool={v4_pool_hit}({v4_pool_hit*100.0/v4_total:.1f}%) top1={v4_top1}({v4_top1*100.0/v4_total:.1f}%) top5={v4_top5}({v4_top5*100.0/v4_total:.1f}%)")
v5_ap = cats.get("anchor-pair-distinction", [])
v5_ap_total = len(v5_ap)
v5_ap_pool = sum(1 for s in v5_ap if s.get("target_in_pool"))
v5_ap_top1 = sum(1 for s in v5_ap if s.get("target_dino_rank") == 1)
v5_ap_top5 = sum(1 for s in v5_ap if s.get("target_in_top5"))
print(f"v5 anchor-pair: n={v5_ap_total} pool={v5_ap_pool}({v5_ap_pool*100.0/v5_ap_total:.1f}%) top1={v5_ap_top1}({v5_ap_top1*100.0/v5_ap_total:.1f}%) top5={v5_ap_top5}({v5_ap_top5*100.0/v5_ap_total:.1f}%)")

# Failed / missing
print()
print("=== FAILED / SKIPPED ===")
failed = [s for s in recall if not s.get("ok")]
for s in failed:
    print(f"  FAIL: {s['case_id']} reason={s.get('reason','')[:80]}")
skipped = [s for s in scores if not s.get("ok") and s not in failed]
# cases where target not in pool (for categories with expected_sku)
not_in_pool = [s for s in recall if s.get("target_in_pool") is False]
print(f"  target NOT in pool: {len(not_in_pool)}")
