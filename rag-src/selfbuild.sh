#!/bin/bash
set -e
cd /opt/puer-hub/rag-src
rm -rf donghe-images donghe-skus.jsonl 2>/dev/null
rm -f /opt/puer-hub/rag-data/donghe-dino.npy /opt/puer-hub/rag-data/donghe-clip.npy /opt/puer-hub/rag-data/donghe-visual-ids.json 2>/dev/null
ln -sf /opt/puer-hub/rag-data/donghe-skus.jsonl donghe-skus.jsonl
echo "=== [1/4] deps ==="
pip3 install -q --user -i https://pypi.tuna.tsinghua.edu.cn/simple onnx onnxruntime numpy pillow requests >/dev/null 2>&1
pip3 install -q --user --index-url https://download.pytorch.org/whl/cpu torch >/dev/null 2>&1
pip3 install -q --user -i https://pypi.tuna.tsinghua.edu.cn/simple transformers >/dev/null 2>&1
echo "=== [2/4] crawl donghe images (write into rag-src/donghe-images, then move to rag-data) ==="
mkdir -p donghe-images
python3 dh_images.py 2>&1 | tail -5
mv donghe-images /opt/puer-hub/rag-data/donghe-images
ln -sfn /opt/puer-hub/rag-data/donghe-images donghe-images
echo "images: $(ls /opt/puer-hub/rag-data/donghe-images/ | wc -l)"
echo "=== [3/4] export onnx ==="
RAG_DATA_DIR=/opt/puer-hub/rag-data python3 export_onnx.py export
echo "=== [4/4] precompute (streaming memmap) ==="
python3 - <<PY
import os, json, gc, numpy as np, onnxruntime as ort, sys
sys.path.insert(0, "/opt/puer-hub/rag-src")
import visual_match
HERE = "/opt/puer-hub/rag-data"
DINO = f"{HERE}/models/dinov2-base-img.onnx"
CLIP = f"{HERE}/models/clip-vitb32-img.onnx"
ids = []
recs_all = [json.loads(l) for l in open(f"{HERE}/donghe-skus.jsonl", encoding="utf-8")]
recs = []
for r in recs_all:
    sid = str(r["skuId"])
    p = f"{HERE}/donghe-images/{sid}.jpeg"
    if os.path.exists(p):
        recs.append(r)
print(f"{len(recs)} images")
dsess = ort.InferenceSession(DINO, providers=["CPUExecutionProvider"])
csess = ort.InferenceSession(CLIP, providers=["CPUExecutionProvider"])
d_path = f"{HERE}/donghe-dino.npy.tmp"
c_path = f"{HERE}/donghe-clip.npy.tmp"
B = 16
written = 0
for i in range(0, len(recs), B):
    batch = [f"{HERE}/donghe-images/{r[\"skuId\"]}.jpeg" for r in recs[i:i+B]]
    try:
        dvecs = np.vstack([dsess.run(None, {"pixel_values": visual_match._pre_dino(p)})[0][0] for p in batch])
        cvecs = np.vstack([csess.run(None, {"pixel_values": visual_match._pre_clip(p)})[0][0] for p in batch])
        dvecs /= np.linalg.norm(dvecs, axis=1, keepdims=True)
        cvecs /= np.linalg.norm(cvecs, axis=1, keepdims=True)
        if written == 0:
            dmm = np.lib.format.open_memmap(d_path, mode="w+", dtype=np.float32, shape=(len(recs), 768))
            cmm = np.lib.format.open_memmap(c_path, mode="w+", dtype=np.float32, shape=(len(recs), 512))
        dmm[written:written+B] = dvecs
        cmm[written:written+B] = cvecs
        ids += [r["skuId"] for r in recs[i:i+B]]
        written += len(batch)
        del dvecs, cvecs
        gc.collect()
        if (i // B) % 100 == 0: print(f"  {i}/{len(recs)}")
    except Exception as e:
        print("batch failed", i, e)
dmm.flush(); cmm.flush()
del dmm, cmm
os.rename(d_path, f"{HERE}/donghe-dino.npy")
os.rename(c_path, f"{HERE}/donghe-clip.npy")
json.dump({"skuIds": ids, "dino_dim": 768, "clip_dim": 512, "model": "dinov2-base+clip-vitb32 (onnx)"},
          open(f"{HERE}/donghe-visual-ids.json", "w"))
print(f"saved {len(ids)} skus")
PY
echo "=== DONE ==="
ls -la /opt/puer-hub/rag-data/models/ /opt/puer-hub/rag-data/*.npy 2>/dev/null
