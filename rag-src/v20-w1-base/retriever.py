#!/usr/bin/env python3
"""Reusable retrieval module over sku-clean + knowledge-chunks.

Extracted from retrieval_smoke.py with identical scoring; the only change is
lazy loading (data + idf tables built on first call, not at import) so this
module can be imported cheaply by the answer pipeline. retrieval_smoke.py now
imports from here — its printed output must stay byte-identical.

Public API:
  sku_lookup(query, topk)   -> [(score, sku_record)]
  bigram_search(query, topk)-> [(score, chunk)]
  embed_search(query, topk) -> [(cosine, chunk)]   (needs sentence-transformers)
  hybrid_search(query, topk)-> [{kind, score_b, score_e, record}]  unified entry
"""
import json
import math
import os
import re
import unicodedata

RAG = os.environ.get("RAG_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
SKU = f"{RAG}/sku-clean.jsonl"
CHUNKS = f"{RAG}/knowledge-chunks.jsonl"
DONGHE = f"{RAG}/donghe-skus.jsonl"   # 东和茶叶网 crawl (M7): live market prices
DONGHE_IMG = f"{RAG}/donghe-images"   # {skuId}.jpeg reference images

STOP = {"现在", "什么", "行情", "多少", "钱一", "一件", "请问", "怎么", "如何",
        "现在什", "在什么", "被称为"}


def nfkc(s):
    return unicodedata.normalize("NFKC", s) if s else s


def bigrams(s):
    s = re.sub(r"\s+", "", nfkc(s))
    return [s[i:i + 2] for i in range(len(s) - 1)]


# ---------- lazy-loaded corpus state (was module level in retrieval_smoke) ----------
_S = None


def _ensure_loaded():
    global _S
    if _S is not None:
        return _S
    sku = [json.loads(l) for l in open(SKU, encoding="utf-8")]
    chunks = []
    for l in open(CHUNKS, encoding="utf-8"):
        r = json.loads(l)
        r["text"] = nfkc(r["text"])
        r["source"] = nfkc(r["source"])
        chunks.append(r)

    chunk_bgs = [set(bigrams(c["text"][:2000])) for c in chunks]
    df = {}
    for bgs in chunk_bgs:
        for b in bgs:
            df[b] = df.get(b, 0) + 1
    N = len(chunks)
    idf = {b: math.log(1 + N / (1 + n)) for b, n in df.items()}

    sku_bgs = [set(bigrams(re.sub(r"\s+", "", nfkc(r["search_text"])))) for r in sku]
    sdf = {}
    for bgs in sku_bgs:
        for b in bgs:
            sdf[b] = sdf.get(b, 0) + 1
    NS = max(len(sku), 1)
    sku_idf = {b: math.log(1 + NS / (1 + n)) for b, n in sdf.items()}

    # donghe crawl: build search_text = name+year+unit, then idf
    donghe = []
    if os.path.exists(DONGHE):
        for l in open(DONGHE, encoding="utf-8"):
            r = json.loads(l)
            yr = re.sub(r"\D", "", str(r.get("year") or ""))
            r["search_text"] = f"{nfkc(r.get('name') or '')} {yr} {r.get('unit') or ''}"
            donghe.append(r)
    donghe_bgs = [set(bigrams(re.sub(r"\s+", "", r["search_text"]))) for r in donghe]
    ddf = {}
    for bgs in donghe_bgs:
        for b in bgs:
            ddf[b] = ddf.get(b, 0) + 1
    ND = max(len(donghe), 1)
    donghe_idf = {b: math.log(1 + ND / (1 + n)) for b, n in ddf.items()}

    _S = {"sku": sku, "chunks": chunks, "chunk_bgs": chunk_bgs,
          "idf": idf, "sku_idf": sku_idf,
          "donghe": donghe, "donghe_idf": donghe_idf}
    return _S


# ---------- A) SKU lookup (idf-weighted char-bigram + year bonus) ----------
def sku_lookup(query, topk=5):
    S = _ensure_loaded()
    q = re.sub(r"\s+", "", nfkc(query))
    for w in STOP:
        q = q.replace(w, "")
    qb = set(bigrams(q))
    y4 = re.findall(r"(?:19|20)\d{2}", query)
    y2 = re.findall(r"(?<!\d)\d{2}(?!\d)", query)
    want_years = {int(y) for y in y4} | {int(y[-2:]) for y in y2}
    scored = []
    for r in S["sku"]:
        hay = re.sub(r"\s+", "", nfkc(r["search_text"]))
        hb = set(bigrams(hay))
        inter = qb & hb
        if not inter:
            continue
        s = sum(S["sku_idf"].get(b, 0) for b in inter)
        if want_years and r["year"] in want_years:
            s *= 1.5  # year disambiguates e.g. 03 vs 04 四星孔雀
        scored.append((s, r))
    scored.sort(key=lambda x: -x[0])
    return scored[:topk]


# ---------- A2) Donghe live-market lookup (same scorer, bigger catalog) ----------
def donghe_lookup(query, topk=5):
    S = _ensure_loaded()
    q = re.sub(r"\s+", "", nfkc(query))
    for w in STOP:
        q = q.replace(w, "")
    qb = set(bigrams(q))
    y4 = re.findall(r"(?:19|20)\d{2}", query)
    y2 = re.findall(r"(?<!\d)\d{2}(?!\d)", query)
    want_years = {int(y) for y in y4} | {int(y[-2:]) for y in y2}
    scored = []
    for r in S["donghe"]:
        hay = re.sub(r"\s+", "", r["search_text"])
        hb = set(bigrams(hay))
        inter = qb & hb
        if not inter:
            continue
        s = sum(S["donghe_idf"].get(b, 0) for b in inter)
        ry = re.sub(r"\D", "", str(r.get("year") or ""))
        if want_years and ry.isdigit() and int(ry) in want_years:
            s *= 1.5
        scored.append((s, r))
    scored.sort(key=lambda x: -x[0])
    return scored[:topk]


def donghe_img_path(rec):
    """Local reference image for a donghe record (may not exist yet)."""
    return f"{DONGHE_IMG}/{rec['skuId']}.jpeg"


def donghe_lookup_fuzzy(query, topk=6):
    """OCR-tolerant donghe lookup: try exact donghe_lookup first, fall back to
    1-char edit / prefix overlap against name. Returns score-record pairs;
    caps at topk. Empty if nothing matches.

    Used when OCR has dropped/struck a character (e.g. 「越陳越香」→「陳越香」)
    — the exact query returns 0 but the fuzzy path surfaces 越陈越香 series so
    the LLM can still produce a 「疑似匹配」 line."""
    hits = donghe_lookup(query, topk=topk)
    if hits:
        return hits
    q = re.sub(r"\s+", "", nfkc(query))
    if len(q) < 3:
        return hits
    fuzzy = []
    for r in _ensure_loaded()["donghe"]:
        n = re.sub(r"\s+", "", r.get("name", ""))
        if not n:
            continue
        # prefix overlap: 4-char rolling window — "陳越香" should hit "越陳越香"
        for i in range(len(n) - 3):
            if n[i:i + 4] in q or q[:4] in n:
                fuzzy.append((2.0, r))
                break
        # 1-char edit distance tolerance
        if len(n) == len(q) and sum(1 for a, b in zip(n, q) if a != b) == 1:
            fuzzy.append((1.5, r))
    # dedup by skuId preserving max score
    by_id = {}
    for s, r in fuzzy:
        sid = r.get("skuId")
        if sid not in by_id or s > by_id[sid][0]:
            by_id[sid] = (s, r)
    out = list(by_id.values())
    out.sort(key=lambda x: -x[0])
    return out[:topk]


# ---------- B) knowledge search ----------
def bigram_search(query, topk=5):
    S = _ensure_loaded()
    qb = set(bigrams(query))
    scored = []
    for i, bgs in enumerate(S["chunk_bgs"]):
        inter = qb & bgs
        if inter:
            s = sum(S["idf"].get(b, 0) for b in inter) / (1 + math.log(1 + len(bgs)))
            scored.append((s, i))
    scored.sort(key=lambda x: -x[0])
    return [(s, S["chunks"][i]) for s, i in scored[:topk]]


_embed = None


def embed_search(query, topk=5):
    global _embed
    from sentence_transformers import SentenceTransformer  # noqa: F401
    import numpy as np
    S = _ensure_loaded()
    if _embed is None:
        _embed = SentenceTransformer("BAAI/bge-small-zh-v1.5")
    cache = f"{RAG}/chunk-emb.npy"
    texts = [c["text"][:800] for c in S["chunks"]]
    key = f"{RAG}/chunk-emb.key"
    cur_key = f"{len(texts)}:{sum(len(t) for t in texts[-3:])}"
    if os.path.exists(cache) and os.path.exists(key) and open(key).read() == cur_key:
        mat = np.load(cache)
    else:
        mat = _embed.encode(texts, normalize_embeddings=True, show_progress_bar=True)
        np.save(cache, np.asarray(mat))
        open(key, "w").write(cur_key)
    qv = _embed.encode([query], normalize_embeddings=True)
    sims = (mat @ qv.T).ravel()
    idx = sims.argsort()[::-1][:topk]
    return [(float(sims[i]), S["chunks"][i]) for i in idx]


def price_str(r):
    for f in ("market_price_per_jian", "market_price", "estimate", "buyback_price"):
        if r.get(f):
            return f"{f}={r[f]}"
    return f"克价={r.get('price_per_g', '?')}"


# ---------- C) unified entry for the answer pipeline ----------
def hybrid_search(query, topk=9, use_embed=True):
    """SKU(xlsx) top-3 + Donghe(live market) top-3 + knowledge top-(topk-6).
    Knowledge merged embed-first then bigram-only (different scales, so embed
    hits rank above bigram-only hits; within each group, own scale descending).
    Degrades to bigram-only when sentence-transformers is unavailable.
    Returns (hits, embed_ok) where hits is
    [{kind:'sku'|'donghe'|'knowledge', score_b, score_e, record}, ...]."""
    hits = [{"kind": "sku", "score_b": s, "score_e": None, "record": r}
            for s, r in sku_lookup(query, 3)]
    hits += [{"kind": "donghe", "score_b": s, "score_e": None, "record": r}
             for s, r in donghe_lookup(query, 3)]
    merged = {}  # chunk text prefix -> entry (chunk dicts are unique objects,
    # but identity is unstable across calls, so key on content)
    for s, c in bigram_search(query, topk):
        merged[c["source"] + "|" + c["pages"] + "|" + c["text"][:60]] = \
            {"kind": "knowledge", "score_b": s, "score_e": None, "record": c}
    embed_ok = False
    if use_embed:
        try:
            for s, c in embed_search(query, topk):
                k = c["source"] + "|" + c["pages"] + "|" + c["text"][:60]
                if k in merged:
                    merged[k]["score_e"] = s
                else:
                    merged[k] = {"kind": "knowledge", "score_b": None, "score_e": s, "record": c}
            embed_ok = True
        except Exception:
            pass  # degrade silently; caller can detect via flag below
    def kn_rank(e):
        return (0 if e["score_e"] is not None else 1, -(e["score_e"] or e["score_b"] or 0))
    knowledge = sorted(merged.values(), key=kn_rank)[:max(topk - 6, 3)]
    return hits + knowledge, embed_ok
