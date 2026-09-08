#!/usr/bin/env python3
"""W1-3 offline scorer for /data/eval/manifest.v1.jsonl.

For each case, runs visual_match.compare() in either recall-only mode
(return_pool_only=True — no M3 cost) or full mode (verdict M3 cost ~$0.05
per 3-candidate case). Aggregates Top-K metrics, target-rank distribution,
and per-category latency.

Runs INSIDE puer-hub-rag-service so the visual index is hot in memory
(_ensure_loaded() reuses it across cases).

Usage:
  python3 /app/eval_offline.py \
      --manifest /data/eval/manifest.v1.jsonl \
      --out /tmp/eval-scores.v1.jsonl \
      --mode both              # recall|verdict|both
      [--limit 5]              # first N cases (debug)
      [--include-case ID]      # only specific case_id (repeatable)
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict

# visual_match is in /app; both scorer + manifest live there when deployed.
sys.path.insert(0, "/app")
import visual_match  # noqa: E402

# Container-side mount: /data == host /opt/puer-hub/rag-data (read-only).
RAG_DATA = os.environ.get("RAG_DATA_HOST", "/data")


def _decode_heic(src_abs: str, tmpdir: str) -> str:
    """W1-5 path: ffmpeg decodes HEIC to .raw.jpg, sharp re-encodes as JPEG.

    Extension must be .jpg — ffmpeg uses it to choose muxer (libheif patent
    workaround). Returns the final decoded JPEG path."""
    raw = os.path.join(tmpdir, "decoded.raw.jpg")
    final = os.path.join(tmpdir, "decoded.jpg")
    subprocess.run(["ffmpeg", "-y", "-i", src_abs, raw],
                   check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=60)
    from PIL import Image
    img = Image.open(raw).convert("RGB")
    img.rotate(0, expand=True).save(final, "JPEG", quality=92)
    return final


def _resolve_image(case: dict) -> str | None:
    """Return absolute container-side path to a decoded JPEG ready for
    visual_match. We IGNORE case.image_abs (host-side absolute) and always
    derive the path from image_path relative to RAG_DATA_HOST (/data) —
    the manifest travels host↔container, paths in it must be portable."""
    img_rel = case.get("image_path", "")
    img_abs = os.path.join(RAG_DATA, img_rel.lstrip("/"))
    if not os.path.exists(img_abs):
        return None
    if case.get("image_type", "jpeg") in ("heic", "heif"):
        tmpdir = tempfile.mkdtemp(prefix="eval-heic-")
        try:
            return _decode_heic(img_abs, tmpdir)
        except Exception as e:
            print(f"  HEIC decode failed: {e}", file=sys.stderr)
            return None
    return img_abs


def _rank_target(candidates: list, target_sku: str | None) -> dict:
    """Position of target in candidates by dino_sim DESC (1-indexed).
    Returns rank=0 if not in candidates."""
    if not target_sku:
        return {"in_pool": None, "rank": None, "sim": None}
    for i, c in enumerate(sorted(candidates,
                                  key=lambda x: -x.get("dino_sim", 0)), 1):
        if str(c.get("skuId")) == str(target_sku):
            return {"in_pool": True, "rank": i, "sim": c.get("dino_sim")}
    return {"in_pool": False, "rank": None, "sim": None}


def _score_recall(case: dict, img: str) -> dict:
    t0 = time.monotonic()
    out = visual_match.compare(img, ocr_text=case.get("ocr_text") or "",
                               return_pool_only=True)
    elapsed = round(time.monotonic() - t0, 3)
    cands = out.get("candidates") or []
    top1 = max(cands, key=lambda x: x.get("dino_sim", 0), default=None)
    rank = _rank_target(cands, case.get("expected_sku"))
    target_top5 = (rank["rank"] is not None and rank["rank"] <= 5)
    return {
        "ok": bool(out.get("ok")),
        "reason": out.get("reason"),
        "elapsed_s": elapsed,
        "n_pool": (out.get("trace") or {}).get("n_pool", len(cands)),
        "n_compared_planned": len(cands),
        "top1": ({"skuId": top1["skuId"], "name": top1.get("name"),
                  "dino_sim": top1.get("dino_sim")}
                 if top1 else None),
        "target_in_pool": rank["in_pool"],
        "target_dino_rank": rank["rank"],
        "target_dino_sim": rank["sim"],
        "target_in_top5": target_top5,
    }


def _score_verdict(case: dict, img: str) -> dict:
    t0 = time.monotonic()
    out = visual_match.compare(img, ocr_text=case.get("ocr_text") or "")
    elapsed = round(time.monotonic() - t0, 3)
    best = out.get("best")
    verdicts = out.get("verdicts") or []
    exp = case.get("expected_sku")
    allowed = set(case.get("allowed_verdicts") or [])
    forbidden = set(case.get("forbidden_verdicts") or [])
    # expected_hit: best.skuId == expected AND best.verdict ∈ allowed
    expected_hit = None
    if exp:
        expected_hit = bool(best and str(best.get("skuId")) == str(exp)
                            and (not allowed or best.get("verdict") in allowed))
    # forbidden_hit: any verdict matches forbidden pattern (skuId + verdict tuple)
    forbidden_hit = False
    for v in verdicts:
        if v.get("verdict") in forbidden and (
                not exp or str(v.get("skuId")) != str(exp)):
            forbidden_hit = True
            break
    return {
        "ok": bool(out.get("ok")),
        "reason": out.get("reason"),
        "elapsed_s": elapsed,
        "best": ({"skuId": best.get("skuId"), "name": best.get("name"),
                  "verdict": best.get("verdict"), "confidence": best.get("confidence")}
                 if best else None),
        "verdicts": [{"skuId": v.get("skuId"), "verdict": v.get("verdict"),
                      "confidence": v.get("confidence")}
                     for v in verdicts],
        "expected_hit": expected_hit,
        "forbidden_hit": forbidden_hit,
    }


def _read_manifest(path: str) -> list:
    cases = []
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            cases.append(json.loads(line))
    return cases


def _run(cases: list, mode: str, include_ids: set | None, limit: int | None,
         out_path: str) -> int:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    counts = defaultdict(int)
    skipped = 0
    errors = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for i, case in enumerate(cases):
            cid = case["case_id"]
            if limit and i >= limit:
                break
            if include_ids and cid not in include_ids:
                continue
            img = _resolve_image(case)
            if img is None:
                f.write(json.dumps({"case_id": cid, "category": case.get("category"),
                                    "ok": False, "reason": "image_unresolvable"},
                                   ensure_ascii=False) + "\n")
                errors += 1
                continue
            record = {"case_id": cid, "category": case.get("category"),
                      "tags": case.get("tags", []),
                      "expected_sku": case.get("expected_sku")}
            modes = case.get("score_modes") or ["recall"]
            if mode == "recall":
                modes = ["recall"]
            elif mode == "verdict":
                modes = ["verdict"]
            for m in modes:
                t = time.monotonic()
                try:
                    if m == "recall":
                        s = _score_recall(case, img)
                    elif m == "verdict":
                        s = _score_verdict(case, img)
                    else:
                        continue
                    record_out = {**record, "score_mode": m, **s}
                except Exception as e:
                    record_out = {**record, "score_mode": m,
                                  "ok": False, "reason": f"{type(e).__name__}: {e}"}
                    errors += 1
                record_out["_score_eval_s"] = round(time.monotonic() - t, 3)
                f.write(json.dumps(record_out, ensure_ascii=False) + "\n")
                f.flush()
                counts[m] += 1
            print(f"  [{i+1}/{len(cases)}] {cid} ({case.get('category')})", flush=True)
    print(f"WROTE {out_path}: {dict(counts)}  errors={errors}  skipped={skipped}",
          file=sys.stderr)
    return 0 if errors == 0 else 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", default="both", choices=["recall", "verdict", "both"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--include-case", nargs="+", default=None,
                    help="space-separated case_id list to include")
    args = ap.parse_args()

    cases = _read_manifest(args.manifest)
    include = set(args.include_case or []) if args.include_case else None
    print(f"manifest={args.manifest}  cases={len(cases)}  "
          f"mode={args.mode}  limit={args.limit}  "
          f"include={sorted(include) if include else 'all'}", file=sys.stderr)
    sys.exit(_run(cases, args.mode, include, args.limit, args.out))


if __name__ == "__main__":
    main()