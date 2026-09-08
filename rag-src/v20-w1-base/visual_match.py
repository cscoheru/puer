# W3 HEIC: register pillow-heif opéner (idempotent; server.py also calls it)
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

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
import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import teacher_api


# ===== B2: Notes-Verdict consistency rule =====
# Demotes same_product to same_series_variant when notes contain temporal/
# variant cues (新版/老版/变体/不同年份/跨年份/复刻 etc.).
# This catches M3 verdicts that are technically correct for the series but
# expose a version gap the confidence score alone cannot reflect.
_B2_ENABLED = os.environ.get("B2_DEMOTE_NOTES", "1") != "0"   # default ON
_DEMOTE_NOTES = re.compile(
    r"变体|新版|老版|不同年份|版式.{0,4}差异|跨年份|复刻")


def _apply_b2_demote(verdict, confidence, notes):
    if not _B2_ENABLED:
        return verdict, confidence
    if verdict == "same_product" and notes and _DEMOTE_NOTES.search(notes):
        return "same_series_variant", round(float(confidence) * 0.6, 2)
    return verdict, confidence


def _self_test_b2_demote():
    v1, c1 = _apply_b2_demote("same_product", 0.95, "新版包装变体")
    assert v1 == "same_series_variant" and abs(c1 - 0.57) < 1e-6, repr((v1, c1))
    v2, c2 = _apply_b2_demote("same_product", 0.90, "同款同批")
    assert v2 == "same_product" and c2 == 0.90, repr((v2, c2))
    v3, c3 = _apply_b2_demote("same_series_variant", 0.85, "变体")
    assert v3 == "same_series_variant" and c3 == 0.85, repr((v3, c3))
    print("[self-test b2-demote] 3/3 PASS")


# ===== E2: sibling-aware best bias (Cursor 10:10; offline draft) =====
# When the best candidate is a non-sibling entry monopolizing same_product
# with dino_sim below the floor, promote the strongest sibling-injected
# candidate (verdict in same_product/same_series_variant). The floor
# preserves near-identical-image matches. Env-gated at the CALL SITE
# (default OFF) -- the function itself is pure and env-free.
_E2_SIBLING_BIAS = os.environ.get("E2_SIBLING_BIAS", "0") == "1"
_E2_SELF_SIM_FLOOR = float(os.environ.get("E2_SELF_SIM_FLOOR", "0.95"))


def _apply_e2_sibling_bias(best, verdicts, rank, floor=None):
    if floor is None:
        floor = _E2_SELF_SIM_FLOOR
    if not best or best.get("verdict") != "same_product":
        return best
    if "sibling:" in str(best.get("via", "")):
        return best
    try:
        self_sim = float(best.get("dino_sim") or 0.0)
    except (TypeError, ValueError):
        self_sim = 0.0
    if self_sim >= floor:
        return best
    sibs = [v for v in (verdicts or [])
            if "sibling:" in str(v.get("via", ""))
            and v.get("verdict") in ("same_product", "same_series_variant")
            and str(v.get("skuId")) != str(best.get("skuId"))]
    if not sibs:
        return best
    pick = sorted(sibs, key=lambda x: (rank[x["verdict"]], -x["confidence"]))[0]
    pick = dict(pick)
    pick["_e2_promoted"] = True
    pick["_e2_from"] = best.get("skuId")
    return pick


def _self_test_e2_bias():
    rank = {v: i for i, v in enumerate(VERDICTS)}
    self_sp = {"skuId": "A", "verdict": "same_product", "confidence": 0.97,
               "via": "dino", "dino_sim": 0.90}
    sib_ssv = {"skuId": "B", "verdict": "same_series_variant", "confidence": 0.85,
               "via": "sibling:anchor_x", "dino_sim": 0.88}
    # case 1: sibling ssv beats low-sim self same_product
    r1 = _apply_e2_sibling_bias(dict(self_sp), [self_sp, sib_ssv], rank)
    assert r1["skuId"] == "B" and r1.get("_e2_promoted"), repr(r1)
    # case 2: carve-out -- self dino_sim >= floor keeps monopoly
    hi = dict(self_sp); hi["dino_sim"] = 0.97
    r2 = _apply_e2_sibling_bias(hi, [hi, sib_ssv], rank)
    assert r2["skuId"] == "A" and not r2.get("_e2_promoted"), repr(r2)
    # case 3: no sibling candidate -> unchanged
    r3 = _apply_e2_sibling_bias(dict(self_sp), [self_sp], rank)
    assert r3["skuId"] == "A" and not r3.get("_e2_promoted"), repr(r3)
    # case 4: best already demoted to ssv (E1 applied) -> E2 skips
    dem = dict(self_sp); dem["verdict"] = "same_series_variant"
    r4 = _apply_e2_sibling_bias(dem, [dem, sib_ssv], rank)
    assert r4["skuId"] == "A" and not r4.get("_e2_promoted"), repr(r4)
    # case 5: sibling same_product outranks sibling ssv when both present
    sib_sp = {"skuId": "C", "verdict": "same_product", "confidence": 0.80,
              "via": "sibling:anchor_x", "dino_sim": 0.86}
    r5 = _apply_e2_sibling_bias(dict(self_sp), [self_sp, sib_ssv, sib_sp], rank)
    assert r5["skuId"] == "C", repr(r5)
    print("[self-test e2-bias] 5/5 PASS")

# ===== B3 W5-1: sibling inject =====
import json as _json_b3
from pathlib import Path as _Path_b3

_SIBLING_INJECT = os.environ.get("SIBLING_INJECT", "0") == "1"
_SIBLING_INJECT_MAX = int(os.environ.get("SIBLING_INJECT_MAX", "3"))  # B3-v2: 2->3
_DINO_TRIGGER = float(os.environ.get("DINO_TRIGGER", "0.55"))  # B3-v2: master SKU sim trigger
# F1: a sibling may evict the WEAKEST SERIES-RESCUE pool entry only when its
# own dino_sim reaches this floor. Pure dino/clip fill slots are always
# evictable. The floor stops a near-random sibling from displacing a
# text-confirmed series member it is visually far from.
_SIBLING_EVICT_FLOOR = float(os.environ.get("SIBLING_EVICT_FLOOR", "0.40"))
_SIBLING_INDEX_CACHE = {"mtime": None, "data": None}
_SIBLING_INDEX_PATH = next(
    (p for p in (
        os.environ.get("RAG_SIBLING_INDEX"),
        "/data/donghe-skus.jsonl",
        "/opt/puer-hub/rag-data/donghe-skus.jsonl",
    ) if p and os.path.exists(p)),
    "/opt/puer-hub/rag-data/donghe-skus.jsonl",
)


def _build_sibling_index():
    """Build {anchor_pattern_str: [skuId, ...]} from donghe-skus.jsonl.
    Cache by file mtime. Skip dedup index (raw skuId per B+A+C strategy).
    Returns dict[str, list[str]]; only anchors with ≥2 distinct skuIds.
    """
    if not _SIBLING_INJECT:
        return {}
    try:
        path = _Path_b3(_SIBLING_INDEX_PATH)
        mtime = path.stat().st_mtime
        if _SIBLING_INDEX_CACHE["mtime"] == mtime:
            return _SIBLING_INDEX_CACHE["data"]
    except Exception:
        return {}

    try:
        import hard_neg_rules
        patterns = hard_neg_rules.DEFAULT_PATTERNS  # list[str]
    except Exception:
        return {}

    compiled = [(p, re.compile(p)) for p in patterns]
    index = {}
    try:
        with open(_SIBLING_INDEX_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = _json_b3.loads(line)
                except Exception:
                    continue
                name = r.get("name") or ""
                sid = str(r.get("skuId") or "")
                if not sid or not name:
                    continue
                for pat_str, pat_re in compiled:
                    if pat_re.search(name):
                        index.setdefault(pat_str, []).append(sid)
                        break  # first anchor wins
    except Exception:
        return {}

    # Filter: only keep anchors with ≥2 distinct skuIds
    index = {k: list(set(v)) for k, v in index.items() if len(set(v)) >= 2}
    _SIBLING_INDEX_CACHE["mtime"] = mtime
    _SIBLING_INDEX_CACHE["data"] = index
    return index


def _detect_active_anchors(ocr_text, V, pool=None):
    """Return list of pattern_str that match ocr_text, brand_names,
    OR pool entries' m3_text:/series picks with dino_sim >= _DINO_TRIGGER.

    B3-v2: master-SKU DINO sim trigger bypasses OCR 漏字 (越陈越香 OCR
    常缺失; 但 m3_text:越陈越香 pick 命中 + dino_sim>=0.55 即可触发)。
    """
    try:
        import hard_neg_rules
        patterns = hard_neg_rules.DEFAULT_PATTERNS
    except Exception:
        return []
    compiled = [(p, re.compile(p)) for p in patterns]
    ocr = ocr_text or ""
    brand_names = " ".join((V.get("brand_names") or []))
    haystack = ocr + " " + brand_names
    active = []
    seen = set()
    for pat_str, pat_re in compiled:
        if pat_re.search(haystack):
            active.append(pat_str); seen.add(pat_str)
    # B3-v2: pool-driven anchor activation (master SKU sim >= DINO_TRIGGER)
    if pool is not None and _DINO_TRIGGER > 0:
        for h in pool:
            via = str(h.get("via", ""))
            if not (via.startswith("m3_text:") or via == "series"):
                continue
            d = float(h.get("dino_sim", 0.0))
            if d < _DINO_TRIGGER:
                continue
            name = h.get("name") or ""
            for pat_str, pat_re in compiled:
                if pat_re.search(name) and pat_str not in seen:
                    active.append(pat_str); seen.add(pat_str)
    return active


_SERIES_VIAS = ("m3_text:", "anchor:", "ocr_fuzzy:", "ocr_token:", "sibling:")


def _inject_siblings(pool, used, active_anchors, V, dsims, csims, skuId_to_row):
    """F1: inject sibling rows (via=sibling:{anchor}) into the compare pool.

    B3-v2 produced ZERO injects exactly where they were needed most
    (anchor-pair cases). Three root causes are fixed here:

    1. Fill-slot starvation: series-rescue fills all N_COMPARE pool slots
       with m3_text: entries, but the old code only allowed replacing
       non-m3_text "fill" slots -> empty victim list -> inject 0. F1
       reserves sibling slots: pure dino/clip fill is evicted first
       (lowest dino_sim first); when no fill remains, the weakest
       series-rescue entry yields its slot — gated by the sibling's
       dino_sim >= _SIBLING_EVICT_FLOOR.
    2. Membership dedup: the old code compared int rows against a set of
       skuId strings (never matched). F1 computes membership from the pool
       itself — rows AND all skuIds sharing a row — so a sibling already
       pulled in by series-rescue is never injected twice.
    3. Similarity axis: the old code indexed dsims/csims by skuId VALUE
       instead of row position, and read V["names"] which does not exist.
       F1 looks up sims via V["pos"] and names via V["recs"].

    N_COMPARE is NOT expanded — injection is a slot replacement.
    Returns (pool, used, inject_count, inject_via_map).
    """
    if not _SIBLING_INJECT or not active_anchors:
        return pool, used, 0, {}
    index = _build_sibling_index()
    if not index:
        return pool, used, 0, {}

    pos = V.get("pos") or {}
    recs = V.get("recs") or {}
    row_to_skuIds = V.get("row_to_skuIds", {}) or {}

    # F1 fix 2: pool-aware membership (rows + all skuIds sharing a row)
    pooled_rows = set()
    pooled_sids = set()
    for h in pool:
        if h.get("idx") is not None:
            pooled_rows.add(h.get("idx"))
        for s in (h.get("skuIds") or [h.get("skuId")]):
            pooled_sids.add(str(s))

    def _sim_of_sid(sid):
        i = pos.get(str(sid))
        if i is None:
            return 0.0, 0.0
        return float(dsims[i]), float(csims[i])

    # F1b: per-anchor grouping (F1 dedup preserved). Each active anchor
    # gets its own ranked candidate list, sorted by TRUE dino_sim.
    per_anchor_candidates = {}
    for anchor in active_anchors:
        cands = []
        for sid in index.get(anchor, []):
            row = skuId_to_row.get(sid, sid)  # v1 fallback: row=sid
            try:
                row_i = int(row)
            except Exception:
                continue
            if row_i in pooled_rows or str(sid) in pooled_sids:
                continue  # already pooled (series-rescue)
            d_sim, c_sim = _sim_of_sid(sid)
            cands.append((row_i, sid, d_sim, c_sim))
        cands.sort(key=lambda x: -x[2])  # by dino_sim desc
        per_anchor_candidates[anchor] = cands

    # F1b: round-robin pick — 1 from each active anchor FIRST, then fill
    # remaining budget with the next-best from any anchor. This ensures
    # 003/062-style cases where 越陈越香 AND 八角亭 are both active get at
    # least one sibling per anchor (not just the highest-dino anchor's
    # top siblings taking all 3 slots).
    ranked = []
    if per_anchor_candidates:
        round_i = 0
        while len(ranked) < _SIBLING_INJECT_MAX:
            added_this_round = 0
            for anchor in active_anchors:
                if len(ranked) >= _SIBLING_INJECT_MAX:
                    break
                lst = per_anchor_candidates.get(anchor, [])
                if round_i < len(lst):
                    row_i, sid, _d, _c = lst[round_i]
                    ranked.append((row_i, anchor, sid))
                    added_this_round += 1
            if added_this_round == 0:
                break
            round_i += 1

    # F1 fix 1: reserved-slot victims across the WHOLE pool. Pure fill
    # (non-series via) evicts first, lowest dino_sim first; the weakest
    # series-rescue entry is evictable only above the floor.
    fill_victims = [(i, h) for i, h in enumerate(pool)
                    if not str(h.get("via", "")).startswith(_SERIES_VIAS)]
    fill_victims.sort(key=lambda kv: float(kv[1].get("dino_sim") or 0.0))
    series_victims = [(i, h) for i, h in enumerate(pool)
                      if str(h.get("via", "")).startswith(_SERIES_VIAS)]
    series_victims.sort(key=lambda kv: float(kv[1].get("dino_sim") or 0.0))

    import retriever

    inject_count = 0
    inject_via_map = {}
    for row_i, anchor, sid in ranked:
        d_sim, c_sim = _sim_of_sid(sid)
        if fill_victims:
            idx_in_pool, _old = fill_victims.pop(0)
        elif series_victims and d_sim >= _SIBLING_EVICT_FLOOR:
            idx_in_pool, _old = series_victims.pop(0)
        else:
            continue
        rec = recs.get(str(sid), {}) or {}
        if not os.path.exists(
                retriever.donghe_img_path(rec or {"skuId": str(sid)})):
            continue  # no reference image on disk -> M3 cannot compare it
        skuIds = [str(s) for s in row_to_skuIds.get(row_i, [sid])]
        pool[idx_in_pool] = {
            "skuId": str(sid),
            "skuIds": skuIds,
            "name": rec.get("name") or str(sid),
            "dino_sim": round(d_sim, 4),
            "clip_sim": round(c_sim, 4),
            "idx": row_i,
            "via": f"sibling:{anchor}",
            "tea_type": rec.get("tea_type") or "unknown",
        }
        used.add(row_i)
        pooled_rows.add(row_i)
        pooled_sids.update(skuIds)
        inject_via_map[row_i] = anchor
        inject_count += 1

    return pool, used, inject_count, inject_via_map



def _expand_pool_series(pool, used, V, dsims, csims, skuId_to_row, index,
                        max_extra=1):
    """F1b intra-pool chain: rescue 019/020-style cases.

    When m3_text fills all N_COMPARE slots (no OCR/anchor trigger), the
    pool members may already BE series members (e.g. 大益 series) but
    _inject_siblings is not invoked. This pass scans the pool, detects
    series membership via the reverse index, and injects up to max_extra
    OTHER series members — replacing the weakest fill victim (or the
    weakest series entry, gated by floor).

    Different from F1's sibling inject:
      - F1 injects from OCR-detected ACTIVE ANCHORS
      - This pass injects from anchors ALREADY REPRESENTED in the pool
    """
    if not index or not pool or max_extra <= 0:
        return pool, used, 0
    pos = V.get("pos") or {}
    recs = V.get("recs") or {}
    row_to_skuIds = V.get("row_to_skuIds", {}) or {}

    # Build reverse index: skuId -> [anchor]
    rev = {}
    for anchor, sids in index.items():
        for sid in sids:
            rev.setdefault(str(sid), []).append(anchor)

    # Pool state
    pooled_rows = set()
    pooled_sids = set()
    for h in pool:
        if h.get("idx") is not None:
            pooled_rows.add(h.get("idx"))
        for s in (h.get("skuIds") or [h.get("skuId")]):
            pooled_sids.add(str(s))

    def _sim_of_sid(sid):
        i = pos.get(str(sid))
        if i is None:
            return 0.0, 0.0
        return float(dsims[i]), float(csims[i])

    # Anchors represented in pool
    anchors_in_pool = set()
    for h in pool:
        sid = str(h.get("skuId", ""))
        for a in rev.get(sid, []):
            anchors_in_pool.add(a)
    if not anchors_in_pool:
        return pool, used, 0

    # Find missing siblings
    candidates = []
    for anchor in anchors_in_pool:
        for sid in index.get(anchor, []):
            row = skuId_to_row.get(sid, sid)
            try:
                row_i = int(row)
            except Exception:
                continue
            if row_i in pooled_rows or str(sid) in pooled_sids:
                continue
            d_sim, c_sim = _sim_of_sid(sid)
            if d_sim < _SIBLING_EVICT_FLOOR:
                continue  # F1 floor applies here too
            candidates.append((row_i, anchor, sid, d_sim, c_sim))
    candidates.sort(key=lambda x: -x[3])
    candidates = candidates[:max_extra]

    # Victims (same logic as _inject_siblings)
    fill_victims = [(i, h) for i, h in enumerate(pool)
                    if not str(h.get("via", "")).startswith(_SERIES_VIAS)]
    fill_victims.sort(key=lambda kv: float(kv[1].get("dino_sim") or 0.0))
    series_victims = [(i, h) for i, h in enumerate(pool)
                      if str(h.get("via", "")).startswith(_SERIES_VIAS)]
    series_victims.sort(key=lambda kv: float(kv[1].get("dino_sim") or 0.0))

    import retriever
    extra_count = 0
    for row_i, anchor, sid, d_sim, c_sim in candidates:
        if fill_victims:
            idx_in_pool, _old = fill_victims.pop(0)
        elif series_victims and d_sim >= _SIBLING_EVICT_FLOOR:
            idx_in_pool, _old = series_victims.pop(0)
        else:
            continue
        rec = recs.get(str(sid), {}) or {}
        if not os.path.exists(
                retriever.donghe_img_path(rec or {"skuId": str(sid)})):
            continue
        skuIds = [str(s) for s in row_to_skuIds.get(row_i, [sid])]
        pool[idx_in_pool] = {
            "skuId": str(sid),
            "skuIds": skuIds,
            "name": rec.get("name") or str(sid),
            "dino_sim": round(d_sim, 4),
            "clip_sim": round(c_sim, 4),
            "idx": row_i,
            "via": f"sibling_intra:{anchor}",
            "tea_type": rec.get("tea_type") or "unknown",
        }
        used.add(row_i)
        pooled_rows.add(row_i)
        pooled_sids.update(skuIds)
        extra_count += 1
    return pool, used, extra_count
def _self_test_sibling_inject():
    """3 cases: 八角亭 dedup, 越陈越香 multi, empty anchors."""
    # Monkeypatch retriever.donghe_img_path to /dev/null so all 8 cases
    # pass without needing on-disk reference images for synthetic skus.
    import retriever as _ret_st
    _orig_img_path = _ret_st.donghe_img_path
    _ret_st.donghe_img_path = lambda rec: "/dev/null"
    try:

        # case 1: 八角亭 active, pool has 八角亭 4605 -> inject siblings 5878/5666/6712
        pool = [
            {"skuId": "4605", "skuIds": ["4605"], "name": "八角亭 4605", "dino_sim": 0.95,
             "clip_sim": 0.93, "idx": 100, "via": "m3_text:八角亭"},
            {"skuId": "9999", "skuIds": ["9999"], "name": "无关 SKU", "dino_sim": 0.40,
             "clip_sim": 0.50, "idx": 999, "via": "dino"},
        ]
        used = {100, 999}
        V = {
            "row_to_skuIds": {100: ["4605"], 200: ["5878"], 201: ["5666"], 202: ["6712"]},
            "names": ["八角亭 4605", "八角亭 5878", "八角亭 5666", "八角亭 6712"],
        }
        import numpy as _np
        dsims = _np.zeros(7000); csims = _np.zeros(7000)
        dsims[4605] = 0.95; csims[4605] = 0.93
        dsims[5878] = 0.45; csims[5878] = 0.50
        dsims[5666] = 0.42; csims[5666] = 0.48
        dsims[6712] = 0.40; csims[6712] = 0.46
        skuId_to_row = {"4605": 100, "5878": 200, "5666": 201, "6712": 202}
        new_pool, new_used, n_inj, _ = _inject_siblings(
            list(pool), set(used), ["八角亭"], V, dsims, csims, skuId_to_row,
        )
        assert n_inj >= 1, f"case1 expect ≥1 inject, got {n_inj}"
        injected = [h for h in new_pool if str(h.get("via", "")).startswith("sibling:")]
        assert len(injected) >= 1
        assert all(inj["via"].startswith("sibling:八角亭") for inj in injected)
        print(f"[self-test b3-sibling] case1 八角亭 inject={n_inj} OK")

        # case 2: 越陈越香 active
        pool2 = [{"skuId": "1668", "skuIds": ["1668"], "name": "越陈越香 1668",
                  "dino_sim": 0.85, "clip_sim": 0.80, "idx": 50, "via": "dino"}]
        used2 = {50}
        V2 = {"row_to_skuIds": {50: ["1668"], 51: ["1657"], 52: ["1705"]},
              "names": ["越陈越香 1668", "越陈越香 1657", "越陈越香 1705"]}
        skuId_to_row2 = {"1668": 50, "1657": 51, "1705": 52}
        new_pool2, _, n_inj2, _ = _inject_siblings(
            pool2, used2, ["越陈越香"], V2, dsims, csims, skuId_to_row2,
        )
        assert n_inj2 >= 1, f"case2 expect ≥1 inject, got {n_inj2}"
        print(f"[self-test b3-sibling] case2 越陈越香 inject={n_inj2} OK")

        # case 3: empty active_anchors → no inject
        pool3 = list(pool); used3 = set(used)
        new_pool3, new_used3, n_inj3, _ = _inject_siblings(
            pool3, used3, [], V, dsims, csims, skuId_to_row,
        )
        assert n_inj3 == 0
        assert pool3 == new_pool3
        print("[self-test b3-sibling] case3 empty anchors inject=0 OK")

            # case 4 (B3-v2): pool contains m3_text:越陈越香 with dino_sim 0.60,
        # no OCR/brand mention. active_anchors should detect 越陈越香 via DINO_TRIGGER.
        pool4 = [{"skuId": "1668", "skuIds": ["1668"], "name": "越陈越香 1668",
                  "dino_sim": 0.60, "clip_sim": 0.55, "idx": 50,
                  "via": "m3_text:越陈越香"}]
        used4 = {50}
        V4 = {"row_to_skuIds": {50: ["1668"], 51: ["1657"], 52: ["1705"]},
              "names": ["越陈越香 1668", "越陈越香 1657", "越陈越香 1705"]}
        skuId_to_row4 = {"1668": 50, "1657": 51, "1705": 52}
        active_v2 = _detect_active_anchors("", V4, pool=pool4)
        assert "越陈越香" in active_v2, (
            f"case4 expect 越陈越香 in active via pool+sim trigger, got {active_v2}")
        print(f"[self-test b3-v2] case4 pool+sim trigger active={active_v2} OK")

        # case 5 (B3-v2): same as case4 but dino_sim below threshold -> not triggered
        pool5 = [{"skuId": "1668", "skuIds": ["1668"], "name": "越陈越香 1668",
                  "dino_sim": 0.30, "clip_sim": 0.40, "idx": 50,
                  "via": "m3_text:越陈越香"}]
        active_low = _detect_active_anchors("", V4, pool=pool5)
        assert "越陈越香" not in active_low, (
            f"case5 expect low-sim not trigger, got {active_low}")
        print(f"[self-test b3-v2] case5 low-sim not trigger active={active_low} OK")

    # ---- F1 cases: reserved sibling slot ----
        pos6 = {"1668": 50, "1657": 51, "1933": 52, "1705": 60}
        V6 = {"row_to_skuIds": {50: ["1668"], 51: ["1657"], 52: ["1933"],
                                60: ["1705"]},
              "pos": pos6,
              "recs": {s: {"name": f"越陈越香 {s}"} for s in pos6}}
        dsims6 = _np.zeros(200); csims6 = _np.zeros(200)
        for sid, sim in (("1668", 0.90), ("1657", 0.70), ("1933", 0.55),
                         ("1705", 0.62)):
            dsims6[pos6[sid]] = sim; csims6[pos6[sid]] = sim - 0.05
        s2r6 = {s: pos6[s] for s in pos6}

        # case 6 (F1): ALL-m3_text pool (B3-v2's blind spot) — the weakest
        # series entry (1933, sim 0.55) is evicted for sibling 1705.
        pool6 = [
            {"skuId": "1668", "skuIds": ["1668"], "name": "越陈越香 1668",
             "dino_sim": 0.90, "clip_sim": 0.85, "idx": 50,
             "via": "m3_text:越陈越香"},
            {"skuId": "1657", "skuIds": ["1657"], "name": "越陈越香 1657",
             "dino_sim": 0.70, "clip_sim": 0.65, "idx": 51,
             "via": "m3_text:越陈越香"},
            {"skuId": "1933", "skuIds": ["1933"], "name": "越陈越香 1933",
             "dino_sim": 0.55, "clip_sim": 0.50, "idx": 52,
             "via": "m3_text:越陈越香"},
        ]
        # only 1705 is index-hit-able: restrict the index via monkeypatch
        _orig_build = globals()["_build_sibling_index"]
        globals()["_build_sibling_index"] = lambda: {"越陈越香": ["1705"]}
        try:
            new_pool6, _, n_inj6, _ = _inject_siblings(
                list(pool6), set(), ["越陈越香"], V6, dsims6, csims6, s2r6)
        finally:
            globals()["_build_sibling_index"] = _orig_build
        assert n_inj6 == 1, f"case6 expect 1 inject, got {n_inj6}"
        sib6 = [h for h in new_pool6 if str(h.get("via", "")).startswith("sibling:")]
        assert len(sib6) == 1 and sib6[0]["skuId"] == "1705", repr(new_pool6)
        evicted = {h["skuId"] for h in pool6} - {h["skuId"] for h in new_pool6}
        assert evicted == {"1933"}, f"case6 weakest must be evicted, got {evicted}"
        assert len(new_pool6) == 3  # slot replacement, N_COMPARE unchanged
        print("[self-test f1] case6 all-m3_text pool: weakest evicted, "
              "sibling:1705 in, pool size unchanged OK")

        # case 7 (F1): dedup — a sibling already pulled in by series-rescue
        # (1933 ∈ pool via m3_text) MUST NOT be injected again. The index
        # also offers 1705 which is NOT in the pool; inject should add 1705
        # and evict the weakest series entry. Final pool: no skuId appears
        # twice; 1705 lands; 1933 is consumed by 1705 (eviction, not dup).
        globals()["_build_sibling_index"] = lambda: {"越陈越香": ["1933", "1705"]}
        try:
            new_pool7, _, n_inj7, _ = _inject_siblings(
                list(pool6), set(), ["越陈越香"], V6, dsims6, csims6, s2r6)
        finally:
            globals()["_build_sibling_index"] = _orig_build
        assert n_inj7 == 1, f"case7 expect 1705 injected, got {n_inj7}"
        sids7 = [h["skuId"] for h in new_pool7]
        assert len(sids7) == len(set(sids7)), f"case7 duplicate skuId: {sids7}"
        assert "1705" in sids7 and sids7.count("1705") == 1, (
            f"case7 1705 must land once: {sids7}")
        assert sids7.count("1933") == 0, (
            f"case7 expected 1933 evicted by 1705, got {sids7}")
        print("[self-test f1] case7 dedup: pooled sibling not re-injected, "
              "no duplicates, 1705 lands OK")

        # case 8 (F1): floor — sibling below SIBLING_EVICT_FLOOR cannot evict
        # a series entry (only 1668/1657/1933 in pool; candidate sim 0.10).
        dsims8 = _np.zeros(200); csims8 = _np.zeros(200)
        pos8 = dict(pos6); pos8["9999"] = 99
        dsims8[99] = 0.10; csims8[99] = 0.10
        V8 = dict(V6); V8["pos"] = pos8
        V8["recs"] = {**V6["recs"], "9999": {"name": "越陈越香 9999"}}
        globals()["_build_sibling_index"] = lambda: {"越陈越香": ["9999"]}
        try:
            _, _, n_inj8, _ = _inject_siblings(
                list(pool6), set(), ["越陈越香"], V8, dsims8, csims8,
                {**s2r6, "9999": 99})
        finally:
            globals()["_build_sibling_index"] = _orig_build
        assert n_inj8 == 0, f"case8 expect floor block, got {n_inj8}"
        print("[self-test f1] case8 floor: low-sim sibling blocked OK")
    finally:
        _ret_st.donghe_img_path = _orig_img_path

    # ---- F1b cases: per-anchor fair allocation + intra-pool chain ----
    import retriever as _ret_st2
    _orig2 = _ret_st2.donghe_img_path
    _ret_st2.donghe_img_path = lambda rec: "/dev/null"
    try:

        # case 9 (F1b): per-anchor fair allocation — two active anchors
        # (越陈越香 + 八角亭). F1 would have packed all 3 slots with
        # 越陈越香 siblings because that anchor's index has higher dino
        # scores. F1b's round-robin guarantees ≥1 sibling per anchor.
        _orig_idx = globals()["_build_sibling_index"]
        globals()["_build_sibling_index"] = lambda: {
            "越陈越香": ["1657", "1705", "1933", "2234"],  # 4 options, high sim
            "八角亭": ["5878", "5666"],                   # 2 options
        }
        try:
            V9 = {
                "row_to_skuIds": {50: ["1668"], 51: ["1657"], 52: ["1705"],
                                  60: ["1933"], 61: ["2234"],
                                  100: ["4605"], 200: ["5878"], 201: ["5666"]},
                "pos": {"1668": 50, "1657": 51, "1705": 52, "1933": 60,
                        "2234": 61, "4605": 100, "5878": 200, "5666": 201},
                "recs": {s: {"name": s} for s in (
                    "1668", "1657", "1705", "1933", "2234",
                    "4605", "5878", "5666")},
            }
            d9 = _np.zeros(7000); c9 = _np.zeros(7000)
            # 越陈越香 entries have HIGHER sim than 八角亭 ones
            d9[51] = 0.75; c9[51] = 0.70   # 1657
            d9[52] = 0.72; c9[52] = 0.68   # 1705
            d9[60] = 0.70; c9[60] = 0.65   # 1933
            d9[61] = 0.68; c9[61] = 0.63   # 2234
            d9[200] = 0.40; c9[200] = 0.38  # 5878
            d9[201] = 0.38; c9[201] = 0.36  # 5666
            s2r9 = {"1668": 50, "1657": 51, "1705": 52, "1933": 60,
                    "2234": 61, "4605": 100, "5878": 200, "5666": 201}
            pool9 = [
                {"skuId": "1668", "skuIds": ["1668"], "name": "1668",
                "dino_sim": 0.90, "clip_sim": 0.85, "idx": 50,
                "via": "m3_text:越陈越香"},
                {"skuId": "4605", "skuIds": ["4605"], "name": "4605",
                "dino_sim": 0.88, "clip_sim": 0.83, "idx": 100,
                "via": "m3_text:八角亭"},
                {"skuId": "9999", "skuIds": ["9999"], "name": "x",
                "dino_sim": 0.30, "clip_sim": 0.30, "idx": 999,
                "via": "dino"},
            ]
            new_pool9, _, n_inj9, _ = _inject_siblings(
                list(pool9), set(), ["越陈越香", "八角亭"],
                V9, d9, c9, s2r9)
            # F1b should inject ≥1 from each anchor; total = 3
            sib9 = [h for h in new_pool9
                    if str(h.get("via", "")).startswith("sibling:")]
            anchor_set = set()
            for h in sib9:
                v = h["via"]
                anchor_set.add(v.split("sibling:", 1)[1])
            assert len(sib9) == 3, (
                f"case9 expect 3 injects, got {len(sib9)}: {sib9}")
            assert anchor_set == {"越陈越香", "八角亭"}, (
                f"case9 fair allocation FAIL — anchors={anchor_set}, "
                f"expected both 越陈越香 and 八角亭")
            print(f"[self-test f1b] case9 per-anchor fair: "
                  f"anchors={sorted(anchor_set)} OK")

        # case 10 (F1b): intra-pool chain — m3_text fills pool (no OCR/
        # anchor trigger), but 越陈越香 is in pool. Inject should detect
        # 越陈越香 via reverse index and rescue a missing sibling.
        finally:
            globals()["_build_sibling_index"] = _orig_idx

        globals()["_build_sibling_index"] = lambda: {
            "越陈越香": ["1668", "1657", "1705"],
            "八角亭": ["4605"],
        }
        try:
            V10 = {
                "row_to_skuIds": {50: ["1668"], 51: ["1657"], 60: ["1705"],
                                  100: ["4605"]},
                "pos": {"1668": 50, "1657": 51, "1705": 60, "4605": 100},
                "recs": {s: {"name": s} for s in
                         ("1668", "1657", "1705", "4605")},
            }
            d10 = _np.zeros(7000); c10 = _np.zeros(7000)
            d10[50] = 0.80; c10[50] = 0.75
            d10[51] = 0.60; c10[51] = 0.55
            d10[60] = 0.45; c10[60] = 0.40
            d10[100] = 0.85; c10[100] = 0.80
            s2r10 = {"1668": 50, "1657": 51, "1705": 60, "4605": 100}
            # pool already contains 越陈越香 1668 via m3_text (anchor=越陈越香)
            # _inject_siblings may NOT trigger (no active_anchors arg), but
            # _expand_pool_series should detect 越陈越香 in pool via reverse
            # index and inject 1705 (a missing sibling).
            pool10 = [
                {"skuId": "1668", "skuIds": ["1668"], "name": "1668",
                "dino_sim": 0.80, "clip_sim": 0.75, "idx": 50,
                "via": "m3_text:越陈越香"},
                {"skuId": "1657", "skuIds": ["1657"], "name": "1657",
                "dino_sim": 0.60, "clip_sim": 0.55, "idx": 51,
                "via": "m3_text:越陈越香"},
                {"skuId": "9999", "skuIds": ["9999"], "name": "x",
                "dino_sim": 0.30, "clip_sim": 0.30, "idx": 999,
                "via": "dino"},
            ]
            idx10 = globals()["_build_sibling_index"]()
            new_pool10, _, n_inj10 = _expand_pool_series(
                list(pool10), set(), V10, d10, c10, s2r10, idx10,
                max_extra=1)
            assert n_inj10 == 1, (
                f"case10 expect 1 intra-pool inject, got {n_inj10}: "
                f"{new_pool10}")
            injected10 = [h for h in new_pool10
                          if str(h.get("via", "")).startswith(
                              "sibling_intra:")]
            assert len(injected10) == 1, (
                f"case10 expect 1 sibling_intra, got {injected10}")
            assert injected10[0]["skuId"] == "1705", (
                f"case10 expect inject 1705, got {injected10[0]['skuId']}")
            print(f"[self-test f1b] case10 intra-pool chain: "
                  f"inject={injected10[0]['skuId']} OK")

        finally:
            globals()["_build_sibling_index"] = _orig_idx

    finally:
        _ret_st2.donghe_img_path = _orig2

    print("[self-test b3-sibling] 3/3 PASS (v1) + 2/2 PASS (B3-v2) "
          "+ 3/3 PASS (F1) + 2/2 PASS (F1b) = 10/10")



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
# W2-1: dedup index (visual-ids.json v2 schema with skuId_to_row + shared_sha).
# Set USE_DEDUPED_INDEX=0 to revert to canonical-only skuIds list.
USE_DEDUPED_INDEX = os.environ.get("USE_DEDUPED_INDEX", "1") != "0"
# W2-1: sha降权 — within pool, shared-sha candidates after the canonical row
# get dino_sim×0.01, ensuring the canonical skuId wins ties.
USE_SHA_DEMOTE = os.environ.get("USE_SHA_DEMOTE", "1") != "0"
# W2-2: hard-negative 降级规则引擎 — same_product + 同 series anchor phrase +
# sibling dino_sim≥0.50 触发降级为 same_series_variant + conf×0.6。
HARD_NEG_DEMOTE = os.environ.get("HARD_NEG_DEMOTE", "1") != "0"

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
    # W2-1: extend schema — skuId_to_row covers all 6717 (canonical+non-canonical),
    # shared_sha lists groups of SKUs sharing an identical image (top-5 sha
    # cover ~49% of the pool). Both default off when index is v1 (no keys).
    skuId_to_row = meta.get("skuId_to_row") if USE_DEDUPED_INDEX else None
    shared_sha = meta.get("shared_sha") if USE_DEDUPED_INDEX else None
    # W2-1: sha降权 needs per-skuId sha1; compute lazily on first compare() call
    # (avoid 30s blocking on cold-start).
    _V = {"np": np, "dino_sess": dino_sess, "clip_sess": clip_sess,
          "dino_mat": dino_mat, "clip_mat": clip_mat, "ids": ids,
          "pos": {sid: i for i, sid in enumerate(ids)}, "recs": recs,
          "brand_df": brand_df,
          "skuId_to_row": skuId_to_row, "shared_sha": shared_sha,
          # W2.1fix: reverse map row → [skuId,...] so candidates can expose
          # ALL skuIds sharing an image (canonical + non-canonical). When
          # upstream reuses one photo for 2176 (001 7572) + 2177 (2010年 7572),
          # pool must show both so a "2010年" query can disambiguate; without
          # this, the canonical-only pool silently drops the user's intended
          # SKU — recall eval says "missing" and prod returns the wrong name.
          "row_to_skuIds": _build_row_to_skuIds(skuId_to_row) if skuId_to_row else {},
          "img_sha": None}  # populated on demand in compare()
    return _V


def _build_row_to_skuIds(skuId_to_row):
    out = {}
    for sid, row in skuId_to_row.items():
        out.setdefault(row, []).append(sid)
    return out


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
def compare(image_path, ocr_text="", return_pool_only: bool = False, cancel=None):
    """User photo vs donghe reference corpus. Never raises.
    Returns {"ok", "reason", "brand", "candidates", "verdicts", "best"}.

    W1-3: when return_pool_only=True, skip _vlm_pick / _vlm_compare / parallel
    M3 calls and return the candidate pool + planned-compare size. Used by
    the offline eval scorer to baseline recall without burning M3 quota.
    Default False preserves all existing call sites (rag_pipeline.answer
    etc.) unchanged.

    W3-2: optional cooperative cancel token — checked at entry and inside
    the M3 semaphore wait; raises Cancelled (propagates to server.py → 499).
    None keeps the pre-W3 blocking behavior.
    """
    if cancel:
        cancel.check()
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
        return {"skuId": sid,
                # W2.1fix: 同 row 的所有 SKU（含 non-canonical 同图复用）。
                # 例如 row=551 → ["2176", "2177"] (001 7572 + 2010年 7572)。
                "skuIds": V.get("row_to_skuIds", {}).get(i, [sid]),
                "name": V["recs"].get(sid, {}).get("name") or sid,
                "dino_sim": round(float(d), 4), "clip_sim": round(float(c), 4),
                "idx": i,
                # W3-0: tea_type 让 M3 verdict 后端有 structured hint, 避免 SKU
                # 名推断生熟 (如 7262 名「天福销台7262」M3 误判生, 实际大益
                # 经典熟)。
                "tea_type": V["recs"].get(sid, {}).get("tea_type") or "unknown"}

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
                series.append({"skuId": sid, "skuIds": V.get("row_to_skuIds", {}).get(i, [sid]), "name": r.get("name") or sid,
                               "dino_sim": round(float(dsims[i]), 4),
                               "clip_sim": round(float(csims[i]), 4),
                               "idx": i, "via": f"anchor:{a}",
                               "tea_type": r.get("tea_type") or "unknown"})
    # Second pass: OCR-text fallback via fuzzy lookup — handles drop/struck chars
    # (user's 「陳越香」drops the first 「越」 → exact returns 0; fuzzy by prefix
    # overlap surfaces the 越陈越香 series so M3 can shortlist the right member).
    if ocr_text:
        for s, r in retriever.donghe_lookup_fuzzy(ocr_text, topk=6):
            sid = str(r["skuId"])
            if sid in V["pos"] and sid not in seen_sid:
                seen_sid.add(sid)
                i = V["pos"][sid]
                series.append({"skuId": sid, "skuIds": V.get("row_to_skuIds", {}).get(i, [sid]), "name": r.get("name") or sid,
                               "dino_sim": round(float(dsims[i]), 4),
                               "clip_sim": round(float(csims[i]), 4),
                               "idx": i, "via": f"ocr_fuzzy:{ocr_text}",
                               "tea_type": r.get("tea_type") or "unknown"})
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
                    series.append({"skuId": sid, "skuIds": V.get("row_to_skuIds", {}).get(i, [sid]), "name": r.get("name") or sid,
                                   "dino_sim": round(float(dsims[i]), 4),
                                   "clip_sim": round(float(csims[i]), 4),
                                   "idx": i, "via": f"ocr_token:{tok}",
                                   "tea_type": r.get("tea_type") or "unknown"})
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
                    series.append({"skuId": sid, "skuIds": V.get("row_to_skuIds", {}).get(i, [sid]), "name": r.get("name") or sid,
                                   "dino_sim": round(float(dsims[i]), 4),
                                   "clip_sim": round(float(csims[i]), 4),
                                   "idx": i, "via": f"m3_text:{tok}",
                                   "tea_type": r.get("tea_type") or "unknown"})
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
    # W2.1fix: 去重 key 从 skuId 改为 idx (row)。原因: 同 row 的多个 SKU
    # (e.g. 2176 + 2177, 共享同图) 现在通过 skuIds 字段都进入 candidate; 如果
    # 还按 skuId 去重, 同一 row 会被两次入池, 既浪费 M3 slot 也让 pool size
    # 偏离 N_COMPARE 预期。row 唯一 → 入池一次, skuIds 列表保留所有 SKU 信息。
    pool, used = [], set()

    def add(h):
        row = h.get("idx")
        if row is not None and row not in used and os.path.exists(
                retriever.donghe_img_path(V["recs"].get(h["skuId"], {"skuId": h["skuId"]}))):
            used.add(row)
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
    # W2-1: sha降权 — within shared_sha groups (top-5 sha cover ~49% of pool),
    # canonical row gets full sim, others get dino_sim×0.01. Re-sort so the
    # canonical skuId wins ties. Mirrors _DINO_TOP1_GUARD's "post-sort + re-slice"
    # pattern. Disabled via USE_SHA_DEMOTE=0.
    if USE_SHA_DEMOTE and V.get("shared_sha"):
        if V.get("img_sha") is None:
            # W2-1: lazy-compute sha1 for each pool candidate (~6 hashes per
            # request, <1ms). Full 6717-shsku map not needed — only pool-sized.
            import hashlib as _hl
            _img_sha = {}
            for h in pool_sorted:
                sid = h["skuId"]
                if sid in _img_sha:
                    continue
                p = f"/data/donghe-images/{sid}.jpeg"
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        _img_sha[sid] = _hl.sha1(f.read()).hexdigest()
                else:
                    _img_sha[sid] = None
            V["img_sha"] = _img_sha
        _pool_sha = {h["skuId"]: V["img_sha"].get(h["skuId"]) for h in pool_sorted}
        _seen_first = {}  # sha → first sid encountered in sort order
        for h in pool_sorted:
            sha = _pool_sha.get(h["skuId"])
            if sha is None or sha not in V["shared_sha"]:
                continue
            if sha in _seen_first:
                # h is a non-canonical sibling of an earlier sha-group member;
                # series-rescue priority keeps it eligible above non-shared
                # pool entries, but within shared-sha group the first wins.
                if h["skuId"] not in series_sids:
                    h["dino_sim"] = round(h["dino_sim"] * 0.01, 4)
                    h["_sha_demoted"] = True
            else:
                _seen_first[sha] = h["skuId"]
        # re-sort after demotion
        pool_sorted = sorted(pool_sorted, key=lambda x: (1 if x["skuId"] not in series_sids else 0,
                                                         -x["dino_sim"]))
    # F1: sibling inject (B3 line refined) — reserved slot replaces the
    # weakest fill/series entry, N_COMPARE unchanged. The post-injection
    # re-sort treats via=sibling: as protected (priority 0) so the
    # reserved slot survives any future pool expansion. Errors are logged
    # to stderr instead of silently swallowed — B3's silent except masked
    # the whole "injection = 0" bug for months.
    try:
        if _SIBLING_INJECT:
            _b3_active = _detect_active_anchors(ocr_text, V, pool=pool_sorted)
            _b3_skuId_to_row = V.get("skuId_to_row") or {}
            if _b3_active and _b3_skuId_to_row:
                pool_sorted, used, _b3_n, _b3_map = _inject_siblings(
                    pool_sorted, used, _b3_active, V, dsims, csims, _b3_skuId_to_row,
                )
                if _b3_n:
                    pool_sorted = sorted(pool_sorted, key=lambda x: (
                        0 if (x["skuId"] in series_sids
                              or str(x.get("via", "")).startswith("sibling:"))
                        else 1,
                        -x.get("dino_sim", 0)))
                # F1b intra-pool chain: rescue 019/020-style cases where
                # m3_text filled pool and no anchor was OCR-triggered.
                try:
                    _b3b_index = _build_sibling_index()
                    pool_sorted, used, _b3b_n = _expand_pool_series(
                        pool_sorted, used, V, dsims, csims, _b3_skuId_to_row,
                        _b3b_index, max_extra=1,
                    )
                    if _b3b_n:
                        pool_sorted = sorted(pool_sorted, key=lambda x: (
                            0 if (x["skuId"] in series_sids
                                  or str(x.get("via", "")).startswith("sibling")
                                  or str(x.get("via", "")).startswith("sibling_intra:"))
                            else 1,
                            -x.get("dino_sim", 0)))
                except Exception as _b3b_e:
                    import sys as _sys_b
                    print(f"[F1b intra-pool chain skipped: {_b3b_e!r}]",
                          file=_sys_b.stderr)
    except Exception as _b3_e:
        import sys as _sys
        print(f"[F1 sibling inject skipped: {_b3_e!r}]", file=_sys.stderr)

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
                # F1: include via in pool-only candidates so the offline
                # scorer can see which slots are reserved-slot siblings vs
                # series-rescue vs pure fill (eval-only; prod uses the same
                # dict for E1/E2 via but does not need this key).
                "candidates": [{**{k: h[k] for k in ("skuId", "skuIds", "name",
                                                      "dino_sim", "clip_sim")},
                                "via": h.get("via", "")}
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
        # W3-2: wait for a global M3 slot in cancellable slices — a plain
        # blocking acquire would keep this worker queued (and its caller
        # computing) long after the client disconnected.
        while not _CMP_SEM.acquire(timeout=0.5):
            if cancel:
                cancel.check()
        try:
            _t = time.monotonic()
            v = _vlm_compare(image_path, ref)
        finally:
            _CMP_SEM.release()
        m3_diag.append({"stage": "compare", "skuId": h["skuId"],
                        "s": round(time.monotonic() - _t, 2)})
        if v:
            v.update({"skuId": h["skuId"], "name": h["name"],
                      "record": V["recs"].get(h["skuId"]),
                      "via": h.get("via", ""),
                      "dino_sim": h.get("dino_sim")})
            # W3-1: lift tea_type to best top-level so refusal.compute's
            # conflicting_signals check can read it without traversing record.
            # Best-level exposure also fixes W3-0 tea_type leak — frontend /
            # LLM callers no longer see the record payload, but tea_type now
            # survives the strip at rag_pipeline L283.
            v["tea_type"] = (V["recs"].get(h["skuId"], {}) or {}).get("tea_type") or "unknown"
        return v

    # W1-4: pairwise M3 in parallel — the serial loop was the latency root
    # cause (10 serial calls = 123.97s measured on 2026-08-21).
    with ThreadPoolExecutor(max_workers=_CMP_WORKERS) as _ex:
        verdicts = [v for v in _ex.map(_one, to_compare) if v]
    if not verdicts:
        verdicts = None

    # W2-2: hard-negative 降级 — after M3 verdict aggregation, scan for
    # same_product + 同 series anchor phrase + sibling dino_sim≥0.50, demote
    # to same_series_variant + conf×0.6. Disabled via HARD_NEG_DEMOTE=0.
    w2_demoted = 0
    if HARD_NEG_DEMOTE and verdicts:
        try:
            import hard_neg_rules
            w2_demoted = hard_neg_rules.apply_demote(
                verdicts, to_compare, V["recs"])
        except Exception as _e:
            import sys as _sys
            print(f"[W2-2 demote skipped: {_e!r}]", file=_sys.stderr)

    best = None
    if verdicts:
        rank = {v: i for i, v in enumerate(VERDICTS)}
        best = sorted(verdicts, key=lambda x: (rank[x["verdict"]], -x["confidence"]))[0]

    # B2 demote: same_product + temporal/variant note cue -> ssv x0.6
    if best:
        _v_old, _c_old = best["verdict"], best["confidence"]
        _v_new, _c_new = _apply_b2_demote(_v_old, _c_old, best.get("notes", ""))
        if _v_new != _v_old or abs(_c_new - _c_old) > 1e-6:
            best["verdict"] = _v_new
            best["confidence"] = _c_new
            best["_b2_demoted"] = True

    # E2: sibling-aware best bias (env-gated; default OFF -- offline draft)
    if best and _E2_SIBLING_BIAS:
        _b_before = best.get("skuId")
        best = _apply_e2_sibling_bias(best, verdicts, rank)
        if best.get("_e2_promoted"):
            print(f"[E2] best {_b_before} -> {best.get('skuId')} "
                  f"(self_sim<floor, sibling bias)", flush=True)

    return {"ok": True, "reason": None,
            "brand": fam_brand,
            "candidates": [{k: h[k] for k in ("skuId", "skuIds", "name", "dino_sim", "clip_sim")}
                           for h in to_compare],
            "verdicts": verdicts, "best": best,
            # W1-1: per-request diagnostics for rag_pipeline's TRACE line
            # (stripped there before the response leaves the container).
            "trace": {"m3_calls": m3_diag,
                      "n_pool": len(pool_sorted), "n_compared": len(to_compare),
                      # W2-2: counter for hard-negative demotions applied
                      # (0 means W2-2 didn't fire on this request).
                      "w2_demoted": w2_demoted,
                      # E2: whether sibling-aware best bias swapped the pick.
                      "e2_applied": bool(best and best.get("_e2_promoted")),
                      "pool": [{"skuId": h.get("skuId"), "name": h.get("name"),
                                "via": h.get("via", ""), "dino_sim": h.get("dino_sim"),
                                "clip_sim": h.get("clip_sim")}
                               for h in pool_sorted]}}


# ---------- W3-3: multi-image vote fusion ----------
def compare_multi(image_paths, ocr_texts, cancel=None):
    """Compare every image against the corpus (parallel, capped workers),
    then fuse per-image bests by skuId vote. Returns the same shape as
    compare() so rag_pipeline / refusal logic are unchanged downstream;
    the per-request trace carries an extra "multi" block (votes / rule).

    Real-world driver: users upload 整箱+大票+单饼 as 2-3 photos — the old
    single-image call answered whatever happened to be image_paths[0].
    """
    texts = list(ocr_texts or [])
    texts += [""] * (len(image_paths) - len(texts))  # pad to image count

    def _run(i):
        try:
            return compare(image_paths[i], texts[i], cancel=cancel)
        except Exception as e:  # per-image failure must not sink the rest
            return {"ok": False, "reason": f"multi_image_error:{type(e).__name__}",
                    "brand": "", "candidates": [], "verdicts": None, "best": None}

    with ThreadPoolExecutor(max_workers=min(len(image_paths), 3)) as ex:
        results = list(ex.map(_run, range(len(image_paths))))
    return fuse_multi(image_paths, results)


def fuse_multi(image_paths, results):
    """Vote fusion over per-image compare() results.

    Rules (plan 2026-08-23):
      unanimous  — every best is the same skuId (N≥2) → same_product, avg conf
      majority   — one skuId takes ≥2 of N votes               → same_product, avg×0.85
      tie_break  — no skuId has ≥2 votes                       → best = highest
                   (VERDICTS rank, -confidence) per-image best, verdict forced
                   to same_series_variant, conf×0.6 (multi-image disagreement
                   must not read as a confident same_product)
      single_best / no_bests — degenerate fallbacks.
    Images whose compare() degraded (ok=False / best=None) are excluded from
    voting but still counted in trace.multi.n_ok for diagnosis.
    """
    ok_results = [r for r in results if r and r.get("ok")]
    pairs = [(r, r["best"]) for r in ok_results if r.get("best")]  # (result, best)
    votes: dict = {}
    for _, b in pairs:
        votes[b["skuId"]] = votes.get(b["skuId"], 0) + 1
    n = len(pairs)

    fused, src_result, rule = None, None, "no_bests"
    if n == 1:
        src_result, fused, rule = pairs[0][0], dict(pairs[0][1]), "single_best"
    elif n >= 2:
        top_sku, top_count = max(votes.items(), key=lambda kv: kv[1])
        top_pairs = [(r, b) for r, b in pairs if b["skuId"] == top_sku]
        avg_conf = sum(b.get("confidence", 0) for _, b in top_pairs) / len(top_pairs)
        if top_count == n:
            rule = "unanimous"
            src_result, fused = top_pairs[0]
            fused = dict(fused)
            fused["verdict"] = "same_product"
            fused["confidence"] = round(avg_conf, 2)
        elif top_count >= 2:
            rule = "majority"
            src_result, fused = top_pairs[0]
            fused = dict(fused)
            fused["verdict"] = "same_product"
            fused["confidence"] = round(avg_conf * 0.85, 2)
        else:
            # tie / all-different: multi-image disagreement → conservative
            rule = "tie_break"
            rank = {v: i for i, v in enumerate(VERDICTS)}
            src_result, fused = sorted(
                pairs, key=lambda rb: (rank[rb[1]["verdict"]],
                                       -rb[1].get("confidence", 0)))[0]
            fused = dict(fused)
            fused["verdict"] = "same_series_variant"
            fused["confidence"] = round(fused.get("confidence", 0) * 0.6, 2)

    # merged trace: flatten per-image m3_calls (tagged with img index) so the
    # TRACE line still shows the true M3 spend; extra "multi" vote block.
    m3_calls, pools = [], []
    for i, r in enumerate(results):
        t = (r or {}).get("trace") or {}
        m3_calls.extend([{**c, "img": i} for c in (t.get("m3_calls") or [])])
        pools.extend((t.get("pool") or [])[:6])  # cap pool rows in trace
    flat_verdicts = [v for r in ok_results for v in (r.get("verdicts") or [])] or None
    first_ok = ok_results[0] if ok_results else {}

    return {
        "ok": bool(ok_results),
        "reason": None if ok_results else "; ".join(
            (r or {}).get("reason") or "?" for r in results),
        "brand": first_ok.get("brand", ""),
        "candidates": (src_result or {}).get("candidates", []),
        "verdicts": flat_verdicts,
        "best": fused,
        "trace": {
            "m3_calls": m3_calls,
            "n_pool": len(pools), "n_compared": len(m3_calls),
            "pool": pools,
            "multi": {"n_images": len(image_paths), "n_ok": len(ok_results),
                      "votes": votes, "rule": rule,
                      "fused_conf": (fused or {}).get("confidence")},
        },
    }


if __name__ == "__main__":
    import sys
    img = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tianfu7262.jpg"
    ocr = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(compare(img, ocr), ensure_ascii=False, indent=2))
