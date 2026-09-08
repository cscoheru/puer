#!/usr/bin/env python3
"""Stage-1.5 visual comparison: user photo vs donghe reference images.

Why: wrapper text often has ZERO overlap with SKU names (天福7262 has no mark
number on the wrapper; 99陆羽's wrapper says 班章生態有機茶 while the SKU name
is 陆羽班章1号) — text retrieval structurally cannot match those. This stage
bridges via image-to-image similarity, experimentally validated (2026-08-19):

  - DINOv2-base CLS embedding: same-wrapper recall is rank-1-grade (.87+),
    but cross-layout variants (same series, different wrapper version) sink
    to rank ~2000 — dead for those;
  - CLIP ViT-B/32: same-product recall useless (rank ~800), BUT its top hits
    are series siblings — anchoring on brand bigrams extracted from the hit
    names recalls the true target through donghe_lookup;
  - MiniMax-M3 two-image comparison is the final judge (needs the
    same_series_variant tier for multi-wrapper releases).

Lazy singleton mirrors retriever._ensure_loaded; numpy/onnxruntime are
imported lazily so the module is importable without them (silent degrade
contract: compare() NEVER raises — returns {"ok": False, "reason": ...}).
"""
import json
import os
import re

import teacher_api

RAG = os.environ.get("RAG_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
DINO_ONNX = f"{RAG}/models/dinov2-base-img.onnx"
CLIP_ONNX = f"{RAG}/models/clip-vitb32-img.onnx"
DINO_NPY = f"{RAG}/donghe-dino.npy"
CLIP_NPY = f"{RAG}/donghe-clip.npy"
IDS_JSON = f"{RAG}/donghe-visual-ids.json"

# how many candidates survive to the M3 comparison stage. Slots: dino top-2
# (same-wrapper evidence) + series-recall top-2 (one representative PER brand
# family — a single series slot gets monopolized by the largest family, the
# 99陆羽 rescue family lost exactly that way) + clip top-1 (series-style
# representative). Pure score-ranking would let dino's generic 7572-style
# hits crowd out the series rescue (measured .79 vs .57).
N_COMPARE = 5

# generic layout/tea words that appear on thousands of wrappers — never brand
# anchors. Keep aligned with the domain, extend freely.
STOP_BIGRAMS = {
    "普洱", "生茶", "熟茶", "七子", "饼茶", "生态", "有机", "云南", "西双版纳",
    "勐海", "茶厂", "出品", "大益", "中茶", "下关", "进出口", "公司", "监制",
    "贡茶", "青饼", "青砖", "贡饼", "圆茶", "乔木", "古树", "野生", "珍藏",
    "经典", "特级", "一级", "二级", "三级", "贡品", "礼品", "纪念", "生态茶",
}

VERDICTS = ("same_product", "same_series_variant", "different_product", "uncertain")

# VLM chain for visual comparison. minimax is the proven comparator (5h
# rolling quota); bailian is the configured fallback once ANTHROPIC_TEACHER_TOKEN
# is populated in the container. Overridable via RAG_VLM_CHAIN env.
VLM_CHAIN = [p for p in
             os.environ.get("RAG_VLM_CHAIN", "minimax,bailian").split(",") if p]

COMPARE_SYSTEM = ("你是茶叶包装鉴定比对助手。只依据两图可见内容作客观比对,"
                  "严禁推测图上没有的信息。所有输出用简体中文。")

COMPARE_PROMPT = """图1是待鉴定茶品(用户实拍棉纸),图2是数据库参照图。逐项比对版面:中央主文字与图案、环绕文字、字体形态、排版布局、色彩、纸质痕迹。
输出一个 JSON 对象(不要输出其他内容):
{"verdict": "same_product|same_series_variant|different_product|uncertain",
 "confidence": 0到1的小数,
 "notes": "1-2句:一致的版面元素或差异点(年份/唛号/版式/字体/图案)"}
判定标准:
- same_product: 版面文字、图案、布局高度一致(拍摄差异除外)
- same_series_variant: 同品牌/同系列的可识别标志(人物图/印章/签名式用字)一致,但年份、版式或用字有差异——早年茶常见同款多版棉纸
- different_product: 核心版面元素明显不同
- uncertain: 两图信息不足以判断"""


class _Unavailable(Exception):
    """Visual assets missing/misaligned — callers degrade silently."""


_V = None  # module singleton; built by _ensure_loaded()


def _ensure_loaded():
    global _V
    if _V is not None:
        return _V
    import numpy as np  # noqa: F401 — fail fast if runtime deps absent
    import onnxruntime as ort
    for f in (DINO_ONNX, CLIP_ONNX, DINO_NPY, CLIP_NPY, IDS_JSON):
        if not os.path.exists(f):
            raise _Unavailable(f"asset_missing:{os.path.basename(f)}")
    meta = json.load(open(IDS_JSON))
    ids = meta["skuIds"]
    dino_mat = np.load(DINO_NPY)
    clip_mat = np.load(CLIP_NPY)
    if len(ids) != dino_mat.shape[0] or len(ids) != clip_mat.shape[0]:
        raise _Unavailable("ids_mismatch")
    so = ort.SessionOptions()
    dino_sess = ort.InferenceSession(DINO_ONNX, so, providers=["CPUExecutionProvider"])
    clip_sess = ort.InferenceSession(CLIP_ONNX, so, providers=["CPUExecutionProvider"])
    recs = {}
    import retriever
    for line in open(retriever.DONGHE, encoding="utf-8"):
        r = json.loads(line)
        recs[str(r["skuId"])] = r
    # catalog-wide brand-bigram frequency: an anchor word is only trusted when
    # the whole catalog contains 3..30 SKUs naming it — that band holds real
    # brand families (陆羽=4), while generic words (生态, hundreds) and
    # one-off fragments (苦茗=1) fall outside it.
    brand_df = {}
    for r in recs.values():
        for b in _seg_bigrams(r.get("name")):
            brand_df[b] = brand_df.get(b, 0) + 1
    _V = {"np": np, "dino_sess": dino_sess, "clip_sess": clip_sess,
          "dino_mat": dino_mat, "clip_mat": clip_mat, "ids": ids,
          "pos": {sid: i for i, sid in enumerate(ids)}, "recs": recs,
          "brand_df": brand_df}
    return _V


# ---------- preprocessing (hand-written numpy+PIL; export_onnx.verify pins
# these against the HF processors numerically) ----------
def _prep(img, short_side, mean, std):
    """short-side resize (bicubic) -> center crop 224 -> CHW float32 normalized."""
    import numpy as np
    import PIL.Image
    im = PIL.Image.open(img).convert("RGB")
    w, h = im.size
    scale = short_side / min(w, h)
    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                   PIL.Image.BICUBIC)
    w, h = im.size
    left, top = (w - 224) // 2, (h - 224) // 2
    im = im.crop((left, top, left + 224, top + 224))
    x = np.asarray(im, dtype=np.float32) / 255.0  # HWC
    x = (x - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    return np.ascontiguousarray(x.transpose(2, 0, 1))[None]  # [1,3,224,224]


def _pre_clip(path):
    # OpenCLIP ViT-B/32 image preprocessing (HF CLIPImageProcessor defaults)
    return _prep(path, 224,
                 (0.48145466, 0.4578275, 0.40821073),
                 (0.26862954, 0.26130258, 0.27577711))


def _pre_dino(path):
    # facebook/dinov2-base BitImageProcessor: short side 256 -> crop 224
    # -> ImageNet stats
    return _prep(path, 256,
                 (0.485, 0.456, 0.406),
                 (0.229, 0.224, 0.225))


def _embed(sess, x, out_dim):
    import numpy as np
    v = sess.run(None, {"pixel_values": x})[0][0].astype(np.float32)
    assert v.shape == (out_dim,), f"unexpected onnx output {v.shape}"
    return v / np.linalg.norm(v)


# ---------- series anchoring ----------
def _seg_bigrams(name):
    """CJK bigrams within name segments (split on non-CJK and the year 年 —
    fragments glued across years pollute the anchors otherwise)."""
    out = set()
    for s in (x for x in re.split(r"[^一-鿿]+|年", name or "") if len(x) >= 2):
        out.update(s[i:i + 2] for i in range(len(s) - 1))
    return out


def _brand_anchors(V, clip_names):
    """Deterministic anchor discovery: pure-CJK bigrams of the CLIP hit names
    that sit in the brand-size band (3..30 catalog SKUs name them). An LLM
    word-spotter was tried here first and was unreliable at this
    signal-to-noise (three runs, three word lists, 陆羽 never picked);
    bigram + catalog-wide frequency is stable. Overlapping fragments of one
    brand (八角/角亭) are fine — both recall the same family and members
    dedup by skuId."""
    out = []
    for n in clip_names:
        for b in _seg_bigrams(n):
            if b in STOP_BIGRAMS:
                continue
            if 3 <= V["brand_df"].get(b, 0) <= 30 and b not in out:
                out.append(b)
    return out[:8]


def _vlm_pick(query_path, refs):
    """One multi-image M3 call: pick the 2 reference images most likely to be
    the same product as the query. Coarse task, cheap, decides which series
    members earn the expensive pairwise comparison."""
    if not refs:
        return []
    lines = [f"图1是待鉴定茶品(用户实拍)。其后依次是编号 A1-A{len(refs)} 的数据库参照图。"]
    prompt = ("选出与图1最可能是同一款茶(或同系列不同版本)的参照图,最多2个,按可能性从高到低。"
              "只输出编号,如: A2, A5;若都不像则只输出: 无")
    out, _used = teacher_api.ask_vision("\n".join(lines), images=[query_path] + refs,
                                        system=COMPARE_SYSTEM, max_tokens=60,
                                        providers=VLM_CHAIN)
    out = (out or "").strip()
    picked = []
    for m in re.finditer(r"A(\d+)", out):
        i = int(m.group(1)) - 1
        if 0 <= i < len(refs) and i not in picked:
            picked.append(i)
        if len(picked) >= 2:
            break
    return picked


# ---------- VLM comparison ----------
def _parse_json_sloppy(text):
    import json as _json
    m = re.search(r"\{.*\}", text or "", flags=re.S)
    if not m:
        return None
    try:
        return _json.loads(m.group(0))
    except _json.JSONDecodeError:
        return None


def _vlm_compare(query_path, ref_path):
    out, _used = teacher_api.ask_vision(
        COMPARE_PROMPT, images=[query_path, ref_path],
        system=COMPARE_SYSTEM, max_tokens=600, providers=VLM_CHAIN)
    if not out:
        return None
    parsed = _parse_json_sloppy(out)
    if not parsed:
        return {"verdict": "uncertain", "confidence": 0.3, "notes": "比对输出无法解析"}
    v = str(parsed.get("verdict", "")).strip()
    if v not in VERDICTS:
        v = "uncertain"
    try:
        c = min(1.0, max(0.0, float(parsed.get("confidence", 0.5))))
    except (TypeError, ValueError):
        c = 0.5
    return {"verdict": v, "confidence": round(c, 2),
            "notes": str(parsed.get("notes", "")).strip()[:300]}


# ---------- main entry ----------
def compare(image_path, ocr_text=""):
    """User photo vs donghe reference corpus. Never raises.
    Returns {"ok", "reason", "brand", "candidates", "verdicts", "best"}."""
    try:
        V = _ensure_loaded()
    except _Unavailable as e:
        return {"ok": False, "reason": str(e), "brand": "",
                "candidates": [], "verdicts": None, "best": None}
    try:
        import retriever
        qd = _embed(V["dino_sess"], _pre_dino(image_path), V["dino_mat"].shape[1])
        qc = _embed(V["clip_sess"], _pre_clip(image_path), V["clip_mat"].shape[1])
    except Exception:
        return {"ok": False, "reason": "image_error", "brand": "",
                "candidates": [], "verdicts": None, "best": None}
    np = V["np"]

    dsims = V["dino_mat"] @ qd
    csims = V["clip_mat"] @ qc
    dorder = np.argsort(-dsims)
    corder = np.argsort(-csims)

    def hit(i, d, c):
        sid = V["ids"][i]
        return {"skuId": sid, "name": V["recs"].get(sid, {}).get("name") or sid,
                "dino_sim": round(float(d), 4), "clip_sim": round(float(c), 4),
                "idx": i}

    dino_top = [hit(i, dsims[i], csims[i]) for i in dorder[:24]]
    clip_top = [hit(i, csims[i], dsims[i]) for i in corder[:12]]

    # series anchoring: brand-band bigrams of the CLIP hit names ->
    # donghe_lookup recalls series members that neither tower surfaces
    # (cross-layout variants: same series, different wrapper release).
    # Members then go through ONE multi-image pick call — coarse M3
    # shortlist instead of burning pairwise compares on the whole pool.
    anchors = _brand_anchors(V, [h["name"] for h in clip_top])
    series, seen_sid = [], set()
    import retriever
    for a in anchors:
        for s, r in retriever.donghe_lookup(a, topk=6):
            sid = str(r["skuId"])
            if sid in V["pos"] and sid not in seen_sid:
                seen_sid.add(sid)
                i = V["pos"][sid]
                series.append({"skuId": sid, "name": r.get("name") or sid,
                               "dino_sim": round(float(dsims[i]), 4),
                               "clip_sim": round(float(csims[i]), 4),
                               "idx": i, "via": f"anchor:{a}"})
    series = sorted(series, key=lambda x: -x["clip_sim"])[:12]

    # candidate slots: dino top-2 + series-picked top-2 + clip top-1
    pool, used = [], set()

    def add(h):
        if h["skuId"] not in used and os.path.exists(
                retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))):
            used.add(h["skuId"])
            pool.append(h)
            return True
        return False

    for h in dino_top[:2]:
        add(h)
    if series:
        refs = [retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))
                for h in series]
        for i in _vlm_pick(image_path, refs):
            add(series[i])
    for h in clip_top:
        if len(pool) >= N_COMPARE:
            break
        add(h)
    fam_brand = " ".join(dict.fromkeys(h["via"].split(":", 1)[1] for h in series))

    verdicts = []
    for h in pool[:N_COMPARE]:
        ref = retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))
        v = _vlm_compare(image_path, ref)
        if v:
            v.update({"skuId": h["skuId"], "name": h["name"],
                      "record": V["recs"].get(h["skuId"])})
            verdicts.append(v)
    if not verdicts:
        verdicts = None

    best = None
    if verdicts:
        rank = {v: i for i, v in enumerate(VERDICTS)}
        best = sorted(verdicts, key=lambda x: (rank[x["verdict"]], -x["confidence"]))[0]

    return {"ok": True, "reason": None,
            "brand": fam_brand,
            "candidates": [{k: h[k] for k in ("skuId", "name", "dino_sim", "clip_sim")}
                           for h in pool[:N_COMPARE]],
            "verdicts": verdicts, "best": best}


if __name__ == "__main__":
    import sys
    img = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tianfu7262.jpg"
    ocr = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(compare(img, ocr), ensure_ascii=False, indent=2))
