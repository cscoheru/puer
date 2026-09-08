#!/usr/bin/env python3
"""M3-lite step 6: docx/pptx/.doc ingestion -> knowledge chunks + embedded images.

- docx: python-docx paragraphs (+ tables); .doc: macOS textutil -> txt
- pptx: slide text (title/body/notes) — page field = slide range
- embedded images extracted to rag/extracted-media/<doc>/ and appended to
  ref-images.jsonl (identity = parent group, e.g. 熟茶之美/富华)
- same chunking as extract_pdfs.py (600 chars / 100 overlap)
- resumable via state file
"""
import glob
import json
import os
import re
import subprocess
import unicodedata
import zipfile

SRC = "/Users/kjonekong/Documents/个人/公众号/普洱茶rag素材"
RAG = "/Users/kjonekong/Documents/puer-ai/rag"
OUT = f"{RAG}/knowledge-chunks.jsonl"
REF = f"{RAG}/ref-images.jsonl"
MEDIA = f"{RAG}/extracted-media"
STATE = f"{RAG}/docx-extract-state.json"

CHUNK = 600
OVERLAP = 100
IMG_EXTS = {".jpeg", ".jpg", ".png", ".gif", ".webp", ".bmp"}

def nfkc(s):
    return unicodedata.normalize("NFKC", s) if s else ""

def chunk_text(t, src, loc, chunks):
    i = 0
    while i < len(t):
        piece = t[i:i + CHUNK]
        if len(piece.strip()) > 50:
            chunks.append({"source": src, "pages": loc, "text": piece.strip()})
        i += CHUNK - OVERLAP

def extract_docx_text(path):
    from docx import Document
    doc = Document(path)
    parts = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
    for tbl in doc.tables:
        for row in tbl.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)

def extract_doc_text(path):  # legacy .doc via macOS textutil
    out = subprocess.run(["textutil", "-convert", "txt", "-stdout", path],
                         capture_output=True, text=True).stdout
    return out or ""

def extract_pptx_text(path):
    from pptx import Presentation
    prs = Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        bits = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    t = "".join(run.text for run in para.runs).strip()
                    if t:
                        bits.append(t)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells if c.text.strip()]
                    if cells:
                        bits.append(" | ".join(cells))
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
                bits.append("[备注] " + slide.notes_slide.notes_text_frame.text.strip())
        except Exception:
            pass
        if bits:
            parts.append((i, "\n".join(bits)))
    return parts

def extract_media(path, doc_key, ref_rows):
    """pull embedded images from docx/pptx zips -> extracted-media/<doc_key>/"""
    n = 0
    try:
        zf = zipfile.ZipFile(path)
        for name in zf.namelist():
            ext = os.path.splitext(name)[1].lower()
            if ext not in IMG_EXTS:
                continue
            data = zf.read(name)
            if len(data) < 20000:  # skip tiny decorations/icons
                continue
            d = f"{MEDIA}/{doc_key}"
            os.makedirs(d, exist_ok=True)
            fname = os.path.basename(name)
            with open(f"{d}/{fname}", "wb") as f:
                f.write(data)
            ref_rows.append({"path": os.path.relpath(f"{d}/{fname}", RAG),
                             "group": doc_key.split("/")[0],
                             "identity": doc_key.replace("/", "-"),
                             "size_kb": len(data) // 1024})
            n += 1
    except Exception:
        pass
    return n

def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"done": {}}
    files = [p for p in sorted(glob.glob(f"{SRC}/**/*.doc*", recursive=True))
             + sorted(glob.glob(f"{SRC}/**/*.pptx", recursive=True))
             if not p.endswith(".DS_Store") and os.path.splitext(p)[1] in
             {".docx", ".doc", ".pptx"}]
    todo = [p for p in files if os.path.relpath(p, SRC) not in state["done"]]
    print(f"docs total {len(files)}, todo {len(todo)}", flush=True)

    fout = open(OUT, "a", encoding="utf-8")
    fref = open(REF, "a", encoding="utf-8")
    for n, path in enumerate(todo, 1):
        rel = os.path.relpath(path, SRC)
        doc_key = os.path.splitext(rel)[0]  # e.g. 熟茶之美/再谈7262/品01天福
        ext = os.path.splitext(path)[1]
        chunks, ref_rows = [], []
        try:
            if ext == ".docx":
                t = nfkc(extract_docx_text(path))
                t = re.sub(r"\n{2,}", "\n", t).strip()
                chunk_text(t, rel, "全文", chunks)
            elif ext == ".doc":
                t = nfkc(extract_doc_text(path))
                chunk_text(re.sub(r"\n{2,}", "\n", t).strip(), rel, "全文", chunks)
            elif ext == ".pptx":
                slides = extract_pptx_text(path)
                full = "\n".join(f"[幻灯{s}] {txt}" for s, txt in slides)
                full = nfkc(full)
                first = slides[0][0] if slides else 0
                last = slides[-1][0] if slides else 0
                chunk_text(full, rel, f"s{first}-s{last}" if slides else "空", chunks)
            n_img = extract_media(path, doc_key, ref_rows)
            for c in chunks:
                fout.write(json.dumps(c, ensure_ascii=False) + "\n")
            fout.flush()
            for r in ref_rows:
                fref.write(json.dumps(r, ensure_ascii=False) + "\n")
            fref.flush()
            state["done"][rel] = {"chunks": len(chunks), "images": n_img}
            print(f"[{n}/{len(todo)}] {rel[-40:]}: {len(chunks)} chunks, {n_img} imgs", flush=True)
        except Exception as e:
            state["done"][rel] = f"ERROR {str(e)[:80]}"
            print(f"!! {rel[-40:]}: {e}", flush=True)
    json.dump(state, open(STATE, "w"))
    fout.close()
    fref.close()
    print("DONE")

if __name__ == "__main__":
    main()
