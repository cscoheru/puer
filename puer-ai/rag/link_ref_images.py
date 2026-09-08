#!/usr/bin/env python3
"""M3-lite step 7: link ref-image identities to sku-clean records.

For each identity folder (e.g. 小厂研究/3.下关/92四喜砖):
  - parse leaf -> (year?, name-core)
  - match against sku-clean names: exact containment / bigram similarity
Output: ref-image-sku-map.jsonl + console report (matched / unmatched)
"""
import json
import re
import collections

RAG = "/Users/kjonekong/Documents/puer-ai/rag"
sku = [json.loads(l) for l in open(f"{RAG}/sku-clean.jsonl", encoding="utf-8")]
refs = [json.loads(l) for l in open(f"{RAG}/ref-images.jsonl", encoding="utf-8")]

by_identity = collections.Counter(r["identity"] for r in refs)

def bigrams(s):
    s = re.sub(r"\s+", "", s)
    return set(s[i:i+2] for i in range(len(s) - 1))

def parse_leaf(identity):
    """identity -> (year_core or None, name_core)"""
    leaf = identity.split("/")[-1].replace("-", "/").split("/")[-1]
    m = re.match(r"^((?:9\d|0\d|1\d)|(?:19|20)\d{2})\s*年?\s*(.*)", leaf)
    if m:
        y, core = m.group(1), m.group(2)
        # tea-context 2-digit years: >=30 can only be 1930-1999, <30 is 2000s
        y = int(y) if len(y) == 4 else (1900 + int(y) if int(y) >= 30 else 2000 + int(y))
        return y, core
    return None, leaf

def sim(a, b):
    ba, bb = bigrams(a), bigrams(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / min(len(ba), len(bb))

def match(year, core):
    if not core:
        return None, "skip", 0.0
    cands = [r for r in sku
             if not (year is not None and r["year"] is not None and r["year"] != year)]
    # generic-core gate AFTER year filter: >=3 same-year skus contain core
    if len(core) <= 4 and sum(1 for r in cands if core in r["name"]) >= 3:
        return None, "skip", 0.0
    best, best_s = None, 0.0
    for r in cands:
        name = r["name"]
        # pure-digit cores (唛号 like 7540) demand exact substring, no fuzzy
        if core.isdigit():
            if core not in name:
                continue
            s = 1.0
        else:
            s = sim(core, name)
            # containment bonus: core appears inside sku name (or vice versa)
            if core in name or (len(core) >= 4 and any(
                    name[i:i+len(core)] == core for i in range(0, max(0, len(name)-len(core)+1)))):
                s = max(s, 0.95)
            if r["year"] == year and year is not None:
                s = min(1.0, s + 0.15)  # year agreement
        if s > best_s:
            best, best_s = r, s
    if best is None:
        return None, "none", 0.0
    if best_s >= 0.75:
        return best, "strong", best_s
    if best_s >= 0.55:
        return best, "weak", best_s
    return None, "none", best_s

def main():
    out = open(f"{RAG}/ref-image-sku-map.jsonl", "w", encoding="utf-8")
    stats = collections.Counter()
    unmatched = []
    for identity in sorted(by_identity):
        year, core = parse_leaf(identity)
        rec, kind, s = match(year, core)
        stats[kind] += 1
        row = {"identity": identity, "n_images": by_identity[identity],
               "year": year, "name_core": core,
               "match": kind, "score": round(s, 2),
               "sku_name": rec["name"] if rec else "",
               "sku_year": rec["year"] if rec else "",
               "sku_price": (rec.get("estimate") or rec.get("market_price_per_jian")
                             or rec.get("market_price")) if rec else "",
               "sku_source": rec["source_file"] if rec else ""}
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
        if kind == "none":
            unmatched.append((identity, core))
    out.close()
    n = sum(stats.values())
    print(f"identities: {n}  strong={stats['strong']}  weak={stats['weak']}  "
          f"none={stats['none']}  skip={stats['skip']}")
    print("\n== strong matches ==")
    for l in open(f"{RAG}/ref-image-sku-map.jsonl"):
        r = json.loads(l)
        if r["match"] == "strong":
            print(f"  {r['identity']:40s} -> {r['sku_name']} ({r['sku_year']}) 价{r['sku_price'] or '?'}")
    print(f"\n== unmatched (top 15 of {len(unmatched)}) ==")
    for identity, core in unmatched[:15]:
        print(f"  {identity}  [core={core}]")

if __name__ == "__main__":
    main()
