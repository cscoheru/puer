#!/usr/bin/env python3
"""Build an interactive image-candidate gallery for E-class eval questions.

Reads /tmp/tea-notes-sample.json (60 image-rich notes pulled from puer-hub DB),
renders eval/image-candidates/index.html with public puer.im URLs.
Click an image to toggle selection; button copies selected list (numbered).
"""
import json
import html
import os

SRC = "/tmp/tea-notes-sample.json"
OUT_DIR = "/Users/kjonekong/Documents/puer-ai/eval/image-candidates"
os.makedirs(OUT_DIR, exist_ok=True)
notes = json.load(open(SRC))

MAX_PER_NOTE = 8
counter = 0
blocks = []
for n in notes:
    imgs = [i for i in n["images"] if isinstance(i, str) and i.startswith("/uploads/")][:MAX_PER_NOTE]
    if not imgs:
        continue
    cells = []
    for p in imgs:
        counter += 1
        tag = f"N{counter:03d}"
        cells.append(
            f'<figure class="cell" data-tag="{tag}" data-note="{html.escape(n["title"])}" onclick="toggle(this)">'
            f'<img loading="lazy" src="https://puer.im{html.escape(p)}">'
            f'<figcaption>{tag} · {os.path.basename(p)[:12]}…</figcaption></figure>'
        )
    blocks.append(
        f'<section><h3>{html.escape(n["title"] or "(无标题)")}</h3>'
        f'<div class="grid">{"".join(cells)}</div></section>'
    )

page = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>E 类图片题 · 候选图集</title>
<style>
 body{font-family:-apple-system,"PingFang SC",sans-serif;background:#111;color:#ddd;margin:0;padding:20px}
 h1{font-size:20px} .hint{color:#8bc34a;background:#1c2b1c;padding:10px;border-radius:8px;line-height:1.7}
 section{margin-top:28px} h3{font-size:15px;color:#ffd54f;margin:8px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
 figure{margin:0;background:#1b1b1b;border-radius:8px;overflow:hidden;cursor:pointer;border:3px solid transparent}
 figure.sel{border-color:#4caf50;background:#1c2b1c}
 img{width:100%;height:180px;object-fit:cover;display:block}
 figcaption{font-size:11px;padding:4px 6px;color:#999}
 #bar{position:fixed;bottom:0;left:0;right:0;background:#000c;padding:10px 20px;display:flex;gap:12px;align-items:center}
 button{padding:8px 16px;border-radius:6px;border:0;background:#4caf50;color:#000;font-weight:600;cursor:pointer}
 #n{color:#4caf50}
</style></head><body>
<h1>E 类图片题 · 候选图集(茶记抽样 {NOTES} 条 / {TOTAL} 图)</h1>
<div class="hint">用法:点击图片选中/取消(绿框)。选完点「复制已选」,把粘贴板内容发给 Claude,并注明每张的类别(汤色/叶底/饼面/饼背/版面/内飞/其他)。<br>
本次目标:汤色≥6(要深浅/清浊各异)、叶底≥4、饼面或饼背≥4、其他可用作综合题(E12-E14)的组图。<br>
注:版面/内飞特写在茶记里可能很少,缺的部分将来用你的实拍补。</div>
{BLOCKS}
<div id="bar"><button onclick="copySel()">复制已选</button><span>已选 <b id="n">0</b> 张</span></div>
<script>
const sel=[];
function toggle(f){const t=f.dataset.tag;const i=sel.findIndex(x=>x.tag===t);
 if(i>=0){sel.splice(i,1);f.classList.remove('sel')}else{sel.push({tag:t,note:f.dataset.note});f.classList.add('sel')}
 document.getElementById('n').textContent=sel.length}
function copySel(){navigator.clipboard.writeText(sel.map(x=>x.tag+' | '+x.note).join('\\n'));
 alert('已复制 '+sel.length+' 条,粘贴给 Claude 即可')}
</script></body></html>"""

page = page.replace("{NOTES}", str(len(notes))).replace("{TOTAL}", str(counter)).replace("{BLOCKS}", "\n".join(blocks))
out = f"{OUT_DIR}/index.html"
open(out, "w", encoding="utf-8").write(page)
print(f"wrote {out}: {len(notes)} notes, {counter} images")
