#!/usr/bin/env python3
"""W2-1 rebuild NPY for canonical skuIds only.

Reads existing /opt/puer-hub/rag-data/donghe-visual-ids.json (post-dedup),
embeds ONLY the canonical SKU images (one per unique sha), writes new
donghe-dino.npy (3284x768) + donghe-clip.npy (3284x512) and re-saves
visual-ids.json with skuIds in the same order as NPY rows.

Usage (host python, NOT rag venv):
  RAG_DATA_DIR=/opt/puer-hub/rag-data python3 /opt/puer-hub/rag-src/v20-w1/rebuild_dedup_embeddings.py

Prereqs:
  - build_dedup_index.py --apply already run (visual-ids.json has canonical skuIds)
  - onnxruntime + numpy + PIL installed (host has 1.23.2 / 2.2.6)
  - visual_match importable (run from /opt/puer-hub/rag-src or sys.path)
"""
import json
import os
import sys

# Make visual_match importable from /opt/puer-hub/rag-src
sys.path.insert(0, "/opt/puer-hub/rag-src")

RAG_DATA = os.environ.get("RAG_DATA_DIR", "/opt/puer-hub/rag-data")
DINO_ONNX = f"{RAG_DATA}/models/dinov2-base-img.onnx"
CLIP_ONNX = f"{RAG_DATA}/models/clip-vitb32-img.onnx"
DINO_OUT = f"{RAG_DATA}/donghe-dino.npy"
CLIP_OUT = f"{RAG_DATA}/donghe-clip.npy"
VIS = f"{RAG_DATA}/donghe-visual-ids.json"
IMG_DIR = f"{RAG_DATA}/donghe-images"


def main():
    import numpy as np
    import onnxruntime as ort
    import visual_match
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None

    if not os.path.exists(VIS):
        print(f"FAIL: {VIS} missing — run build_dedup_index.py --apply first")
        sys.exit(2)
    vis = json.load(open(VIS))
    canonical_sids = vis["skuIds"]
    skuId_to_row = vis.get("skuId_to_row", {})
    shared_sha = vis.get("shared_sha", {})

    print(f"canonical skuIds: {len(canonical_sids)}")
    print(f"skuId_to_row: {len(skuId_to_row)} mappings")
    print(f"shared_sha groups: {len(shared_sha)}")

    # Sanity: every canonical must have image on disk
    missing = [s for s in canonical_sids
               if not os.path.exists(f"{IMG_DIR}/{s}.jpeg")]
    if missing:
        print(f"FAIL: {len(missing)} canonical images missing on disk:")
        for s in missing[:10]:
            print(f"  {s}.jpeg")
        sys.exit(3)

    # Pre-compute every row in canonical order
    image_paths = [f"{IMG_DIR}/{s}.jpeg" for s in canonical_sids]
    print(f"Embedding {len(image_paths)} canonical images...")

    print("[1/3] DINO+CLIP preprocessing (numpy) ...")
    dsess = ort.InferenceSession(DINO_ONNX, providers=["CPUExecutionProvider"])
    csess = ort.InferenceSession(CLIP_ONNX, providers=["CPUExecutionProvider"])
    B = 32
    dvecs, cvecs = [], []
    n_ok, n_skip = 0, 0
    for i in range(0, len(image_paths), B):
        batch = image_paths[i:i + B]
        try:
            dx = np.vstack([visual_match._pre_dino(p) for p in batch])
            cx = np.vstack([visual_match._pre_clip(p) for p in batch])
            dvecs.append(dx); cvecs.append(cx)
            n_ok += len(batch)
        except Exception as e:
            print(f"  batch {i} preprocess failed: {e}; falling back to single-item")
            for p in batch:
                try:
                    dvecs.append(visual_match._pre_dino(p))
                    cvecs.append(visual_match._pre_clip(p))
                    n_ok += 1
                except Exception as e2:
                    print(f"    skip {os.path.basename(p)}: {e2}")
                    n_skip += 1
        if (i // B) % 20 == 0:
            print(f"  preprocess {i}/{len(image_paths)} ok={n_ok} skip={n_skip}",
                  flush=True)
    D = np.vstack(dvecs)
    C = np.vstack(cvecs)
    print(f"  preprocess done: D={D.shape} C={C.shape}")

    print("[2/3] ONNX inference ...")
    def _all(sess, X):
        outs = []
        for i in range(0, len(X), 256):
            outs.append(sess.run(None, {"pixel_values": X[i:i + 256]})[0])
        return np.vstack(outs)
    dmat = _all(dsess, D)
    cmat = _all(csess, C)
    dmat /= np.linalg.norm(dmat, axis=1, keepdims=True)
    cmat /= np.linalg.norm(cmat, axis=1, keepdims=True)
    print(f"  D norm={np.linalg.norm(dmat[0]):.4f}  C norm={np.linalg.norm(cmat[0]):.4f}")

    print("[3/3] saving NPY + visual-ids.json ...")
    np.save(DINO_OUT, dmat.astype(np.float32))
    np.save(CLIP_OUT, cmat.astype(np.float32))
    new_vis = {
        "skuIds": canonical_sids,        # row i → skuId
        "dino_dim": int(dmat.shape[1]),
        "clip_dim": int(cmat.shape[1]),
        "model": "dinov2-base+clip-vitb32 (onnx)",
        "skuId_to_row": skuId_to_row,    # skuId → row index (6717→3284)
        "shared_sha": shared_sha,        # audit
    }
    json.dump(new_vis, open(VIS, "w"), ensure_ascii=False)

    print(f"\nDONE: DINO {dmat.shape} CLIP {cmat.shape}  rows={len(canonical_sids)}")
    print(f"  {DINO_OUT} = {os.path.getsize(DINO_OUT) / 1024 / 1024:.1f} MB")
    print(f"  {CLIP_OUT} = {os.path.getsize(CLIP_OUT) / 1024 / 1024:.1f} MB")
    if n_skip:
        print(f"  WARN: {n_skip} images skipped (canonical_sids list may need filter)")


if __name__ == "__main__":
    main()