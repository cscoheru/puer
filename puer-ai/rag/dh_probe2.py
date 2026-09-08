#!/usr/bin/env python3
"""Probe 2: inside a real browser, call the discovered public APIs directly
(fetch inherits the browser TLS fingerprint that passes the WAF) and dump
one full SKU record + a keyword search for 7542 + a detail-page probe."""
import json
import time
from playwright.sync_api import sync_playwright

JS_FETCH = """
async (url) => {
  const r = await fetch(url, {headers: {'accept': 'application/json'}});
  return {status: r.status, text: await r.text()};
}
"""

def grab(page, url):
    out = page.evaluate(JS_FETCH, url)
    try:
        return out["status"], json.loads(out["text"])
    except json.JSONDecodeError:
        return out["status"], out["text"][:200]

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
        page.goto("https://tweb.donghenet.com/#/", wait_until="networkidle", timeout=60000)
        time.sleep(2)

        base = "https://api.donghenet.com/api"

        # 1) market list page 1 — dump one full record
        st, data = grab(page, f"{base}/search/traditionSearch/searchMarketPage?skuYear=&attrs=&skuPrice=&pageNum=1&pageSize=10")
        print(f"searchMarketPage -> {st}")
        recs = data.get("data", {}).get("records") or data.get("data", {}).get("list") or []
        if not recs and isinstance(data.get("data"), dict):
            print("data keys:", list(data["data"].keys())[:12])
        if recs:
            print("records:", len(recs), "total:", data["data"].get("total"))
            print("ONE RECORD:")
            print(json.dumps(recs[0], ensure_ascii=False, indent=1)[:900])

        # 2) keyword search 7542
        for kw_url in [
            f"{base}/search/traditionSearch/searchMarketPage?keyword=7542&pageNum=1&pageSize=10",
            f"{base}/search/traditionSearch/searchMarketPage?skuName=7542&pageNum=1&pageSize=10",
        ]:
            st, data = grab(page, kw_url)
            recs = data.get("data", {}).get("records") if isinstance(data, dict) else []
            print(f"\nkeyword-probe {kw_url.split('?')[1][:40]} -> {st}, total={data.get('data',{}).get('total') if isinstance(data,dict) else '?'}")
            if recs:
                print("first:", json.dumps(recs[0], ensure_ascii=False)[:300])
                break

        # 3) searchTop gave skuId earlier — probe a SKU detail endpoint
        st, data = grab(page, f"{base}/search/traditionSearch/searchTop?attrs=")
        tops = data.get("data") or [] if isinstance(data, dict) else []
        if tops:
            sid = tops[0].get("skuId")
            print(f"\nsearchTop[0]: skuId={sid} name={tops[0].get('skuName')} img={str(tops[0].get('skuImg'))[:70]}")
            for d_url in [f"{base}/product/sku/getSkuById?skuId={sid}",
                          f"{base}/product/sku/detail?skuId={sid}",
                          f"{base}/product/marketPrice/getBySkuId?skuId={sid}"]:
                st2, d2 = grab(page, d_url)
                ok = isinstance(d2, dict) and d2.get("code") == 200
                print(f"  {d_url.split('/api')[1][:55]} -> {st2} {'HIT' if ok else ''} {str(d2)[:100] if not ok else ''}")
                if ok:
                    print("  detail:", json.dumps(d2.get("data"), ensure_ascii=False)[:400])
                    break
        browser.close()

if __name__ == "__main__":
    main()
