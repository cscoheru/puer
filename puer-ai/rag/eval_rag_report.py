#!/usr/bin/env python3
"""Generate the side-by-side comparison report for the RAG eval.

Columns per question: 专家要点 | glm+RAG | glm 裸答(同端点无检索) | 学生v3(参考)
plus automatic element scoring for E8/E8b and an empty expert-scoring column.
Outputs rag-eval-report.md.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
RAG_EVAL = f"{HERE}/rag-eval.jsonl"
QUESTIONS = f"{HERE}/../eval/questions.jsonl"
STUDENT_V3 = f"{HERE}/../m2-artifacts/v3/student-e16.jsonl"
OUT = f"{HERE}/rag-eval-report.md"


def load_jsonl(path):
    try:
        return [json.loads(l) for l in open(path, encoding="utf-8")]
    except FileNotFoundError:
        return []


def clip(s, n=700):
    s = re.sub(r"<think>.*?</think>\s*", "", s or "", flags=re.S).strip()
    s = s.replace("|", "\\|").replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


def main():
    rows = {r["id"]: r for r in load_jsonl(RAG_EVAL)}
    keys = {r["id"]: r.get("key", "") for r in load_jsonl(QUESTIONS)}
    student = {r["id"]: r.get("answer", "") for r in load_jsonl(STUDENT_V3)}

    lines = ["# RAG 应答管线 eval 对照报告", ""]
    if rows:
        sample = next(iter(rows.values()))
        lines.append(f"> 生成端点:**{sample.get('model', '?')}**(教师 qwen3.7-plus 配额 2026-08-23 恢复后"
                     f" `python3 run_rag_eval.py --provider bailian` 重跑即可对照)。")
    lines.append("> 对照设计:同端点 glm 裸答 vs glm+RAG,唯一变量是检索;学生v3 仅作参考行。")
    lines.append("> E8/E8b 自动校验为正解要素命中(E8=勐海/7572/熟茶/2003,E8b=勐海/2002/紫/7572)。")
    lines.append("")

    auto_total, auto_max = 0, 0
    for qid in ["E1", "E8", "E8b", "E14", "A1", "A2", "A3"]:
        r = rows.get(qid)
        if not r:
            continue
        sc = r.get("auto_score")
        if sc:
            auto_total += sc["score"]
            auto_max += sc["max"]
        lines.append(f"## {qid}")
        lines.append("")
        lines.append(f"**问题**:{r['question']}")
        if keys.get(qid):
            lines.append(f"**专家要点**:{clip(keys[qid], 300)}")
        lines.append("")
        lines.append("| 列 | 内容 |")
        lines.append("| --- | --- |")
        sc_s = f"{sc['score']}/{sc['max']} " + " ".join(
            f"{'✓' if ok else '✗'}{k}" for k, ok in sc["detail"].items()) if sc else "—"
        lines.append(f"| 检索/置信/自动校验 | 命中{r['n_hits']}条,置信{r['confidence']},校验 {sc_s} |")
        lines.append(f"| **glm+RAG** | {clip(r['answer'])} |")
        lines.append(f"| glm 裸答(无检索) | {clip(r.get('baseline_answer', '(未生成)'))} |")
        if qid in student:
            lines.append(f"| 学生v3(参考,8B SFT) | {clip(student[qid])} |")
        cites = r.get("citations") or []
        lines.append(f"| 引用来源 | {'; '.join(c[:60] for c in cites) if cites else '(无)'} |")
        lines.append(f"| 专家打分 | (留空:__/4) |")
        lines.append("")

    lines.append("## 汇总")
    lines.append("")
    lines.append(f"- E8+E8b 自动校验合计:**{auto_total}/{auto_max}**")
    conf = [r["confidence"] for r in rows.values()]
    lines.append(f"- 置信分布:{ {c: conf.count(c) for c in set(conf)} }")
    lines.append(f"- 带引用回答:{sum(1 for r in rows.values() if r.get('citations'))}/{len(rows)}")
    lines.append("")
    lines.append("## 已知局限(本次 glm 端点)")
    lines.append("")
    lines.append("- glm-5.2 版面细读不稳定(同图多次调用结果漂移),E8/E8b 的 OCR 文字基本读不出 → "
                 "诚实降级为「证据不足」。教师 qwen3.7-plus 的 OCR 已在 ocr_image_pdfs.py 管线验证过,恢复后预期显著改善。")
    lines.append("- 该「读不清→拒绝编造」行为正是 grounding 铁律的设计目标:对照学生 v3 在 E8 上的「88青饼」幻觉。")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
