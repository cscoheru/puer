#!/usr/bin/env python3
"""Durable donghe snapshot reconciliation (W1-2).

Pulls the upstream quote list (search/traditionSearch/searchMarketPage — the
same endpoint the snapshot was exported from) and diffs it against the local
donghe-skus.jsonl by skuId. Read-only by default; --apply appends missing
metadata rows ONLY (images + vectors + visual-ids still need backfill_9505.py
style handling — the report marks any --apply'd skuId as INCOMPLETE until all
four layers exist, so lazy adds can't silently half-land again).

Known limitation (documented W1-2 finding): the quote list only covers the
quote-tea table. SKUs that live in the product DB without quotes (e.g. 9505
2501 金大益) are invisible here — check EXTRA_SKU_WATCHLIST below, verified via
item/detail/general/{id}.

Usage (host, no container needed):
  python3 sync_donghe.py            # dry-run report
  python3 sync_donghe.py --apply    # append missing rows to local jsonl (with backup)

Env: SKUS_PATH (default /opt/puer-hub/rag-data/donghe-skus.jsonl)
"""
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request
import ssl
try:
    import certifi
    ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    # Linux hosts carry a system CA bundle; macOS stdlib python often doesn't
    # (see memory: python-urllib-ssl-clash-proxy) — there certifi is required.
    ctx = ssl.create_default_context()

BASE = "https://api.donghenet.com/api"
LIST_EP = BASE + "/search/traditionSearch/searchMarketPage"
HDRS = {"User-Agent": "Mozilla/5.0", "Referer": "https://tweb.donghenet.com/"}
PAGE = 100
SLEEP = 0.25
# Product-DB SKUs with no quote row; detail endpoint fills their data.
EXTRA_SKU_WATCHLIST = ["9505"]


def pull_quote_list():
    rows, page = [], 1
    while True:
        # Full param set matters: without showType=0 the endpoint returns only
        # the attrs/facets envelope and zero records (verified server-side).
        q = urllib.parse.urlencode({"skuYear": "", "attrs": "", "skuPrice": "",
                                    "pageNum": page, "pageSize": PAGE,
                                    "brandId": "", "excludeBrandId": "",
                                    "sort": "", "skuType": "", "showType": "0"})
        req = urllib.request.Request(f"{LIST_EP}?{q}", headers=HDRS)
        d = json.load(urllib.request.urlopen(req, timeout=20, context=ctx))
        data = d.get("data") or {}
        recs = data.get("products") or data.get("records") or data.get("list") or []
        if not recs:
            break
        rows.extend(recs)
        total = int(data.get("total") or len(rows))
        if page * PAGE >= total:
            break
        page += 1
        time.sleep(SLEEP)
    # dedup by skuId, keep first
    seen, out = set(), []
    for r in rows:
        sid = str(r.get("skuId"))
        if sid not in seen:
            seen.add(sid)
            out.append(r)
    return out


def to_snapshot_row(r):
    """Map quote-list fields to the 12-field snapshot shape (audit mapping)."""
    return {
        "skuId": str(r["skuId"]),
        "name": r.get("skuName") or "",
        "img": r.get("skuImg") or "",
        "brandImg": r.get("brandImg") or "",
        "price": r.get("skuPrice") or 0.0,
        "lastPrice": r.get("lastMarketPrice") or 0.0,
        "change": r.get("riseAndFall") or 0.0,
        "changeRatio": r.get("riseAndFallRatio") or 0,
        "unit": r.get("skuPriceSpec") or ("件" if r.get("marketPriceSpecDisplay") else None),
        "year": str(r.get("pmsSkuYear") or ""),
        "priceUpdatedAt": r.get("marketPriceUpdatedAt") or "",
        "source": "donghenet",
    }


def main():
    apply = "--apply" in sys.argv
    skus_path = os.environ.get("SKUS_PATH",
                               "/opt/puer-hub/rag-data/donghe-skus.jsonl")
    local = {}
    for line in open(skus_path, encoding="utf-8"):
        r = json.loads(line)
        local[str(r["skuId"])] = r

    upstream = pull_quote_list()
    up_ids = {str(r["skuId"]) for r in upstream}
    lo_ids = set(local)

    missing = sorted(up_ids - lo_ids, key=int)
    # product-DB watchlist SKUs are intentionally outside the quote list —
    # reporting them as "REMOVED" invites accidental deletion of backfills
    removed = sorted(lo_ids - up_ids - set(EXTRA_SKU_WATCHLIST), key=int)
    # metadata drift on shared ids: name change is the risky one (brand anchors)
    renamed = []
    up_by_id = {str(r["skuId"]): r for r in upstream}
    for sid in up_ids & lo_ids:
        un = (up_by_id[sid].get("skuName") or "").strip()
        ln = (local[sid].get("name") or "").strip()
        if un and ln and un != ln:
            renamed.append((sid, ln, un))

    print(f"local={len(lo_ids)}  upstream={len(up_ids)}  "
          f"missing={len(missing)}  removed={len(removed)}  renamed={len(renamed)}")
    for sid in missing[:30]:
        print(f"  MISSING {sid}  {(up_by_id[sid].get('skuName') or '')!r}")
    for sid in removed[:30]:
        print(f"  REMOVED {sid}  {local[sid].get('name')!r}  "
              f"(deleted upstream? verify before dropping)")
    for sid, old, new in renamed[:30]:
        print(f"  RENAMED {sid}  {old!r} -> {new!r}")
    for sid in EXTRA_SKU_WATCHLIST:
        state = "present" if sid in lo_ids else "ABSENT (product-db sku, backfill needed)"
        print(f"  WATCH {sid}: {state}")

    if missing and apply:
        b = skus_path + ".sync-backup"
        if not os.path.exists(b):
            shutil.copy2(skus_path, b)
            print("backup:", b)
        with open(skus_path, "a", encoding="utf-8") as f:
            for sid in missing:
                f.write(json.dumps(to_snapshot_row(up_by_id[sid]),
                                   ensure_ascii=False) + "\n")
        print(f"APPLIED {len(missing)} metadata rows — INCOMPLETE until images/"
              f"vectors/visual-ids are rebuilt for: {missing}")
    elif missing:
        print("dry-run: no writes (pass --apply to append missing metadata rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
