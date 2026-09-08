#!/usr/bin/env python3
"""Crawl Donghe Tea (东和茶叶) full SKU market list via the public
searchMarketPage API, using a real Chromium (WAF passes browser TLS only).

Polite crawl: single page at a time, 1.5s gap, resume-safe (append+seen set).
Output: rag/donghe-skus.jsonl

Fields captured per SKU: skuId, skuName, skuImg (OSS original), brandImg,
skuPrice (live market price), lastMarketPrice, riseAndFall(+Ratio),
skuPriceSpec (unit), pmsSkuYear, marketPriceUpdatedAt.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = f"{HERE}/donghe-skus.jsonl"
PAGE_SIZE = 50
GAP = 1.5

JS = """async (url) => { const r = await fetch(url, {headers:{'accept':'application/json'}});
         return {s: r.status, t: await r.text()}; }"""


def grab(page, url):
    o = page.evaluate(JS, url)
    if o["s"] != 200:
        return None
    try:
        d = json.loads(o["t"])
        return d if d.get("code") == 200 else None
    except json.JSONDecodeError:
        return None


def main():
    seen = set()
    if os.path.exists(OUT):
        for l in open(OUT, encoding="utf-8"):
            try:
                seen.add(str(json.loads(l)["skuId"]))
            except Exception:
                pass
        print(f"resume: {len(seen)} already saved")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_context().new_page()
        page.goto("https://tweb.donghenet.com/#/", wait_until="networkidle", timeout=90000)
        time.sleep(2)

        B = "https://api.donghenet.com/api/search/traditionSearch/searchMarketPage"
        first = grab(page, f"{B}?skuYear=&attrs=&skuPrice=&pageNum=1&pageSize={PAGE_SIZE}")
        if not first:
            print("FATAL: cannot reach API"); sys.exit(1)
        total = int(first["data"]["total"])
        pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
        print(f"total {total} SKUs across {pages} pages")

        n_new = 0
        fout = open(OUT, "a", encoding="utf-8")
        try:
            for p in range(1, pages + 1):
                d = first if p == 1 else grab(page, f"{B}?skuYear=&attrs=&skuPrice=&pageNum={p}&pageSize={PAGE_SIZE}")
                if not d:
                    print(f"page {p}: failed, retry once"); time.sleep(5)
                    d = grab(page, f"{B}?skuYear=&attrs=&skuPrice=&pageNum={p}&pageSize={PAGE_SIZE}")
                    if not d:
                        print(f"page {p}: still failing, abort"); break
                for rec in d["data"]["products"]:
                    sid = str(rec.get("skuId"))
                    if sid in seen:
                        continue
                    seen.add(sid)
                    fout.write(json.dumps({
                        "skuId": sid,
                        "name": rec.get("skuName"),
                        "img": rec.get("skuImg"),
                        "brandImg": rec.get("brandImg"),
                        "price": rec.get("skuPrice"),
                        "lastPrice": rec.get("lastMarketPrice"),
                        "change": rec.get("riseAndFall"),
                        "changeRatio": rec.get("riseAndFallRatio"),
                        "unit": rec.get("skuPriceSpec"),
                        "year": rec.get("pmsSkuYear"),
                        "priceUpdatedAt": rec.get("marketPriceUpdatedAt"),
                        "source": "donghenet",
                    }, ensure_ascii=False) + "\n")
                    n_new += 1
                fout.flush()
                if p % 10 == 0 or p == pages:
                    print(f"page {p}/{pages} (+{n_new} new)")
                time.sleep(GAP)
        finally:
            fout.close()
            browser.close()
        print(f"DONE: +{n_new} new, total saved {len(seen)} -> {OUT}")


if __name__ == "__main__":
    main()
