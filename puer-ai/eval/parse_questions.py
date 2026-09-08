#!/usr/bin/env python3
"""Parse questions-v0.md (expert-reviewed v0.2) into machine-readable JSONL.

Each row: {id, category, question, key}
`key` = AI draft points + expert annotation merged (the scoring standard).
"""
import json
import re
import sys

SRC = "/Users/kjonekong/Documents/puer-ai/eval/questions-v0.md"
OUT = "/Users/kjonekong/Documents/puer-ai/eval/questions.jsonl"

text = open(SRC, encoding="utf-8").read()

# Split by category sections
sections = re.split(r"^## ([A-E])\. ", text, flags=re.M)
# sections: [preamble, 'A', body, 'B', body, ...]
rows = []
for i in range(1, len(sections), 2):
    cat = sections[i]
    body = sections[i + 1]
    if cat == "E":
        continue  # image questions: not runnable yet
    # Questions start with **A1. ...**
    for m in re.finditer(r"^\*\*([A-D]\d+)\. (.+?)\*\*\s*$", body, flags=re.M):
        qid, qtext = m.group(1), m.group(2).strip()
        # Key = everything until the next question header (or section end)
        start = m.end()
        nxt = re.search(r"^\*\*[A-D]\d+\. ", body[start:], flags=re.M)
        end = start + nxt.start() if nxt else len(body)
        chunk = body[start:end].strip()
        # Drop trailing section separators / headers
        chunk = re.split(r"^---$", chunk, flags=re.M)[0].strip()
        # Normalize annotation markers
        key = chunk
        rows.append({"id": qid, "category": cat, "question": qtext, "key": key})

with open(OUT, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print(f"parsed {len(rows)} questions -> {OUT}")
from collections import Counter
print(Counter(r["category"] for r in rows))
