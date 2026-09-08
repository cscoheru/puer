#!/usr/bin/env python3
"""Run the RAG pipeline over the knowledge-heavy eval questions.

E-class (image): E1, E8, E8b, E14 — question text/images mirrored from
eval/run_images.py. A-class (text-only): A1-A3 from eval/questions.jsonl.
Also generates a no-retrieval baseline with the SAME provider, so the only
variable between the two answer columns is RAG itself.

E8/E8b get automatic element scoring against the known ground truth
(E8: 勐海/7572/熟茶/2003 黄印7572; E8b: 勐海/2002/紫大益7572).

Output: rag-eval.jsonl (append + resume by id). Usage:
  python3 run_rag_eval.py [--provider glm] [--no-embed] [--only E8,E8b]
"""
import argparse
import json
import os
import time

import teacher_api
from rag_pipeline import answer_question, SYSTEM_NO_EVIDENCE

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rag-eval.jsonl")
EVAL_IMAGES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval", "images")
QUESTIONS_JSONL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval", "questions.jsonl")

# (id, image tags, question) — mirrored from eval/run_images.py QUESTIONS
E_QUESTIONS = [
    ("E1", ["N249"], "描述这杯茶汤的颜色(术语专业),并估计一款干仓存放生茶的陈期区间。"),
    ("E8", ["N009"], "识别这饼茶的厂家、唛号与大致年代,并说明依据。"),
    ("E8b", ["N343"], "识别这饼茶的厂家、唛号与大致年代,并说明依据。"),
    ("E14", ["N250", "N132", "N299"], "这三杯均为干仓存放的生茶茶汤。按陈期从短到长排序,并说明理由。"),
]

# ground-truth elements for automatic scoring (substring match on the answer)
AUTO_CHECK = {
    "E8": {"勐海": "厂家", "7572": "唛号", "熟茶": "生熟", "2003": "年代"},
    "E8b": {"勐海": "厂家", "7572": "唛号", "2002": "年代", "紫": "紫大益特征"},
}


def load_a_questions():
    rows = []
    for l in open(QUESTIONS_JSONL, encoding="utf-8"):
        r = json.loads(l)
        if r["id"] in ("A1", "A2", "A3"):
            rows.append((r["id"], [], r["question"]))
    return sorted(rows)


def auto_score(qid, answer):
    checks = AUTO_CHECK.get(qid)
    if not checks:
        return None
    detail = {f"{elem}({label})": (elem in answer) for elem, label in checks.items()}
    return {"score": sum(detail.values()), "max": len(checks), "detail": detail}


def ask_baseline(question, image_paths, provider):
    """Same provider, same images, NO retrieval — pure VLM/QA baseline."""
    if image_paths:
        prompt = (question + "\n(先自行读图获取线索,再作答;不确定处明确说明)")
    else:
        prompt = question
    return teacher_api.ask(prompt, images=image_paths or None,
                           system=SYSTEM_NO_EVIDENCE.replace("本次没有检索到相关资料。\n", ""),
                           max_tokens=3000, provider=provider)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="glm")
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated ids, e.g. E8,E8b")
    ap.add_argument("--skip-baseline", action="store_true")
    args = ap.parse_args()

    only = {x for x in args.only.split(",") if x}
    todo = [q for q in E_QUESTIONS + load_a_questions() if not only or q[0] in only]

    done = set()
    if os.path.exists(OUT):
        for l in open(OUT, encoding="utf-8"):
            try:
                r = json.loads(l)
                if r.get("answer"):
                    done.add(r["id"])
            except Exception:
                pass

    teacher_api.set_provider(args.provider)
    with open(OUT, "a", encoding="utf-8") as f:
        for qid, tags, qtext in todo:
            if qid in done:
                print(f"{qid}: cached, skip")
                continue
            imgs = [f"{EVAL_IMAGES}/{t}.jpg" for t in tags]
            t0 = time.time()
            out = answer_question(qtext, image_paths=imgs or None, use_embed=not args.no_embed)
            out.update({"id": qid, "model": teacher_api.provider_model(), "secs": round(time.time() - t0, 1)})
            if not args.skip_baseline:
                out["baseline_answer"] = ask_baseline(qtext, imgs, args.provider)
            out["auto_score"] = auto_score(qid, out["answer"])
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
            f.flush()
            sc = out["auto_score"]
            sc_s = f" auto={sc['score']}/{sc['max']}" if sc else ""
            print(f"{qid}: {out['secs']}s hits={out['n_hits']} conf={out['confidence']}{sc_s}")
            time.sleep(2)
    print("done ->", OUT)


if __name__ == "__main__":
    main()
