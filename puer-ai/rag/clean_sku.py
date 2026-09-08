#!/usr/bin/env python3
"""M3-lite step 4: clean sku-records.jsonl -> sku-clean.jsonl.

Rules (all derived from manual inspection, see cleaning report):
1. drop garbage rows (name without CJK: filler sequences / calc residue)
2. year normalization per sheet:
   - 06年之前大益熟茶统计: yy -> 2000+yy   (00-06 = 2000s)
   - 改制前老茶-全:         yy -> 1900+yy   (10-99 = 1910-1999)
   - 白菜孔雀:              yy>=99 ? 1900+yy : 2000+yy  (series 1999-2004)
   - empty year -> extract ((19|20)dd)年 from name (定制茶系列 embeds it)
   - '60/70' decade -> 1965 with year_note
3. dedup 改制前老茶 two sheets: sheet without "(2)" is authoritative
   (fuller 499 vs 483; price diffs trend sheet1 higher = fresher snapshot);
   price conflicts logged for expert review
4. numeric coercion for price fields, has_price flag
5. snapshot_date: only 大益新茶分析 has in-sheet date (行情截止2025年12月23日)
6. search_text: name + year + form + category + note (retrieval key)
"""
import json
import re
import unicodedata

SRC = "/Users/kjonekong/Documents/puer-ai/rag/sku-records.jsonl"
OUT = "/Users/kjonekong/Documents/puer-ai/rag/sku-clean.jsonl"
REPORT = "/Users/kjonekong/Documents/puer-ai/rag/sku-cleaning-report.txt"

PRICE_FIELDS = ["market_price_per_jian", "market_price", "buyback_price",
                "alloc_price", "estimate", "market_high", "price_per_g"]

YEAR_2000S = {"06年之前大益熟茶统计_副本.xlsx"}
YEAR_1900S = {"改制前老茶-全.xlsx"}

def has_cjk(s):
    return any("CJK" in unicodedata.name(ch, "") for ch in s)

BATCH_MARK = re.compile(r"^\d{3}\s*\d{3,4}$")  # "401 7592" = 批次+唛号, real SKU w/o CJK

def is_real_name(s):
    s = s.strip()
    return bool(has_cjk(s) or BATCH_MARK.match(s))

def to_num(v):
    if v in (None, ""):
        return None
    s = str(v).replace(",", "").replace("，", "").replace(" ", "")
    try:
        f = float(s)
        return int(f) if f == int(f) else round(f, 2)
    except ValueError:
        return None

def norm_year(rec):
    """return (year_int or None, year_raw, note)"""
    y = rec.get("year", "").strip()
    src = rec["source_file"]
    if "/" in y:  # decade notation like 60/70
        nums = [int(n) for n in re.findall(r"\d{2}", y)]
        return 1900 + nums[0], y, f"{y}年代区间,取首值"
    if y.isdigit() and len(y) == 2:
        v = int(y)
        if src in YEAR_2000S:
            return 2000 + v, y, ""
        if src in YEAR_1900S:
            return 1900 + v, y, ""
        return (1900 + v) if v >= 99 else (2000 + v), y, ""
    if y.isdigit() and len(y) == 4:
        return int(y), y, ""
    # empty or garbage: mine the name ("2002年…" preferred, else "2001班章…")
    m = re.search(r"((?:19|20)\d{2})\s*年", rec.get("name", "")) \
        or re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", rec.get("name", ""))
    if m:
        return int(m.group(1)), y, "年份抽自品名"
    return None, y, "年份缺失"

def main():
    rows = [json.loads(l) for l in open(SRC, encoding="utf-8")]
    report = []

    # 1. drop garbage (calc residue / fill sequences; keep batch+mark names)
    kept = [r for r in rows if is_real_name(r.get("name", ""))]
    report.append(f"drop garbage rows: {len(rows) - len(kept)}")

    # 2-3. split 改制前 dual sheets, sheet1 authoritative
    main_rows, dup_rows, others = [], [], []
    for r in kept:
        if r["source_file"] == "改制前老茶-全.xlsx":
            (dup_rows if r["sheet"].endswith("(2)") else main_rows).append(r)
        else:
            others.append(r)

    def key(r):
        return (r.get("name", ""), r.get("year", ""), r.get("lot", ""))

    main_keys = {key(r) for r in main_rows}
    # intra-sheet exact dup (identical mapped values)
    seen_exact, main_dedup = set(), []
    for r in main_rows:
        sig = json.dumps({k: v for k, v in r.items()}, sort_keys=True, ensure_ascii=False)
        if sig in seen_exact:
            continue
        seen_exact.add(sig)
        main_dedup.append(r)
    report.append(f"改制前 intra-sheet exact dups removed: {len(main_rows) - len(main_dedup)}")

    main_map = {}
    for r in main_dedup:
        main_map.setdefault(key(r), r)

    uniq_from_dup, conflicts = [], []
    for r in dup_rows:
        k = key(r)
        if k in main_map:
            m = main_map[k]
            p_dup = next((r.get(f) for f in PRICE_FIELDS if r.get(f)), None)
            p_main = next((m.get(f) for f in PRICE_FIELDS if m.get(f)), None)
            if p_dup and p_main and to_num(p_dup) != to_num(p_main):
                conflicts.append((k, p_main, p_dup))
        else:
            uniq_from_dup.append(r)
    report.append(f"改制前 dual-sheet: main {len(main_dedup)}, dup-sheet uniques kept {len(uniq_from_dup)}, "
                  f"price conflicts (main wins, logged): {len(conflicts)}")

    all_rows = others + main_dedup + uniq_from_dup

    # 4-6. build clean records
    out, no_year, no_price = [], [], []
    for r in all_rows:
        year_int, year_raw, ynote = norm_year(r)
        rec = {"name": r["name"].strip(), "year": year_int, "year_raw": year_raw,
               "form": r.get("form", ""), "category": r.get("category", ""),
               "raw_or_ripe": r.get("raw_or_ripe", ""), "spec_g": to_num(r.get("spec_g")),
               "pcs_per_jian": to_num(r.get("pcs_per_jian")) or to_num(r.get("pcs_per_jian2")),
               "lot": r.get("lot", ""), "note": r.get("note", ""), "year_note": ynote,
               "source_file": r["source_file"], "sheet": r["sheet"], "row": r["row"]}
        for f in PRICE_FIELDS:
            n = to_num(r.get(f))
            if n is not None:
                rec[f] = n
        rec["has_price"] = any(rec.get(f) for f in PRICE_FIELDS if f != "price_per_g") or bool(rec.get("price_per_g"))
        rec["snapshot_date"] = "2025-12-23" if r["source_file"] == "大益新茶分析.xlsx" else None
        rec["search_text"] = " ".join(str(x) for x in
                                      [rec["name"], rec["year"], rec["form"], rec["category"], rec["note"]] if x)
        out.append(rec)
        if year_int is None:
            no_year.append(rec["name"])
        if not rec["has_price"]:
            no_price.append(rec["name"])

    with open(OUT, "w", encoding="utf-8") as f:
        for rec in out:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    years = [rec["year"] for rec in out if rec["year"]]
    report += [
        f"TOTAL clean records: {len(out)} (from {len(rows)})",
        f"year range: {min(years)}-{max(years)}, missing year: {len(no_year)}",
        f"missing any price: {len(no_price)}",
        "",
        "== price conflicts (authoritative sheet first) ==",
    ] + [f"  {k[0]} {k[1]}: {a} vs {b}" for k, a, b in conflicts] + [
        "", "== missing-year names ==",
    ] + [f"  {n}" for n in no_year[:10]]

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    print("\n".join(report))

if __name__ == "__main__":
    main()
