#!/usr/bin/env python3
"""M3-lite step 2: extract text from all PDFs -> knowledge chunks (jsonl).

- pypdf page-by-page extraction, resumable (skips files already done)
- cleanup: join hard-wrapped lines, strip page numbers / watermarks
- chunking: ~600 chars with 100 overlap, provenance = file + page range
"""
import glob
import json
import os
import re
import sys
from pypdf import PdfReader

SRC = "/Users/kjonekong/Documents/个人/公众号/普洱茶rag素材"
OUT = "/Users/kjonekong/Documents/puer-ai/rag/knowledge-chunks.jsonl"
STATE = "/Users/kjonekong/Documents/puer-ai/rag/pdf-extract-state.json"

CHUNK = 600
OVERLAP = 100

def clean(text):
    if not text:
        return ""
    t = text.replace("　", " ")
    # join hard-wrapped CJK lines (line ends w/o punctuation, next starts CJK)
    t = re.sub(r"([^\n。！？；：”」』])\n([^\n\d])", r"\1\2", t)
    # page numbers / standalone digits lines
    t = re.sub(r"\n\s*\d{1,3}\s*\n", "\n", t)
    # collapse whitespace
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()

def chunk_text(t, src, first_page, page_at):
    out = []
    i = 0
    while i < len(t):
        piece = t[i:i + CHUNK]
        if len(piece.strip()) > 50:  # skip tiny fragments
            last_page = page_at(min(i + CHUNK, len(t) - 1))
            out.append({"source": src, "pages": f"{first_page}-{last_page}",
                        "text": piece.strip()})
        i += CHUNK - OVERLAP
    return out

def main():
    state = {"done": {}}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    pdfs = sorted(glob.glob(f"{SRC}/**/*.pdf", recursive=True))
    todo = [p for p in pdfs if os.path.relpath(p, SRC) not in state["done"]]
    print(f"pdfs total {len(pdfs)}, todo {len(todo)}", flush=True)
    f = open(OUT, "a", encoding="utf-8")
    for n, path in enumerate(todo, 1):
        rel = os.path.relpath(path, SRC)
        try:
            reader = PdfReader(path)
            pages_text = []
            for pno, page in enumerate(reader.pages, 1):
                try:
                    pages_text.append((pno, page.extract_text() or ""))
                except Exception:
                    pages_text.append((pno, ""))
            full = ""
            page_map = []  # char offset -> page no
            for pno, txt in pages_text:
                c = clean(txt)
                page_map.extend([pno] * (len(full) + len(c) + 1 - len(page_map)))
                full += c + "\n"
            chunks = chunk_text(full, rel, pages_text[0][0] if pages_text else 1,
                                lambda o: page_map[o] if 0 <= o < len(page_map)
                                else (pages_text[-1][0] if pages_text else 1))
            for ch in chunks:
                f.write(json.dumps(ch, ensure_ascii=False) + "\n")
            f.flush()
            state["done"][rel] = len(chunks)
            if n % 10 == 0 or n == len(todo):
                json.dump(state, open(STATE, "w"))
                print(f"[{n}/{len(todo)}] {rel[:40]} -> {len(chunks)} chunks", flush=True)
        except Exception as e:
            state["done"][rel] = f"ERROR {str(e)[:80]}"
            print(f"!! {rel[:40]}: {e}", flush=True)
    json.dump(state, open(STATE, "w"))
    f.close()
    ok = sum(1 for v in state["done"].values() if isinstance(v, int))
    err = sum(1 for v in state["done"].values() if isinstance(v, str))
    print(f"DONE ok={ok} err={err}")

if __name__ == "__main__":
    main()
