#!/usr/bin/env python3
"""Backfill SKU 9505 (2501 金大益) into the donghe visual index.

Root cause (W1-2 audit reversal): 9505 lives in the upstream product DB but
not in the quote-list endpoint the snapshot was exported from, so the 2025
reissue was invisible to candidate recall and 2003 won by default. The detail
endpoint item/detail/general/9505 does carry market prices, so we backfill
the full 12-field row.

Two-phase because the container mounts /data read-only:
  compute  — run INSIDE puer-hub-rag-service. Reads the index read-only,
             computes the new SKU's DINO/CLIP vectors with visual_match's own
             _pre_dino/_pre_clip/_embed (preprocessing pinned to the original
             build), vstacks full replacement npy matrices, and writes all
             four updated artifacts to a WRITABLE output dir (default /app/out).
  apply    — run on the HOST with plain python3 (stdlib only, no numpy).
             Backs up the four live files to <path>.w1-backup, then installs
             the artifacts: replaces both npy files, replaces visual-ids.json,
             appends the metadata row to donghe-skus.jsonl.

Idempotent: both phases exit 0 without writing when "9505" is already in
skuIds. Rollback: restore the four .w1-backup files and restart the container.
"""
import json
import os
import shutil
import sys

SKU_ID = "9505"
RAG = os.environ.get("RAG_DATA_DIR") or "/data"
DINO_NPY = f"{RAG}/donghe-dino.npy"
CLIP_NPY = f"{RAG}/donghe-clip.npy"
IDS_JSON = f"{RAG}/donghe-visual-ids.json"
SKUS = f"{RAG}/donghe-skus.jsonl"
IMG = f"{RAG}/donghe-images/{SKU_ID}.jpeg"

# From item/detail/general/9505 on 2026-08-21: info.skuName/skuTitle, images[0],
# price 23000 / lastMarketPrice 23500 / riseAndFall -500 / -0.0213 / 2026-08-18.
# brandImg copied from the other dayi rows (brandId 1). Field order matches the
# existing rows exactly.
ROW = {
    "skuId": SKU_ID,
    "name": "2501 金大益",
    "img": "https://donghemall-test.oss-cn-guangzhou.aliyuncs.com/20260702/ca685de027a0fb44aaef72c430f5faec.jpeg",
    "brandImg": "https://donghemall-test.oss-cn-guangzhou.aliyuncs.com/20241216/30db24d50b9f422cff341b0c7f2309b9.jpeg",
    "price": 23000.0,
    "lastPrice": 23500.0,
    "change": -500.0,
    "changeRatio": -0.0213,
    "unit": "件",
    "year": "2025",
    "priceUpdatedAt": "2026-08-18 09:28:42",
    "source": "donghenet",
}


def already_indexed():
    meta = json.load(open(IDS_JSON))
    return SKU_ID in meta["skuIds"]


def do_compute(out_dir):
    if already_indexed():
        print("9505 already indexed — nothing to do")
        return 0
    if not os.path.exists(IMG):
        return f"FATAL: reference image missing: {IMG}"

    import numpy as np
    import onnxruntime as ort
    sys.path.insert(0, "/app")
    import visual_match as vm  # reuse its preprocessing/model paths verbatim

    dino = np.load(DINO_NPY)
    clip = np.load(CLIP_NPY)
    so = ort.SessionOptions()
    ds = ort.InferenceSession(vm.DINO_ONNX, so,
                              providers=["CPUExecutionProvider"])
    cs = ort.InferenceSession(vm.CLIP_ONNX, so,
                              providers=["CPUExecutionProvider"])
    qd = vm._embed(ds, vm._pre_dino(IMG), dino.shape[1])
    qc = vm._embed(cs, vm._pre_clip(IMG), clip.shape[1])
    print(f"vectors: dino{qd.shape} clip{qc.shape}")

    os.makedirs(out_dir, exist_ok=True)
    np.save(f"{out_dir}/donghe-dino.npy", np.vstack([dino, qd[None]]))
    np.save(f"{out_dir}/donghe-clip.npy", np.vstack([clip, qc[None]]))
    meta = json.load(open(IDS_JSON))
    meta["skuIds"].append(SKU_ID)
    with open(f"{out_dir}/donghe-visual-ids.json", "w") as f:
        json.dump(meta, f)
    with open(f"{out_dir}/donghe-skus.tail.jsonl", "w", encoding="utf-8") as f:
        f.write(json.dumps(ROW, ensure_ascii=False) + "\n")

    d2 = np.load(f"{out_dir}/donghe-dino.npy")
    m2 = json.load(open(f"{out_dir}/donghe-visual-ids.json"))
    assert d2.shape[0] == dino.shape[0] + 1 == len(m2["skuIds"])
    assert m2["skuIds"][-1] == SKU_ID
    print(f"OK compute: artifacts in {out_dir} "
          f"({dino.shape[0]} -> {d2.shape[0]} rows, 9505 at tail)")
    return 0


def do_apply(out_dir, live_dir):
    if already_indexed():
        print("9505 already indexed — nothing to do")
        return 0
    for name in ("donghe-dino.npy", "donghe-clip.npy",
                 "donghe-visual-ids.json", "donghe-skus.tail.jsonl"):
        if not os.path.exists(f"{out_dir}/{name}"):
            return f"FATAL: artifact missing: {out_dir}/{name} (run compute first)"

    for live in (SKUS, DINO_NPY, CLIP_NPY, IDS_JSON):
        b = live + ".w1-backup"
        if not os.path.exists(b):
            shutil.copy2(live, b)
            print("backup:", b)

    tail = open(f"{out_dir}/donghe-skus.tail.jsonl", encoding="utf-8").read()
    with open(SKUS, "a", encoding="utf-8") as f:
        f.write(tail)
    shutil.copy2(f"{out_dir}/donghe-dino.npy", DINO_NPY)
    shutil.copy2(f"{out_dir}/donghe-clip.npy", CLIP_NPY)
    shutil.copy2(f"{out_dir}/donghe-visual-ids.json", IDS_JSON)

    # stdlib-only round-trip check: jsonl tail + ids tail + npy sizes
    last = json.loads(open(SKUS, encoding="utf-8").readlines()[-1])
    assert last["skuId"] == SKU_ID
    m2 = json.load(open(IDS_JSON))
    assert m2["skuIds"][-1] == SKU_ID
    sizes = {n: os.path.getsize(f"{live_dir}/{n}")
             for n in ("donghe-dino.npy", "donghe-clip.npy")}
    exp_dino = (len(m2["skuIds"]) * 768 * 4) + 128  # npy header
    exp_clip = (len(m2["skuIds"]) * 512 * 4) + 128
    assert abs(sizes["donghe-dino.npy"] - exp_dino) < 256, sizes
    assert abs(sizes["donghe-clip.npy"] - exp_clip) < 256, sizes
    print(f"OK apply: four layers live ({len(m2['skuIds'])} skus). "
          f"Restart puer-hub-rag-service to reload.")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "compute"
    out = os.environ.get("BACKFILL_OUT", "/app/out")
    if mode == "compute":
        sys.exit(do_compute(out))
    elif mode == "apply":
        sys.exit(do_apply(out, RAG))
    else:
        sys.exit(f"unknown mode {mode!r} (compute|apply)")
