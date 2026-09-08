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
import threading
import time
from concurrent.futures import ThreadPoolExecutor

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
# W1-4: env-tunable, default 3. M7 had bumped this to 12 so DINO long-tail
# candidates (rank 50-100) reached M3 — but 12 SERIAL M3 calls measured
# 123.97s (84.9% of total latency; users hit browser-abort 499 first). With
# the pool priority (m3_text → vlm_pick → dino) the top-3 slots already carry
# the strongest signals; the long-tail dino fill was exactly the no-signal
# regime where M3 fabricated verdicts (fresh run: 501白针贡饼 same_product
# 0.95 on an unrelated photo). Roll back with VM_N_COMPARE=12.
N_COMPARE = int(os.environ.get("VM_N_COMPARE", "3"))
# W1-4: pairwise M3 calls run in PARALLEL (was a serial for-loop). Bounded
# both per-request and globally so concurrent asks don't multiply M3 load.
_CMP_WORKERS = int(os.environ.get("VM_COMPARE_WORKERS", "3"))
# W1-2: guarantee dino rank-1 a compare slot (see compare()); 0 disables.
_DINO_TOP1_GUARD = os.environ.get("VM_DINO_TOP1_GUARD", "1") != "0"
_CMP_SEM = threading.BoundedSemaphore(int(os.environ.get("VM_GLOBAL_M3", "4")))

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
    """CJK 2/3/4-grams within name segments (split on non-CJK and the year 年 —
    fragments glued across years pollute the anchors otherwise). 4-grams capture
    whole-series names like 越陈越香 / 班章生态 that sliding 2-grams would shatter
    into meaningless 2-chars (越陈/陈越/越香, df=0 — hence brand anchor never
    fires for major series)."""
    out = set()
    for s in (x for x in re.split(r"[^一-鿿]+|年", name or "") if len(x) >= 2):
        for n in (2, 3, 4):
            for i in range(len(s) - n + 1):
                out.add(s[i:i + n])
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
            if 3 <= V["brand_df"].get(b, 0) <= 50 and b not in out:
                out.append(b)
    return out[:8]


def _vlm_pick(query_path, refs, dino_sims=None):
    """One multi-image M3 call: pick the 3 reference images most likely to be
    the same product as the query. Coarse task, cheap, decides which series
    members earn the expensive pairwise comparison. (M7: was 2 → 3 for
    OCR-failed images.)"""
    if not refs:
        return []
    lines = [f"图1是用户实拍。其后依次是 A1-A{len(refs)} 的参照图。"]
    prompt = ("ONLY output up to 3 reference numbers that look most similar to "
              "图1 (the user photo). Format: A2, A5, A8. If none, output exactly: 无. "
              "No explanation, no markdown, no other text.")
    out, _used = teacher_api.ask_vision("\n".join(lines), images=[query_path] + refs,
                                        system=COMPARE_SYSTEM, max_tokens=20,
                                        providers=VLM_CHAIN)
    out = (out or "").strip()
    picked = []
    for m in re.finditer(r"A(\d+)", out):
        i = int(m.group(1)) - 1
        if 0 <= i < len(refs) and i not in picked:
            picked.append(i)
        if len(picked) >= 3:
            break
    if not picked:
        # Fallback: M3 may ignore "ONLY output numbers" and write a verbose
        # report — when regex matches zero, default to top-3 by DINO sim
        # (the visual-signal shortlist). Better than dropping the entire
        # series rescue — user's 2000 越陈越香 (1862) sits at dino rank 75
        # but is genuinely the right answer; pure clip_sim sort would
        # surface visually-plausible-but-different wrappers (1901 越陈越香)
        # instead.
        if dino_sims is not None:
            order = sorted(range(len(refs)), key=lambda i: -dino_sims[i])
            picked = order[:3]
        else:
            picked = list(range(min(3, len(refs))))
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
def compare(image_path, ocr_text="", return_pool_only: bool = False):
    """User photo vs donghe reference corpus. Never raises.
    Returns {"ok", "reason", "brand", "candidates", "verdicts", "best"}.

    W1-3: when return_pool_only=True, skip _vlm_pick / _vlm_compare / parallel
    M3 calls and return the candidate pool + planned-compare size. Used by
    the offline eval scorer to baseline recall without burning M3 quota.
    Default False preserves all existing call sites (rag_pipeline.answer
    etc.) unchanged.
    """
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
    # W1-1: per-M3-call diagnostics (consumed by rag_pipeline's TRACE line).
    m3_diag = []

    dsims = V["dino_mat"] @ qd
    csims = V["clip_mat"] @ qc
    dorder = np.argsort(-dsims)
    corder = np.argsort(-csims)

    def hit(i, d, c):
        sid = V["ids"][i]
        return {"skuId": sid, "name": V["recs"].get(sid, {}).get("name") or sid,
                "dino_sim": round(float(d), 4), "clip_sim": round(float(c), 4),
                "idx": i}

    # M7: expand DINO shortlist — take everything with sim≥0.65 (covers ~top-80
    # ranks). Real-user photos with tea-base occlusion push same-product
    # candidates to rank 50-100 (1862 越陈越香世纪饼 rank=75, sim=0.6501).
    # Top-24 alone missed it; M3 then compared only against visually-similar-
    # but-different wrappers (1801 岁月陈香, 807 7572) and gave different_product.
    # 0.65 floor keeps the pool small (~30-60 candidates) while capturing
    # the user's likely target.
    dino_shortlist = [hit(i, dsims[i], csims[i]) for i in dorder
                      if dsims[i] >= 0.65]
    dino_top = dino_shortlist
    clip_top = [hit(i, csims[i], dsims[i]) for i in corder[:12]]

    # series anchoring: brand-band bigrams of the CLIP hit names ->
    # donghe_lookup recalls series members that neither tower surfaces
    # (cross-layout variants: same series, different wrapper release).
    # Members then go through ONE multi-image pick call — coarse M3
    # shortlist instead of burning pairwise compares on the whole pool.
    anchors = _brand_anchors(V, [h["name"] for h in clip_top])
    series, seen_sid = [], set()
    import retriever
    # First pass: each anchor via exact lookup (cheap)
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
    # Second pass: OCR-text fallback via fuzzy lookup — handles drop/struck chars
    # (user's 「陳越香」drops the first 「越」 → exact returns 0; fuzzy by prefix
    # overlap surfaces the 越陈越香 series so M3 can shortlist the right member).
    if ocr_text:
        for s, r in retriever.donghe_lookup_fuzzy(ocr_text, topk=6):
            sid = str(r["skuId"])
            if sid in V["pos"] and sid not in seen_sid:
                seen_sid.add(sid)
                i = V["pos"][sid]
                series.append({"skuId": sid, "name": r.get("name") or sid,
                               "dino_sim": round(float(dsims[i]), 4),
                               "clip_sim": round(float(csims[i]), 4),
                               "idx": i, "via": f"ocr_fuzzy:{ocr_text}"})
    # Third pass (M7): OCR-mis-failed rescue — when OCR returned text but
    # brand-anchor produced nothing useful (e.g. user photo has 「班章益末」
    # misread but actual wrapper is 「越陈越香」), fall back to donghe_lookup
    # on the most distinctive OCR token (4-char leading group). Cheap heuristic:
    # if ocr_text has a 4-char CJK sequence, try that as an exact token.
    if ocr_text and not series:
        import re as _re
        for tok in _re.findall(r"[一-鿿]{4}", ocr_text):
            for s, r in retriever.donghe_lookup(tok, topk=3):
                sid = str(r["skuId"])
                if sid in V["pos"] and sid not in seen_sid:
                    seen_sid.add(sid)
                    i = V["pos"][sid]
                    series.append({"skuId": sid, "name": r.get("name") or sid,
                                   "dino_sim": round(float(dsims[i]), 4),
                                   "clip_sim": round(float(csims[i]), 4),
                                   "idx": i, "via": f"ocr_token:{tok}"})
    # Fourth pass (M7+): M3 wrapper-text rescue — ALWAYS run. OCR routinely
    # botches brand text (returned 「班章益末」 but actual wrapper was
    # 「越陈越香」); M3 reads text + structure from the image itself
    # (proven: M3 said "图1中央主体文字为'越陳越香'红色印章式大字"). Single
    # cheap call surfaces series that anchors + OCR text + fuzzy all miss.
    try:
        prompt = ("图1是一饼普洱茶的棉纸包装。只输出包装上最显眼的2-4个汉字"
                  "品牌/唛号/标识(如「越陈越香」「7572」「陈升号」)。若图上无"
                  "清晰文字则只输出: 无。不要解释。")
        _t = time.monotonic()
        out, _ = teacher_api.ask_vision(prompt, images=[image_path],
                                        system=COMPARE_SYSTEM, max_tokens=40,
                                        providers=VLM_CHAIN)
        m3_diag.append({"stage": "m3_text", "s": round(time.monotonic() - _t, 2)})
        for tok in re.findall(r"[一-鿿]{2,4}", out or ""):
            if tok in ("包装", "普洱", "棉纸", "图上", "中央", "主体", "大字", "小字"): continue
            # topk=20: 越陈越香 has 20+ SKUs in donghe; rank-1 series like
            # 7572 (40+) easily exceed topk=4 — M3 pick needs the full set
            # to shortlist the right member.
            for s, r in retriever.donghe_lookup(tok, topk=20):
                sid = str(r["skuId"])
                if sid in V["pos"] and sid not in seen_sid:
                    seen_sid.add(sid)
                    i = V["pos"][sid]
                    series.append({"skuId": sid, "name": r.get("name") or sid,
                                   "dino_sim": round(float(dsims[i]), 4),
                                   "clip_sim": round(float(csims[i]), 4),
                                   "idx": i, "via": f"m3_text:{tok}"})
    except Exception:
        pass
    # NOTE: no [:12] cap — M3 pick / m3_text filter below need the full
    # series (don't cut off 越陈越香 members at clip-rank 7+)

    # candidate slots: M7 — series-rescue members get FORCE-INCLUDED (not
    # ranked by dino_sim). Why: OCR-failed images (user's 2000 越陈越香:
    # OCR→"班章益末" but actual wrapper "越陈越香") put the true target at
    # dino rank ~75 (sim 0.65); dino_top[:12] saturates the pool with
    # visually-similar wrappers (1801 岁月陈香, 807 7572), and the
    # series-rescue pick dies in `pool_sorted[:N_COMPARE]`. Force inclusion
    # here = series wins when brand anchor / M3-text reads it correctly.
    pool, used = [], set()

    def add(h):
        if h["skuId"] not in used and os.path.exists(
                retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))):
            used.add(h["skuId"])
            pool.append(h)
            return True
        return False

    # M7 priority order for pool: m3_text first (deterministic, reads wrapper
    # text directly), then series-pick (M3 multi-image selection), then dino
    # visual shortlist, then clip. Why m3_text first: OCR often fails
    # completely (user's 「班章益末」 vs actual 「越陈越香」), and M3 pick
    # gets fooled by visually-similar-but-different wrappers (陈香七子饼,
    # 陈香雅韵 — same factory layout, different brand). m3_text is the
    # only path that saw the actual wrapper text.
    pool, used = [], set()
    series_picks_added = 0  # tracked for downstream sort key

    def add(h):
        if h["skuId"] not in used and os.path.exists(
                retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))):
            used.add(h["skuId"])
            pool.append(h)
            return True
        return False

    # 1. m3_text-rescued top-3 by dino_sim DESC (visual closest of the
    #    text-correct series)
    # NOTE: don't pre-cap series[:12] — that slice sorts by clip_sim and
    # drops the visually-closest 越陈越香 SKUs (user's 1862 clip 0.7708
    # ranks 7-th, after anchor 陈香 siblings clip 0.80+). Filter + sort
    # the FULL m3_text list instead.
    m3_text_picks = [h for h in series if h.get("via", "").startswith("m3_text:")]
    m3_text_picks.sort(key=lambda x: -x["dino_sim"])
    for h in m3_text_picks[:3]:
        added = add(h)
        if added:
            series_picks_added += 1
    # 2. M3 multi-image pick from the rest of series (top-3 fills remaining)
    if series:
        refs = [retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))
                for h in series]
        series_dinos = [h["dino_sim"] for h in series]
        _t = time.monotonic()
        _picks = _vlm_pick(image_path, refs, dino_sims=series_dinos)[:3]
        m3_diag.append({"stage": "vlm_pick", "s": round(time.monotonic() - _t, 2)})
        for i in _picks:
            if len(pool) >= N_COMPARE:
                break
            if add(series[i]):
                series_picks_added += 1
    # 3. dino top fill (~6-9 slots left)
    dino_top_sorted = sorted(dino_top, key=lambda x: -x["dino_sim"])
    for h in dino_top_sorted:
        if len(pool) >= N_COMPARE:
            break
        add(h)
    # 4. clip top fill any stragglers
    for h in clip_top:
        if len(pool) >= N_COMPARE:
            break
        add(h)
    fam_brand = " ".join(dict.fromkeys(h["via"].split(":", 1)[1] for h in series))

    # Sort: series-picks (priority=0) win first, then dino top, by dino_sim
    # DESC. This guarantees M3 always sees the rescued series even if its
    # dino_sim is rank 75 — without this `[:N_COMPARE]` would drop them.
    series_sids = {h["skuId"] for h in series}
    pool_sorted = sorted(pool, key=lambda x: (1 if x["skuId"] not in series_sids else 0,
                                              -x["dino_sim"]))
    to_compare = pool_sorted[:N_COMPARE]
    # W1-2: the single strongest visual match must always reach M3. Text/series
    # rescue can otherwise crowd it out of a small pool: querying with the
    # 2501 金大益 reference itself, m3_text read only 「大益」, the bigram-IDF
    # tie resolved by jsonl file order (9505 sits last), and three wrong 大益
    # siblings filled all N_COMPARE slots while dino rank-1 (sim 1.0) stayed
    # outside — a real user photo of the 2025 reissue hits the same path.
    # Bounded cost: +1 parallel M3 call, only when rank-1 is not already in.
    # Roll back with VM_DINO_TOP1_GUARD=0.
    if _DINO_TOP1_GUARD and dino_top_sorted:
        _top1 = dino_top_sorted[0]
        if _top1["skuId"] not in {h["skuId"] for h in to_compare}:
            to_compare = to_compare + [_top1]

    # W1-3: recall-only early return — used by offline eval scorer. Same
    # return shape as the full path, but verdicts=None / best=None and m3_calls
    # contains the cost the FULL path WOULD have taken (the planned compare
    # fan-out), so REPORT.md can quote "would-have-been" M3 load too.
    if return_pool_only:
        return {"ok": True, "reason": None,
                "brand": fam_brand,
                "candidates": [{k: h[k] for k in ("skuId", "name",
                                                  "dino_sim", "clip_sim")}
                               for h in to_compare],
                "verdicts": None, "best": None,
                "trace": {"m3_calls": m3_diag,
                          "n_pool": len(pool_sorted),
                          "n_compared": len(to_compare),
                          "pool": [{"skuId": h.get("skuId"),
                                    "name": h.get("name"),
                                    "via": h.get("via", ""),
                                    "dino_sim": h.get("dino_sim"),
                                    "clip_sim": h.get("clip_sim")}
                                   for h in pool_sorted]}}

    def _one(h):
        ref = retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))
        with _CMP_SEM:
            _t = time.monotonic()
            v = _vlm_compare(image_path, ref)
        m3_diag.append({"stage": "compare", "skuId": h["skuId"],
                        "s": round(time.monotonic() - _t, 2)})
        if v:
            v.update({"skuId": h["skuId"], "name": h["name"],
                      "record": V["recs"].get(h["skuId"])})
        return v

    # W1-4: pairwise M3 in parallel — the serial loop was the latency root
    # cause (10 serial calls = 123.97s measured on 2026-08-21).
    with ThreadPoolExecutor(max_workers=_CMP_WORKERS) as _ex:
        verdicts = [v for v in _ex.map(_one, to_compare) if v]
    if not verdicts:
        verdicts = None

    best = None
    if verdicts:
        rank = {v: i for i, v in enumerate(VERDICTS)}
        best = sorted(verdicts, key=lambda x: (rank[x["verdict"]], -x["confidence"]))[0]

    return {"ok": True, "reason": None,
            "brand": fam_brand,
            "candidates": [{k: h[k] for k in ("skuId", "name", "dino_sim", "clip_sim")}
                           for h in to_compare],
            "verdicts": verdicts, "best": best,
            # W1-1: per-request diagnostics for rag_pipeline's TRACE line
            # (stripped there before the response leaves the container).
            "trace": {"m3_calls": m3_diag,
                      "n_pool": len(pool_sorted), "n_compared": len(to_compare),
                      "pool": [{"skuId": h.get("skuId"), "name": h.get("name"),
                                "via": h.get("via", ""), "dino_sim": h.get("dino_sim"),
                                "clip_sim": h.get("clip_sim")}
                               for h in pool_sorted]}}


if __name__ == "__main__":
    import sys
    img = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tianfu7262.jpg"
    ocr = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(compare(img, ocr), ensure_ascii=False, indent=2))
