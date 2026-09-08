#!/usr/bin/env python3
"""Batch-2: parse expert annotations from the vault canonical table.

Cross-refs each row with review-queue-b2-canonical-200.jsonl by URL.
Outputs review-queue-b2-final.jsonl:
  status=approved  -> final_label = teacher_label
  status=reviewed  -> expert_correction filled; final_label applied below
Only reviewed rows' final labels are constructed here; the 184 approved rows
keep teacher_label verbatim.
"""
import json
import re

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
VAULT = "/Users/kjonekong/Documents/Obsidian Vault/硅谷创新-QLoRA调优/教师预标注批注表-b2-200张-canonical.md"
CANON = f"{BASE}/review-queue-b2-canonical-200.jsonl"
OUT = f"{BASE}/review-queue-b2-final.jsonl"

# url -> canonical record (teacher_label, note_title)
canon = {}
for l in open(CANON, encoding="utf-8"):
    r = json.loads(l)
    canon[r["url"]] = r

def parse_table(md_text):
    """yield (url, annotation) from the markdown table rows."""
    for line in md_text.splitlines():
        line = line.strip()
        if not line.startswith("|") or line.startswith("| 序号") or set(line) <= set("|- "):
            continue
        # split on pipes NOT preceded by backslash
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", line)]
        # cells[0] empty (leading |), then 序号,图片,标题,教师标签,批注,trailing empty
        cells = [c for c in cells]
        if len(cells) < 6:
            continue
        try:
            int(cells[1])
        except ValueError:
            continue
        img_cell, annot = cells[2], cells[5]
        m = re.search(r"\]\((https://puer\.im(/uploads/[^\s)]+))\)", img_cell)
        if not m:
            continue
        yield m.group(2), annot.replace("\\|", "|")

# explicit final labels for the 16 reviewed rows (constructed from teacher
# sentence + expert color term; shallowest term chosen for multi-option).
FINAL = {
    "/uploads/evernote/8a8de3600d25.jpg": "汤色 | 白瓷品茗杯中茶汤呈深栗色，明亮。",
    "/uploads/evernote/4bb437087b37.jpg": "汤色 | 深橙色，明亮。",
    "/uploads/evernote/6fbcfbe83149.jpg": "汤色 | 品茗杯中盛有橙红色茶汤，表面可见明显黑色絮状悬浮物。",
    "/uploads/evernote/76e27045efa0.jpg": "版面 | 白色包装纸印有红色书法大字及红黄绿配色的山水图案，标注有“弯弓公社”、“80”周年标识及“普洱茶（生茶）净含量50克”字样。",
    "/uploads/evernote/d75bbbd6b7d3.jpg": "汤色 | 品茗杯中盛有橙红明亮的茶汤，杯底可见黑色茶屑沉淀。",
    "/uploads/evernote/0dd2a6641a7f.jpg": "汤色 | 玻璃锤纹杯中茶汤呈浅黄绿色，明亮。",
    "/uploads/evernote/767f21b5ee30.jpg": "汤色 | 白瓷品茗杯中茶汤呈酱油色，明亮。",
    "/uploads/evernote/037bb8090755.jpg": "汤色 | 玻璃公道杯中茶汤呈深橙红色，明亮。",
    "/uploads/evernote/44b5be7f09c7.jpg": "汤色 | 盛于青花品茗杯中，茶汤呈深橙红色，明亮，可见少量悬浮微粒。",
    "/uploads/evernote/8ab62720d25a.jpg": "汤色 | 白瓷品茗杯中盛有橙红色茶汤，汤面明亮。",
    "/uploads/evernote/af1d85d27002.jpg": "汤色 | 玻璃公道杯中盛有深橙红色明亮的茶汤，杯身印有大益茶红色标识。",
    "/uploads/evernote/f0c23851068f.jpg": "汤色 | 白瓷品茗杯中茶汤呈深橙红色，表面及中央有细密气泡，汤中可见悬浮碎屑。",
    "/uploads/evernote/6c3549a0dc59.jpg": "汤色 | 玻璃公道杯中盛有暗褐色明亮的茶汤，旁置一把紫砂壶。",
    "/uploads/evernote/ce11baca5c12.jpg": "汤色 | 玻璃公道杯中茶汤呈橙红色，明亮，液面有细密泡沫。",
    "/uploads/evernote/6a56a0049b25.jpg": "汤色 | 玻璃公道杯中盛有橙红色茶汤，清澈透亮。",
}
# 2003-下关飞台小铁饼 (row 104) deep-orange-red dry raw
FINAL["/uploads/evernote/5d4dabc6bba8.jpg"] = "汤色 | 玻璃公道杯中茶汤呈深橙红色，明亮。"

def main():
    md = open(VAULT, encoding="utf-8").read()
    n_approved = n_reviewed = 0
    missing_final = []
    with open(OUT, "w", encoding="utf-8") as f:
        for url, annot in parse_table(md):
            if url not in canon:
                print(f"!! url not in canonical: {url}")
                continue
            r = canon[url]
            annot = annot.strip()
            reviewed = bool(annot)
            if reviewed:
                n_reviewed += 1
                final = FINAL.get(url, "")
                if not final:
                    missing_final.append((url, annot))
            else:
                n_approved += 1
                final = r["teacher_label"]
            f.write(json.dumps({
                "url": url, "note_title": r["note_title"],
                "teacher_label": r["teacher_label"],
                "expert_correction": annot,
                "status": "reviewed" if reviewed else "approved",
                "final_label": final,
            }, ensure_ascii=False) + "\n")
    total = n_approved + n_reviewed
    print(f"parsed {total} rows | approved {n_approved} | reviewed {n_reviewed} "
          f"({n_reviewed*100//max(total,1)}%)")
    if missing_final:
        print("REVIEWED rows WITHOUT a constructed final label:")
        for u, a in missing_final:
            print(f"  {u}  批注: {a}")

if __name__ == "__main__":
    main()
