#!/usr/bin/env python3
"""M3-lite step 5: retrieval smoke test over sku-clean + knowledge-chunks.

Two retrievers side by side:
  A) SKU lookup   — exact/fuzzy match on name+year (table data, no embedding)
  B) Knowledge    — semantic search over prose chunks
                    embedding if sentence-transformers available,
                    else char-bigram idf scoring as dependency-free baseline

All text NFKC-normalized at load (fixes Kangxi radicals from PDF extraction:
⼊口 -> 入口, otherwise normal-Chinese queries never match).

2026-08-18: retrieval logic extracted into retriever.py (lazy-loading, shared
with the answer pipeline); this file keeps the smoke-test CLI and its output
format byte-identical.
"""
import sys

from retriever import sku_lookup, bigram_search, embed_search, price_str

def run(query):
    print(f"\n{'='*70}\nQ: {query}")
    print("-- SKU 行情 --")
    hits = sku_lookup(query)
    if not hits:
        print("  (无命中)")
    for s, r in hits:
        print(f"  [{s}] {r['name']} ({r['year']}) {r['form']} "
              f"{price_str(r)} 快照:{r.get('snapshot_date') or '?'} <- {r['source_file']}")
    print("-- 知识检索 (bigram) --")
    for s, c in bigram_search(query, 3):
        print(f"  [{s:.1f}] {c['source']} p{c['pages']}: {c['text'][:80]}…")
    try:
        print("-- 知识检索 (bge embedding) --")
        for s, c in embed_search(query, 3):
            print(f"  [{s:.3f}] {c['source']} p{c['pages']}: {c['text'][:80]}…")
    except ImportError:
        print("  (sentence-transformers 未安装,bigram 兜底)")

CANNED = [
    "03四星孔雀现在什么行情",
    "97水蓝印多少钱一件",
    "7542为什么被称为标杆",
    "怎么辨别湿仓茶",
    "大益改制前后有什么区别",
]

if __name__ == "__main__":
    if len(sys.argv) > 1:
        for q in sys.argv[1:]:
            run(q)
    else:
        for q in CANNED:
            run(q)
