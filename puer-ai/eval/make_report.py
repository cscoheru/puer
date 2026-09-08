#!/usr/bin/env python3
"""Assemble the expert review report: for each question, show the expert key
(AI draft + expert annotations) side-by-side with each model's answer.

Output: eval/review-report.md — designed for the expert to read top-down and
mark scores directly on the most interesting divergences.
"""
import json
import os

BASE = "/Users/kjonekong/Documents/puer-ai/eval"
MODELS = [
    ("glm5.3", "GLM-5.3"),
    ("deepseek", "DeepSeek V4-Flash"),
    ("kimi", "Kimi K2.7"),
]

questions = {json.loads(l)["id"]: json.loads(l) for l in open(f"{BASE}/questions.jsonl")}
answers = {}
for key, _label in MODELS:
    p = f"{BASE}/results/{key}/answers.jsonl"
    if os.path.exists(p):
        for l in open(p):
            try:
                r = json.loads(l)
                answers[(key, r["id"])] = r.get("answer") or f"[错误] {r.get('error','')}"
            except Exception:
                pass

lines = [
    "# 裸测评审报告(三模型 × 80 题)",
    "",
    "> 生成于跑批完成后。**评分方式:专家逐题对照要点打分(1/0.5/0)**。",
    "> 重点看「专家批注推翻 AI 原稿」的题目——那是最能反映垂直差距的题。",
    "",
    "| 模型 | 已回答 | 空/错误 |",
    "|---|---|---|",
]
for key, label in MODELS:
    got = [answers.get((key, qid)) for qid in questions]
    n_ok = sum(1 for a in got if a and not a.startswith("[错误]"))
    n_bad = sum(1 for a in got if not a or a.startswith("[错误]"))
    lines.append(f"| {label} | {n_ok}/80 | {n_bad} |")
lines.append("")

for qid in sorted(questions, key=lambda x: (x[0], int(x[1:]))):
    q = questions[qid]
    lines.append(f"---\n\n## {qid}. {q['question']}\n")
    lines.append(f"**专家要点(含批注)**:\n\n> {q['key'].strip()}\n")
    for key, label in MODELS:
        a = answers.get((key, qid), "*(未作答)*")
        a = a.replace("\n", "\n> ") if a else "*(空)*"
        lines.append(f"**{label}**:\n> {a}\n")

out = f"{BASE}/review-report.md"
open(out, "w", encoding="utf-8").write("\n".join(lines))
print(f"wrote {out}: {len(questions)} questions x {len(MODELS)} models")
