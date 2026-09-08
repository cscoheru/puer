#!/usr/bin/env python3
"""M3-lite step 8: OCR the 3 image-only PDFs via qwen3.7-plus vision.

WeChat-chat screenshots + one photo dump -> render (pypdfium2) -> transcribe
-> chunk -> append to knowledge-chunks.jsonl. Serial (teacher busy with b2).
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
import pypdfium2 as pdfium
import requests

SESSION = requests.Session()
SESSION.trust_env = False

SRC = "/Users/kjonekong/Documents/个人/公众号/普洱茶rag素材"
RAG = "/Users/kjonekong/Documents/puer-ai/rag"
OUT = f"{RAG}/knowledge-chunks.jsonl"
RENDER = f"{RAG}/ocr-render"
STATE = f"{RAG}/ocr-state.json"

PDFS = [
    "熟茶之美/古树熟茶探讨/有关惠风熟茶的微信沟通探讨.pdf",
    "熟茶之美/古树熟茶探讨/有关风行熟茶的微信沟通探讨.pdf",
    "熟茶之美/小小盘点7月/图片1_20250719142208.pdf",
]

TOKEN = subprocess.run(
    ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
     "SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') FROM providers WHERE app_type='claude' AND name='百炼 Token Plan';"],
    capture_output=True, text=True).stdout.strip()

PROMPT = ("转录这张图片中的全部文字内容(聊天记录按发言顺序逐条转录,保留发言人名;"
          "若是海报/文章则转录正文)。只输出转录文本,不要总结、不要评论。")

def render(pdf_path):
    os.makedirs(RENDER, exist_ok=True)
    key = os.path.splitext(os.path.basename(pdf_path))[0]
    pdf = pdfium.PdfDocument(pdf_path)
    pages = []
    for i in range(len(pdf)):
        out = f"{RENDER}/{key}-p{i+1}.png"
        if not os.path.exists(out):
            bmp = pdf[i].render(scale=2.0)
            bmp.to_pil().save(out)
        pages.append(out)
    return pages

def ask(local):
    data = base64.b64encode(open(local, "rb").read()).decode()
    body = {"model": "qwen3.7-plus", "max_tokens": 6000,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
                {"type": "text", "text": PROMPT}]}]}
    for attempt in range(3):
        try:
            r = SESSION.post("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
                headers={"x-api-key": TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json=body, timeout=180)
            r.raise_for_status()
            ans = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
            if ans:
                return ans
        except Exception:
            pass
        time.sleep(5 * (attempt + 1))
    return ""

def chunk_text(t, src, loc, chunks):
    i = 0
    while i < len(t):
        piece = t[i:i + 600]
        if len(piece.strip()) > 50:
            chunks.append({"source": src, "pages": loc, "text": piece.strip()})
        i += 500

def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"done": {}}
    for rel in PDFS:
        if rel in state["done"]:
            continue
        pages = render(f"{SRC}/{rel}")
        texts = []
        for i, p in enumerate(pages, 1):
            print(f"{rel[-30:]} p{i}...", flush=True)
            t = ask(p)
            texts.append((i, t))
            time.sleep(1)
        full = "\n".join(f"[p{i}] {t}" for i, t in texts if t)
        full = re.sub(r"\n{2,}", "\n", full).strip()
        chunks = []
        if len(full) > 50:
            chunk_text(full, rel, f"p1-p{len(pages)}(OCR)", chunks)
        with open(OUT, "a", encoding="utf-8") as f:
            for c in chunks:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
        state["done"][rel] = {"chars": len(full), "chunks": len(chunks)}
        json.dump(state, open(STATE, "w"))
        print(f"{rel[-30:]}: {len(full)} chars -> {len(chunks)} chunks", flush=True)
    print("OCR DONE")

if __name__ == "__main__":
    main()
