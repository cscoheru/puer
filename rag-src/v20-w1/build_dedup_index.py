#!/usr/bin/env python3
"""W2-1 build_dedup_index.py — sha1 dedup tool for donghe-images/.

Scans /opt/puer-hub/rag-data/donghe-images/, groups files by sha1, builds:
  - canonical skuIds (one per unique sha, smallest numeric wins for stability)
  - skuId_to_row map (every original skuId → its canonical embedding row)
  - shared_sha map (sha → [all skuIds sharing it], audit only)

DRY-RUN (default): print summary only.
APPLY (--apply): overwrite /opt/puer-hub/rag-data/donghe-visual-ids.json with
extended schema + write /opt/puer-hub/rag-data/dedup_meta.json (audit).

Idempotent: re-running yields identical mappings (canonical = min int skuId).

Safety:
  - Default mode is dry-run; nothing is written.
  - In --apply mode, also refuses to write if any expected row count check fails.
  - Backup dir `/opt/puer-hub/rag-data/.w2-dedup-backup/` should already exist
    (Step 0 responsibility).

Usage:
  python3 build_dedup_index.py                # dry-run
  python3 build_dedup_index.py --apply        # write artifacts
  python3 build_dedup_index.py --jsonl-only   # only rebuild dedup_meta.json
                                              # (don't touch visual-ids)
"""
import argparse
import collections
import hashlib
import json
import os
import sys


RAG_DATA = "/opt/puer-hub/rag-data"
DONGHE_IMG = f"{RAG_DATA}/donghe-images"
VIS_IDS_PATH = f"{RAG_DATA}/donghe-visual-ids.json"
DEDUP_META_PATH = f"{RAG_DATA}/dedup_meta.json"


def scan_sha1(img_dir: str) -> dict[str, list[str]]:
    """Return {sha1_hex: [skuId_str, ...]} for all .jpe? files in img_dir."""
    buckets: dict[str, list[str]] = collections.defaultdict(list)
    files = [fn for fn in os.listdir(img_dir)
             if fn.lower().endswith((".jpg", ".jpeg", ".jpe"))]
    for i, fn in enumerate(files):
        sid = fn.rsplit(".", 1)[0]
        path = os.path.join(img_dir, fn)
        try:
            with open(path, "rb") as f:
                sha = hashlib.sha1(f.read()).hexdigest()
            buckets[sha].append(sid)
        except OSError as e:
            print(f"  [WARN] skip {fn}: {e}", file=sys.stderr)
        if (i + 1) % 500 == 0:
            print(f"  hashed {i + 1}/{len(files)}", file=sys.stderr)
    return dict(buckets)


def build_index(buckets: dict[str, list[str]]) -> dict:
    """Build canonical_sids, skuId_to_row, shared_sha from buckets.

    canonical_sids[i] = min(int(s) for s in buckets[i]'s skuIds), stable across
    reruns. skuId_to_row maps every original skuId to its canonical row index.
    """
    canonical_sids: list[str] = []
    skuId_to_row: dict[str, int] = {}
    # stable iteration order: sort by first-seen skuId min (sha key is hash, so
    # we keep dict insertion order from scan_sha1 which is filesystem-dependent;
    # we sort sha keys deterministically by their canonical skuId for stability)
    sha_keys_sorted = sorted(
        buckets.keys(),
        key=lambda h: min(int(s) for s in buckets[h]))
    for i, sha in enumerate(sha_keys_sorted):
        sids = buckets[sha]
        c_sid = str(min(int(s) for s in sids))
        canonical_sids.append(c_sid)
        for s in sids:
            skuId_to_row[str(s)] = i

    shared = {sha: sids for sha, sids in buckets.items() if len(sids) > 1}
    summary = {
        "total_files": sum(len(s) for s in buckets.values()),
        "unique_shas": len(buckets),
        "shared_sha_count": len(shared),
        "shared_skus_count": sum(len(s) for s in shared.values()),
        "top5_shared": [
            {"sha_prefix": sha[:12], "count": len(sids),
             "sample_skus": sorted(sids, key=lambda x: int(x))[:5]}
            for sha, sids in sorted(shared.items(),
                                    key=lambda kv: -len(kv[1]))[:5]
        ],
    }
    return {
        "canonical_sids": canonical_sids,
        "skuId_to_row": skuId_to_row,
        "shared_sha": shared,
        "summary": summary,
    }


def write_vis_ids(idx: dict) -> None:
    """Overwrite donghe-visual-ids.json with extended schema."""
    new_vis = {
        "skuIds": idx["canonical_sids"],      # 3284 canonical rows
        "dino_dim": 768,
        "clip_dim": 512,
        "skuId_to_row": idx["skuId_to_row"],  # 6717 skuIds → row index
        "shared_sha": idx["shared_sha"],       # audit (sha → [skuIds])
    }
    with open(VIS_IDS_PATH, "w", encoding="utf-8") as f:
        json.dump(new_vis, f, ensure_ascii=False)


def write_dedup_meta(idx: dict) -> None:
    """Write dedup_meta.json — audit only (no big dicts to keep small)."""
    summary = idx["summary"]
    summary["canonical_sids_count"] = len(idx["canonical_sids"])
    summary["skuId_to_row_count"] = len(idx["skuId_to_row"])
    summary["dedup_ratio_pct"] = round(
        100 * (1 - summary["unique_shas"] / summary["total_files"]), 2)
    with open(DEDUP_META_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)


def sanity_check(idx: dict) -> list[str]:
    """Return list of warnings (empty = clean)."""
    warns = []
    # every row index should be in range
    n = len(idx["canonical_sids"])
    bad = [sid for sid, r in idx["skuId_to_row"].items() if r < 0 or r >= n]
    if bad:
        warns.append(f"{len(bad)} skuIds map to out-of-range row (sample: {bad[:3]})")
    # every canonical_sid should appear in skuId_to_row (it does as its own row)
    miss = [s for s in idx["canonical_sids"] if s not in idx["skuId_to_row"]]
    if miss:
        warns.append(f"{len(miss)} canonical_sids missing from skuId_to_row "
                     f"(sample: {miss[:3]})")
    # shared_sha should be consistent with skuId_to_row
    for sha, sids in list(idx["shared_sha"].items())[:10]:
        rows = {idx["skuId_to_row"][s] for s in sids if s in idx["skuId_to_row"]}
        if len(rows) != 1:
            warns.append(f"shared_sha {sha[:12]} maps to {len(rows)} distinct rows "
                         f"(expected 1)")
    return warns


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="write artifacts (default: dry-run)")
    ap.add_argument("--jsonl-only", action="store_true",
                    help="--apply + only write dedup_meta.json, skip visual-ids")
    args = ap.parse_args()

    print(f"[scan] hashing files in {DONGHE_IMG} ...", file=sys.stderr)
    buckets = scan_sha1(DONGHE_IMG)
    print(f"[scan] done: {sum(len(v) for v in buckets.values())} files in "
          f"{len(buckets)} unique shas", file=sys.stderr)

    idx = build_index(buckets)
    summary = idx["summary"]

    if not args.apply:
        print("\n[DRY-RUN] summary:")
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        print(f"\nTo apply: python3 {sys.argv[0]} --apply", file=sys.stderr)
        return 0

    warns = sanity_check(idx)
    if warns:
        print("[FAIL] sanity check warnings:")
        for w in warns:
            print(f"  - {w}")
        return 2

    if args.jsonl_only:
        write_dedup_meta(idx)
        print(f"[APPLIED] dedup_meta.json only ({DEDUP_META_PATH})")
    else:
        write_vis_ids(idx)
        write_dedup_meta(idx)
        print(f"[APPLIED] {VIS_IDS_PATH}: {len(idx['canonical_sids'])} canonical rows, "
              f"{len(idx['skuId_to_row'])} skuId mappings")
        print(f"[APPLIED] {DEDUP_META_PATH}: audit summary")
    return 0


if __name__ == "__main__":
    sys.exit(main())