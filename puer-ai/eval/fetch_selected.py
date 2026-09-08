#!/usr/bin/env python3
"""Map user-selected gallery tags (N###) back to image URLs, download, and
build labeled contact sheets for vision classification."""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

SRC = "/tmp/tea-notes-sample.json"
MAX_PER_NOTE = 8  # must match make_gallery.py
OUT = "/tmp/puer-e-candidates"
os.makedirs(OUT, exist_ok=True)

SELECTED = """N009 N010 N011 N012 N028 N029 N030 N031 N034 N035 N127 N128 N129 N130 N131 N132 N134
N245 N246 N247 N248 N249 N250 N276 N277 N279 N280 N281 N282 N299 N301 N302 N303 N343 N344 N345 N346 N347 N348 N349 N351 N352 N365 N366 N367 N368""".split()

notes = json.load(open(SRC))
# reproduce gallery numbering
tag_map = {}  # tag -> (note_title, url)
counter = 0
for n in notes:
    imgs = [i for i in n["images"] if isinstance(i, str) and i.startswith("/uploads/")][:MAX_PER_NOTE]
    for p in imgs:
        counter += 1
        tag_map[f"N{counter:03d}"] = (n["title"] or "(无标题)", "https://puer.im" + p)

todo = [(t, *tag_map[t]) for t in SELECTED if t in tag_map]
print(f"mapped {len(todo)}/{len(SELECTED)} tags")

def fetch(item):
    tag, title, url = item
    path = f"{OUT}/{tag}.jpg"
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return (tag, title, path)
    r = subprocess.run(["/usr/bin/curl", "-s", "-o", path, url], timeout=60)
    ok = os.path.exists(path) and os.path.getsize(path) > 1000
    return (tag, title, path if ok else None)

with ThreadPoolExecutor(8) as ex:
    results = list(ex.map(fetch, todo))

ok = [r for r in results if r[2]]
bad = [r[0] for r in results if not r[2]]
print(f"downloaded {len(ok)}, failed {bad}")

# contact sheets: 12 per sheet, 4x3, cell 320x300 (img 320x260 + label)
CELL_W, CELL_H, IMG_H = 320, 300, 262
per_sheet = 12
for si in range(0, len(ok), per_sheet):
    chunk = ok[si:si + per_sheet]
    cols, rows = 4, 3
    sheet = Image.new("RGB", (CELL_W * cols, CELL_H * rows), (17, 17, 17))
    d = ImageDraw.Draw(sheet)
    for i, (tag, title, path) in enumerate(chunk):
        x, y = (i % cols) * CELL_W, (i // cols) * CELL_H
        try:
            im = Image.open(path).convert("RGB")
            im.thumbnail((CELL_W - 8, IMG_H))
            sheet.paste(im, (x + 4, y + 4))
        except Exception as e:
            d.text((x + 8, y + 100), f"{tag} load fail", fill=(255, 80, 80))
        d.text((x + 6, y + IMG_H + 6), f"{tag} {title[:16]}", fill=(255, 213, 79))
    out = f"{OUT}/sheet-{si // per_sheet + 1}.jpg"
    sheet.save(out, quality=82)
    print("sheet:", out, f"({len(chunk)} imgs)")
