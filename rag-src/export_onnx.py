#!/usr/bin/env python3
"""One-time dev tool: export DINOv2/CLIP image towers to ONNX + precompute
the 6716 donghe reference embeddings. NEVER shipped in the service image.

Run on the dev machine (system python3 has torch; the rag venv has
onnxruntime for precompute — precompute MUST use the same ONNX runtime +
visual_match._pre_* preprocessing as production queries, that is the
rank-consistency iron rule; the torch-computed /tmp npys from the original
recall experiments are NOT reused).

Usage:
  python3 export_onnx.py export     # torch -> rag-data/models/*.onnx (system py)
  python3 export_onnx.py verify     # torch-tower vs onnx parity < 1e-3 (system py)
  .venv/bin/python export_onnx.py precompute   # onnx embeddings -> rag-data/*.npy
"""
import json
import glob
import os
import sys

# (HF_ENDPOINT default omitted on purpose — the dev box's hf-mirror 308s to
# official huggingface.co which is unreachable from the production server; let
# the runtime pick its own default. The dev machine happens to have huggingface.co
# reachable too.)


def _snapshot(repo):
    """Resolve a cached HF snapshot dir when one exists (dev box sometimes
    can't reach hf-mirror); otherwise return the repo id and let
    from_pretrained fetch it via HF_ENDPOINT (server path, 11MB/s from
    hf-mirror)."""
    hits = glob.glob(os.path.expanduser(
        f"~/.cache/huggingface/hub/models--{repo.replace('/', '--')}/snapshots/*"))
    return hits[0] if hits else repo


ST_CLIP = _snapshot("sentence-transformers/clip-ViT-B-32")
if os.path.isdir(ST_CLIP) and not os.path.exists(f"{ST_CLIP}/model.safetensors"):
    ST_CLIP = f"{ST_CLIP}/0_CLIPModel"  # st snapshot layout: weights under 0_CLIPModel/
elif not os.path.isdir(ST_CLIP):
    # server-side first run: from_pretrained needs a repo id where the
    # weights live at the top level — sentence-transformers/clip-ViT-B-32
    # nests them under 0_CLIPModel/. Openai's clip-vit-base-patch32 is the
    # identical base model and ships the standard HF layout, so we fall
    # back to it. The exported ONNX is equivalent either way.
    ST_CLIP = "openai/clip-vit-base-patch32"

HERE = os.path.dirname(os.path.abspath(__file__))
# outputs (and only outputs) honor RAG_DATA_DIR so the server can generate
# straight into /opt/puer-hub/rag-data; inputs (jsonl, donghe-images/) are
# read relative to HERE
OUT = os.environ.get("RAG_DATA_DIR") or f"{HERE}/rag-data"
MODELS_DIR = f"{OUT}/models"
os.makedirs(MODELS_DIR, exist_ok=True)
DINO_ONNX = f"{MODELS_DIR}/dinov2-base-img.onnx"
CLIP_ONNX = f"{MODELS_DIR}/clip-vitb32-img.onnx"


# ---- export (torch only) ----
def _export():
    import torch
    from transformers import AutoModel, CLIPModel

    class DinoWrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return self.m(pixel_values=pixel_values).last_hidden_state[:, 0]

    dino = DinoWrap(AutoModel.from_pretrained(_snapshot("facebook/dinov2-base")).eval())
    with torch.no_grad():
        torch.onnx.export(
            dino, torch.zeros(1, 3, 224, 224), DINO_ONNX,
            input_names=["pixel_values"], output_names=["cls"],
            dynamic_axes={"pixel_values": {0: "b"}, "cls": {0: "b"}},
            opset_version=17, dynamo=False)
    print("dinov2 ->", DINO_ONNX)

    clip = CLIPModel.from_pretrained(ST_CLIP).eval()

    class ClipWrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            # explicit tower+projection: this transformers version's
            # get_image_features returns an Output object, not a tensor
            pooled = self.m.vision_model(pixel_values=pixel_values).pooler_output
            return self.m.visual_projection(pooled)

    with torch.no_grad():
        torch.onnx.export(
            ClipWrap(clip), torch.zeros(1, 3, 224, 224), CLIP_ONNX,
            input_names=["pixel_values"], output_names=["emb"],
            dynamic_axes={"pixel_values": {0: "b"}, "emb": {0: "b"}},
            opset_version=17, dynamo=False)
    print("clip ->", CLIP_ONNX)


# ---- verify (torch + onnxruntime; asserts preprocessing AND tower parity) ----
def _verify():
    import numpy as np
    import onnxruntime as ort
    import torch
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModel, CLIPImageProcessor, CLIPModel
    import visual_match

    dsess = ort.InferenceSession(DINO_ONNX, providers=["CPUExecutionProvider"])
    csess = ort.InferenceSession(CLIP_ONNX, providers=["CPUExecutionProvider"])
    dino = AutoModel.from_pretrained(_snapshot("facebook/dinov2-base")).eval()
    clip = CLIPModel.from_pretrained(ST_CLIP).eval()
    dproc = AutoImageProcessor.from_pretrained(_snapshot("facebook/dinov2-base"))
    cproc = CLIPImageProcessor.from_pretrained(ST_CLIP)

    samples = [f"{HERE}/donghe-images/2221.jpeg", f"{HERE}/donghe-images/1945.jpeg",
               f"{HERE}/donghe-images/2660.jpeg", "/tmp/tianfu7262.jpg", "/tmp/luyu99.jpg"]
    samples = [s for s in samples if os.path.exists(s)]
    for s in samples:
        pil = Image.open(s).convert("RGB")
        for name, pre_fn, sess, proc, model in [
                ("dino", visual_match._pre_dino, dsess, dproc, dino),
                ("clip", visual_match._pre_clip, csess, cproc, clip)]:
            hx = pre_fn(s)                                   # hand-written numpy preproc
            ref = proc(images=pil, return_tensors="pt")["pixel_values"]  # HF processor
            pre_delta = float(np.abs(hx - ref.numpy()).max())
            with torch.no_grad():
                if name == "dino":
                    tvec = model(pixel_values=ref).last_hidden_state[:, 0].numpy()[0]
                else:
                    pooled = clip.vision_model(pixel_values=ref).pooler_output
                    tvec = clip.visual_projection(pooled).numpy()[0]
            ovec = sess.run(None, {"pixel_values": hx})[0][0]
            cos = float(tvec @ ovec / (np.linalg.norm(tvec) * np.linalg.norm(ovec)))
            print(f"{os.path.basename(s)} {name}: preproc_maxdiff={pre_delta:.2e} cos={cos:.6f}")
            assert pre_delta < 1e-2, f"{name} preprocessing drift on {s}"
            assert cos > 1 - 1e-3, f"{name} onnx parity failed on {s}"
    print("verify OK (preproc + tower parity)")


# ---- precompute (rag venv: onnxruntime + visual_match._pre_*) ----
def _precompute():
    import numpy as np
    import onnxruntime as ort
    import visual_match

    dsess = ort.InferenceSession(DINO_ONNX, providers=["CPUExecutionProvider"])
    csess = ort.InferenceSession(CLIP_ONNX, providers=["CPUExecutionProvider"])
    recs = []
    for line in open(f"{HERE}/donghe-skus.jsonl", encoding="utf-8"):
        r = json.loads(line)
        if os.path.exists(f"{HERE}/donghe-images/{r['skuId']}.jpeg"):
            recs.append(r)
    print(f"{len(recs)} reference images")
    dvecs, cvecs, ids = [], [], []
    B = 32
    import PIL.Image
    PIL.Image.MAX_IMAGE_PIXELS = None
    for i in range(0, len(recs), B):
        batch = [f"{HERE}/donghe-images/{r['skuId']}.jpeg" for r in recs[i:i + B]]
        try:
            dx = np.vstack([visual_match._pre_dino(p) for p in batch])
            cx = np.vstack([visual_match._pre_clip(p) for p in batch])
        except Exception as e:  # unreadable image — skip the whole batch member-wise
            for p in batch:
                try:
                    dvecs.append(visual_match._pre_dino(p)); cvecs.append(visual_match._pre_clip(p))
                    ids.append(p)
                except Exception:
                    print("skip", p, e)
            continue
        dvecs.append(dx); cvecs.append(cx)
        ids.extend(batch)
        if (i // B) % 20 == 0:
            print(f"  {i}/{len(recs)}", flush=True)
    D = np.vstack(dvecs)
    C = np.vstack(cvecs)
    # batched runs through onnx (dynamic-batch export), then L2-normalize
    def _all(sess, X):
        outs = []
        for i in range(0, len(X), 256):
            outs.append(sess.run(None, {"pixel_values": X[i:i + 256]})[0])
        return np.vstack(outs)
    dmat = _all(dsess, D)
    cmat = _all(csess, C)
    dmat /= np.linalg.norm(dmat, axis=1, keepdims=True)
    cmat /= np.linalg.norm(cmat, axis=1, keepdims=True)
    sku_ids = [os.path.basename(p).split(".")[0] for p in ids]
    np.save(f"{OUT}/donghe-dino.npy", dmat.astype(np.float32))
    np.save(f"{OUT}/donghe-clip.npy", cmat.astype(np.float32))
    json.dump({"skuIds": sku_ids, "dino_dim": int(dmat.shape[1]),
               "clip_dim": int(cmat.shape[1]),
               "model": "dinov2-base+clip-vitb32 (onnx)"},
              open(f"{OUT}/donghe-visual-ids.json", "w"))
    print(f"saved {dmat.shape} / {cmat.shape} for {len(sku_ids)} skus")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "export"
    {"export": _export, "verify": _verify, "precompute": _precompute}[cmd]()
