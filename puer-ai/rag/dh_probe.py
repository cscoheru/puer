#!/usr/bin/env python3
"""Probe tweb.donghenet.com with a real Chromium (Playwright) to see which
API calls the app makes unauthenticated and whether responses pass the WAF."""
import json
import time
from playwright.sync_api import sync_playwright

CAPTURED = []

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
            viewport={"width": 390, "height": 844})
        page = ctx.new_page()

        def on_response(resp):
            url = resp.url
            if "/api/" in url:
                try:
                    body = resp.text()[:300]
                except Exception:
                    body = "(binary)"
                CAPTURED.append({"url": url, "status": resp.status, "body": body})

        page.on("response", on_response)
        page.goto("https://tweb.donghenet.com/#/", wait_until="networkidle", timeout=60000)
        time.sleep(3)
        # try scrolling the home page to trigger lazy market lists
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(4)
        print("=== captured", len(CAPTURED), "api calls ===")
        for c in CAPTURED[:20]:
            print(c["status"], c["url"][:110])
            print("   ", c["body"][:140].replace("\n", " "))
        browser.close()
    with open("/tmp/dh-probe.json", "w") as f:
        json.dump(CAPTURED, f, ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
