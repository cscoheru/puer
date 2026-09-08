#!/usr/bin/env python3
"""W2-1 rebuild NPY for canonical skuIds only — STREAMING variant.

Root cause of v1 OOM: dvecs/cvecs lists accumulated all preprocessed tensors
(3284×3×224×224×4 ≈ 1.9GB × 2 models = 4GB) before ONNX ran. With ONNX
runtime overhead + Python GC pressure, peak exceeded 5.9GB available RAM on
the 7.8GB host and kernel SIGKILL'd the process.

Fix: per-batch preprocess → immediately run inference → immediately
write the row embeddings to .npy. Peak memory = single batch's preprocess
tensor (~75MB for batch=64) + final 19MB output. Total wall-clock same.

Usage:
  RAG_DATA_DIR=/opt/puer-hub/rag-data python3 /tmp/rebuild_dedup_embeddings.py

Prereqs:
  - build_dedup_index.py --apply already run
  - visual_match importable (run from /opt/puer-hub/rag-src or sys.path)
  - python3 -u for unbuffered output (so OOM/segfaults are visible)
"""
import gc
import json
import os
import sys

# Make visual_match importable
sys.path.insert(0, "/opt/puer-hub/rag-src")

RAG_DATA = os.environ.get("RAG_DATA_DIR", "/opt/puer-hub/rag-data")
DINO_ONNX = f"{RAG_DATA}/models/dinov2-base-img.onnx"
CLIP_ONNX = f"{RAG_DATA}/models/clip-vitb32-img.onnx"
DINO_OUT = f"{RAG_DATA}/donghe-dino.npy"
CLIP_OUT = f"{RAG_DATA}/donghe-clip.npy"
VIS = f"{RAG_DATA}/donghe-visual-ids.json"
IMG_DIR = f"{RAG_DATA}/donghe-images"

# Smaller batch — keeps peak preprocess tensor low. Each image is
# 3×224×224×4 = 600KB float32. batch=64 = 38MB per model.
BATCH = 64


def main():
    import numpy as np
    import onnxruntime as ort
    import visual_match  # noqa

    if not os.path.exists(VIS):
        print(f"FAIL: {VIS} missing — run build_dedup_index.py --apply first")
        sys.exit(2)
    vis = json.load(open(VIS))
    canonical_sids = vis["skuIds"]
    skuId_to_row = vis.get("skuId_to_row", {})
    shared_sha = vis.get("shared_sha", {})

    print(f"canonical skuIds: {len(canonical_sids)}", flush=True)
    print(f"skuId_to_row: {len(skuId_to_row)} mappings", flush=True)
    print(f"shared_sha groups: {len(shared_sha)}", flush=True)

    # Sanity: every canonical must have image on disk
    missing = [s for s in canonical_sids
               if not os.path.exists(f"{IMG_DIR}/{s}.jpeg")]
    if missing:
        print(f"FAIL: {len(missing)} canonical images missing on disk:")
        for s in missing[:10]:
            print(f"  {s}.jpeg", flush=True)
        sys.exit(3)

    image_paths = [f"{IMG_DIR}/{s}.jpeg" for s in canonical_sids]
    N = len(image_paths)
    print(f"Streaming {N} canonical images in batches of {BATCH}...",
          flush=True)

    # Inference sessions
    dsess = ort.InferenceSession(DINO_ONNX, providers=["CPUExecutionProvider"])
    csess = ort.InferenceSession(CLIP_ONNX, providers=["CPUExecutionProvider"])

    # Pre-allocate final outputs (small: 3284×768×4 = 9.6MB, 3284×512×4 = 6.4MB)
    dmat = np.empty((N, 768), dtype=np.float32)
    cmat = np.empty((N, 512), dtype=np.float32)

    n_ok = 0
    for batch_start in range(0, N, BATCH):
        batch = image_paths[batch_start:batch_start + BATCH]
        B = len(batch)
        try:
            # Preprocess (peak ~38MB per model for batch=64)
            Dx = np.vstack([visual_match._pre_dino(p) for p in batch])
            Cx = np.vstack([visual_match._pre_clip(p) for p in batch])
            # Inference
            d_emb = dsess.run(None, {"pixel_values": Dx})[0]
            c_emb = csess.run(None, {"pixel_values": Cx})[0]
            # L2 normalize (per row)
            d_emb /= np.linalg.norm(d_emb, axis=1, keepdims=True)
            c_emb /= np.linalg.norm(c_emb, axis=1, keepdims=True)
            # Write into pre-allocated output
            dmat[batch_start:batch_start + B] = d_emb.astype(np.float32)
            cmat[batch_start:batch_start + B] = c_emb.astype(np.float32)
            n_ok += B
        except Exception as e:
            print(f"  batch {batch_start} failed: {e}; falling back to "
                  f"single-item", flush=True)
            # Fallback per item in batch
            for j, p in enumerate(batch):
                try:
                    Dx1 = visual_match._pre_dino(p)
                    Cx1 = visual_match._pre_clip(p)
                    d_emb = dsess.run(None, {"pixel_values": Dx1})[0]
                    c_emb = csess.run(None, {"pixel_values": Cx1})[0]
                    d_emb /= np.linalg.norm(d_emb, axis=1, keepdims=True)
                    c_emb /= np.linalg.norm(c_emb, axis=1, keepdims=True)
                    idx = batch_start + j
                    dmat[idx] = d_emb[0].astype(np.float32)
                    cmat[idx] = c_emb[0].astype(np.float32)
                    n_ok += 1
                except Exception as e2:
                    print(f"    skip {os.path.basename(p)}: {e2}",
                          flush=True)
        # Free batch tensors aggressively
        del Dx, Cx, d_emb, c_emb
        gc.collect()

        if (batch_start // BATCH) % 5 == 0 or batch_start + B >= N:
            print(f"  {batch_start + B}/{N} ok={n_ok}", flush=True)

    print(f"\n[final] norm dmat[0]={np.linalg.norm(dmat[0]):.4f} "
          f"cmat[0]={np.linalg.norm(cmat[0]):.4f}", flush=True)

    print(f"[save] writing NPY + visual-ids.json ...", flush=True)
    np.save(DINO_OUT, dmat)
    np.save(CLIP_OUT, cmat)
    new_vis = {
        "skuIds": canonical_sids,
        "dino_dim": int(dmat.shape[1]),
        "clip_dim": int(cmat.shape[1]),
        "model": "dinov2-base+clip-vitb32 (onnx) [W2-1 deduped]",
        "skuId_to_row": skuId_to_row,
        "shared_sha": shared_sha,
    }
    json.dump(new_vis, open(VIS, "w"), ensure_ascii=False)

    print(f"\nDONE: DINO {dmat.shape}  CLIP {cmat.shape}  rows={N}", flush=True)
    print(f"  {DINO_OUT} = {os.path.getsize(DINO_OUT) / 1024 / 1024:.1f} MB",
          flush=True)
    print(f"  {CLIP_OUT} = {os.path.getsize(CLIP_OUT) / 1024 / 1024:.1f} MB",
          flush=True)
    print(f"  ok={n_ok}/{N}", flush=True)


if __name__ == "__main__":
    main()