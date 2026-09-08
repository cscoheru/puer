#!/usr/bin/env python3
"""E1/E2 offline replay analyzer.

Input: scores.v5.e12.jsonl -- captured ONCE with SIBLING_INJECT=1 + B2 on + E2 on,
full field capture (notes/via/dino_sim/_b2_demoted/_e2_promoted/_e2_from).

Configs replayed offline on identical M3 samples:
  R1: B2 OFF (demote undone), E2 OFF   -- isolate B2 (E1) effect vs R2
  R2: B2 ON, E2 OFF                    -- isolate E2 effect vs R3
  R3: B2 ON, E2 ON  (= live capture)
  D1: R2 + E2 WITHOUT self-sim carve-out (diagnostic for anchor-pair)

Scoring (denominator = rows with expected_sku, non-refusal; =90 on v5):
  strict: best.skuId==expected AND verdict in allowed (if listed)
          AND no forbidden verdict on ANY candidate with sku != expected
          (exact P0 analyzer semantics)
  loose : best.skuId==expected AND best.verdict not in forbidden
"""
import json
import sys
from collections import Counter, defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "/opt/puer-hub/rag-data/eval/scores.v5.e12.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else None

VERDICTS = ["same_product", "same_series_variant", "different_product", "uncertain"]
RANK = {v: i for i, v in enumerate(VERDICTS)}


def load(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows


def demote_undo(b):
    """B2 demote was verdict->same_series_variant, conf*0.6. Undo it."""
    if not b or not b.get("_b2_demoted"):
        return b
    b = dict(b)
    b["verdict"] = "same_product"
    try:
        b["confidence"] = round(float(b.get("confidence") or 0.0) / 0.6, 4)
    except (TypeError, ValueError):
        pass
    b["_b2_undone"] = True
    return b


def find_entry(verdicts, sku):
    for v in verdicts or []:
        if str(v.get("skuId")) == str(sku):
            return v
    return None


def rebuild_verdicts(row, e1):
    """Copy of verdicts list; when e1 off, undo the in-place B2 mutation on the
    demoted entry (compare() mutates the shared best dict, so the verdicts entry
    of the demoted sku carries the post-demote verdict/conf in the capture)."""
    verdicts = [dict(v) for v in (row.get("verdicts") or [])]
    if not e1:
        best = row.get("best") or {}
        if best.get("_b2_demoted"):
            # B2 and E2 are mutually exclusive (E2 requires pre-swap verdict==sp),
            # so the demoted sku is the live best sku.
            ent = find_entry(verdicts, best.get("skuId"))
            if ent and ent.get("verdict") == "same_series_variant":
                ent["verdict"] = "same_product"
                try:
                    ent["confidence"] = round(float(ent.get("confidence") or 0.0) / 0.6, 4)
                except (TypeError, ValueError):
                    pass
    return verdicts


def rebuild_best(row, e1, e2):
    best = row.get("best")
    if best is None:
        return None
    verdicts = row.get("verdicts") or []
    b = dict(best)
    if not e2 and b.get("_e2_promoted"):
        orig = find_entry(verdicts, b.get("_e2_from"))
        if orig:
            b = dict(orig)
            b["_e2_reverted"] = True
        else:
            b = dict(b)
            b.pop("_e2_promoted", None)
    if not e1:
        b = demote_undo(b)
    return b


def d1_best(row):
    """R2 best, then E2 applied WITHOUT the self-sim carve-out."""
    b = rebuild_best(row, e1=True, e2=False)
    verdicts = row.get("verdicts") or []
    if not b or b.get("verdict") != "same_product":
        return b
    if "sibling:" in str(b.get("via", "")):
        return b
    sibs = [v for v in verdicts
            if "sibling:" in str(v.get("via", ""))
            and v.get("verdict") in ("same_product", "same_series_variant")
            and str(v.get("skuId")) != str(b.get("skuId"))]
    if not sibs:
        return b
    pick = sorted(sibs, key=lambda x: (RANK[x["verdict"]],
                                       -float(x.get("confidence") or 0.0)))[0]
    p = dict(pick)
    p["_d1_promoted"] = True
    p["_d1_from"] = b.get("skuId")
    return p


def score_row(row, best, verdicts):
    if row.get("expect_refusal"):
        return None
    exp = row.get("expected_sku")
    if exp is None:
        return None
    if best is None:
        return {"strict": False, "loose": False, "sku_ok": False,
                "forbidden_sweep": False, "forbidden_best": False}
    allowed = set(row.get("allowed_verdicts") or [])
    forbidden = set(row.get("forbidden_verdicts") or [])
    sku_ok = str(best.get("skuId")) == str(exp)
    allowed_ok = (not allowed) or best.get("verdict") in allowed
    forbidden_best = bool(forbidden) and best.get("verdict") in forbidden
    forbidden_sweep = any(
        v.get("verdict") in forbidden and str(v.get("skuId")) != str(exp)
        for v in verdicts)
    return {"strict": sku_ok and allowed_ok and not forbidden_sweep,
            "loose": sku_ok and not forbidden_best,
            "sku_ok": sku_ok,
            "forbidden_sweep": forbidden_sweep,
            "forbidden_best": forbidden_best}


def summarize(rows, cfg_name, pick):
    """pick(row) -> (best, verdicts). Returns per-category + overall metrics."""
    cats = defaultdict(lambda: {"strict": 0, "loose": 0, "n": 0})
    tot = {"strict": 0, "loose": 0, "n": 0}
    details = []
    for r in rows:
        best, verdicts = pick(r)
        s = score_row(r, best, verdicts)
        if s is None:
            continue
        cat = r.get("category") or "?"
        cats[cat]["n"] += 1
        tot["n"] += 1
        if s["strict"]:
            cats[cat]["strict"] += 1
            tot["strict"] += 1
        if s["loose"]:
            cats[cat]["loose"] += 1
            tot["loose"] += 1
        details.append((r["case_id"], cat, s["strict"], s["loose"]))
    return {"config": cfg_name, "overall": tot, "by_category": dict(cats),
            "details": details}


def main():
    rows = load(PATH)
    print(f"rows: {len(rows)}")
    refusal = sum(1 for r in rows if r.get("expect_refusal"))
    aware = sum(1 for r in rows
                if not r.get("expect_refusal") and r.get("expected_sku") is not None)
    print(f"refusal rows: {refusal} | eval-aware: {aware}")

    configs = {
        "R1_noE1_noE2": lambda r: (rebuild_best(r, False, False),
                                   rebuild_verdicts(r, False)),
        "R2_E1_only": lambda r: (rebuild_best(r, True, False),
                                 rebuild_verdicts(r, True)),
        "R3_E1_E2_live": lambda r: (rebuild_best(r, True, True),
                                    rebuild_verdicts(r, True)),
        "D1_E2_no_carveout": lambda r: (d1_best(r), rebuild_verdicts(r, True)),
    }
    results = {}
    for name, pick in configs.items():
        results[name] = summarize(rows, name, pick)

    # ---- material / firing diagnostics ----
    n_sib_material = 0
    n_b2_fired = 0
    n_e2_fired = 0
    anchor_reached = 0
    anchor_total = 0
    anchor_sib_material = 0
    b2_events = []
    e2_events = []
    for r in rows:
        if r.get("expect_refusal"):
            continue
        verdicts = r.get("verdicts") or []
        sibs = [v for v in verdicts if "sibling:" in str(v.get("via", ""))]
        if sibs:
            n_sib_material += 1
        best = r.get("best") or {}
        if best.get("_b2_demoted"):
            n_b2_fired += 1
            b2_events.append((r["case_id"], r.get("category"),
                              best.get("skuId"),
                              str(best.get("notes") or "")[:60]))
        if best.get("_e2_promoted"):
            n_e2_fired += 1
            e2_events.append((r["case_id"], r.get("category"),
                              best.get("_e2_from"), best.get("skuId")))
        if r.get("category") == "anchor-pair-distinction":
            anchor_total += 1
            exp = str(r.get("expected_sku"))
            if any(str(v.get("skuId")) == exp for v in verdicts):
                anchor_reached += 1
            if sibs:
                anchor_sib_material += 1

    diag = {
        "cases_with_sibling_via_candidate": n_sib_material,
        "b2_demote_fired": n_b2_fired,
        "e2_promote_fired_live": n_e2_fired,
        "anchor_pair_total": anchor_total,
        "anchor_pair_expected_in_compareset": anchor_reached,
        "anchor_pair_with_sibling_material": anchor_sib_material,
        "b2_events": b2_events,
        "e2_events": e2_events,
    }

    # ---- flips R1->R2 (E1 effect) and R2->R3 (E2 effect) ----
    def flip_sets(a, b):
        gained, lost = [], []
        da = {c: (s, l) for c, _, s, l in a}
        db = {c: (s, l) for c, _, s, l in b}
        for cid in da:
            if cid not in db:
                continue
            if db[cid][0] and not da[cid][0]:
                gained.append((cid, "strict"))
            if da[cid][0] and not db[cid][0]:
                lost.append((cid, "strict"))
            if db[cid][1] and not da[cid][1]:
                gained.append((cid, "loose"))
            if da[cid][1] and not db[cid][1]:
                lost.append((cid, "loose"))
        return gained, lost

    e1_gained, e1_lost = flip_sets(results["R1_noE1_noE2"]["details"],
                                   results["R2_E1_only"]["details"])
    e2_gained, e2_lost = flip_sets(results["R2_E1_only"]["details"],
                                   results["R3_E1_E2_live"]["details"])
    d1_gained, d1_lost = flip_sets(results["R2_E1_only"]["details"],
                                   results["D1_E2_no_carveout"]["details"])

    # ---- print ----
    print()
    print("=" * 78)
    for name in ["R1_noE1_noE2", "R2_E1_only", "R3_E1_E2_live", "D1_E2_no_carveout"]:
        res = results[name]
        o = res["overall"]
        print(f"\n[{name}] overall strict {o['strict']}/{o['n']} "
              f"= {100.0*o['strict']/o['n'] if o['n'] else 0:.1f}% | "
              f"loose {o['loose']}/{o['n']} "
              f"= {100.0*o['loose']/o['n'] if o['n'] else 0:.1f}%")
        for cat in sorted(res["by_category"]):
            c = res["by_category"][cat]
            print(f"    {cat:<30} strict {c['strict']}/{c['n']:<3} "
                  f"loose {c['loose']}/{c['n']}")

    print()
    print("=" * 78)
    print("DIAGNOSTICS")
    print(f"  cases with >=1 via=sibling:* candidate : {n_sib_material}")
    print(f"  B2 demote fired (best._b2_demoted)     : {n_b2_fired}")
    print(f"  E2 promote fired live                  : {n_e2_fired}")
    print(f"  anchor-pair: expected in compare set   : {anchor_reached}/{anchor_total}")
    print(f"  anchor-pair: has sibling material      : {anchor_sib_material}/{anchor_total}")
    print()
    print("  B2 events (case, category, best_sku, notes[:60]):")
    for e in b2_events:
        print(f"    {e}")
    print("  E2 events (case, category, from -> to):")
    for e in e2_events:
        print(f"    {e}")
    print()
    print(f"  E1 flips R1->R2 gained: {e1_gained}")
    print(f"  E1 flips R1->R2 lost  : {e1_lost}")
    print(f"  E2 flips R2->R3 gained: {e2_gained}")
    print(f"  E2 flips R2->R3 lost  : {e2_lost}")
    print(f"  D1 flips R2->D1 gained: {d1_gained}")
    print(f"  D1 flips R2->D1 lost  : {d1_lost}")

    if OUT:
        with open(OUT, "w") as f:
            json.dump({"results": {k: {"overall": v["overall"],
                                       "by_category": v["by_category"],
                                       "details": v["details"]}
                                   for k, v in results.items()},
                       "diagnostics": diag,
                       "flips": {"e1_gained": e1_gained, "e1_lost": e1_lost,
                                 "e2_gained": e2_gained, "e2_lost": e2_lost,
                                 "d1_gained": d1_gained, "d1_lost": d1_lost}},
                      f, ensure_ascii=False, indent=1)
        print(f"\nJSON -> {OUT}")


if __name__ == "__main__":
    main()
