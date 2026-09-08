#!/usr/bin/env python3
"""Batch-2: build SFT pairs from parsed annotations + merge with batch-1 -> v3.

Matches batch-1 sft-visual-final.jsonl schema:
  {image, note_title, label, provenance(expert_approved|expert_reviewed), row}
Applies the M2.5a vessel-term normalization defensively (no-op expected for b2).
Then merges with batch-1 sft-visual-final-norm.jsonl into the combined v3 set.
"""
import json

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
FINAL = f"{BASE}/review-queue-b2-final.jsonl"
B1 = f"{BASE}/sft-visual-final-norm.jsonl"
OUT_B2 = f"{BASE}/sft-visual-final-b2.jsonl"
OUT_B2_NORM = f"{BASE}/sft-visual-final-b2-norm.jsonl"
OUT_COMBINED = f"{BASE}/sft-visual-combined-norm.jsonl"

# M2.5a deterministic vessel normalization (zero-hallucination mapping)
NORM = [("浅青色", "青瓷"), ("浅蓝色", "青瓷"), ("浅蓝", "青瓷"),
        ("浅青", "青瓷"), ("白底蓝花", "青花")]

def normalize(label):
    for a, b in NORM:
        label = label.replace(a, b)
    return label

def main():
    rows = [json.loads(l) for l in open(FINAL, encoding="utf-8")]
    b2, changed = [], 0
    for i, r in enumerate(rows, 1):
        label = r["final_label"]
        if not label:
            print(f"!! row {i} missing final_label: {r['url']}")
            continue
        nlabel = normalize(label)
        if nlabel != label:
            changed += 1
        b2.append({"image": r["url"], "note_title": r["note_title"],
                   "label": nlabel,
                   "provenance": "expert_reviewed" if r["status"] == "reviewed" else "expert_approved",
                   "row": i})
    with open(OUT_B2, "w", encoding="utf-8") as f:
        for r in b2:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(OUT_B2_NORM, "w", encoding="utf-8") as f:
        for r in b2:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    n_rev = sum(1 for r in b2 if r["provenance"] == "expert_reviewed")

    # merge with batch-1 (dedup by image url; b2 already excluded b1 urls)
    b1 = [json.loads(l) for l in open(B1, encoding="utf-8")]
    seen = set()
    combined = []
    for r in b1 + b2:
        if r["image"] in seen:
            continue
        seen.add(r["image"])
        combined.append(r)
    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        for r in combined:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"b2 pairs: {len(b2)} (reviewed {n_rev}), norm-changed: {changed}")
    print(f"batch-1 pairs: {len(b1)}")
    print(f"combined v3: {len(combined)} (dedup removed {len(b1)+len(b2)-len(combined)})")

if __name__ == "__main__":
    main()
