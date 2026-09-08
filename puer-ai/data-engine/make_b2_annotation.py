#!/usr/bin/env python3
"""Batch-2: build expert annotation table (vault md) from review-queue-b2.jsonl.

Run AFTER teacher_prelabel_b2.py completes. Same format as batch-1 table:
序号 | 图片链接 | 茶记标题(参考) | 教师标签 | 专家批注(空)
Vault file is write-once (AI 写一次,后续只读).
"""
import json
import os

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
QUEUE = f"{BASE}/review-queue-b2-canonical-200.jsonl"
VAULT = "/Users/kjonekong/Documents/Obsidian Vault/硅谷创新-QLoRA调优/教师预标注批注表-b2-200张-canonical.md"

def esc(s):
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()

def main():
    rows = [json.loads(l) for l in open(QUEUE, encoding="utf-8")]
    todo = [r for r in rows if r["status"] == "pending" and r["teacher_label"]]
    print(f"queue {len(rows)} rows, teacher-answered {len(todo)}")
    lines = [
        "# 教师预标注批注表 batch-2(200 张)",
        "",
        "> 生成于 2026-08-17。本批教师已注入行规约束(汤色宁浅勿深/透亮只公道杯/琥珀限干仓老生茶/器物行话),",
        "> 预计修正率应明显低于 batch-1 的 22%。**此文件 AI 只写一次,后续只读——你的批注不会被覆盖。**",
        "> 批法:教师标签对 → 批注格留空;错 → 写正确口径。「其他」类(环境/人物/器物)不用批。",
        "> 茶记标题仅参考,以图为准。",
        "",
        "| 序号 | 图片(点开核对) | 茶记标题(参考) | 教师标签 | 专家批注 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for i, r in enumerate(todo, 1):
        lines.append(f"| {i} | [图](https://puer.im{r['url']}) | {esc(r['note_title'])} "
                     f"| {esc(r['teacher_label'])} | |")
    content = "\n".join(lines) + "\n"
    with open(VAULT, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"wrote {len(todo)} rows -> {VAULT}")

if __name__ == "__main__":
    main()
