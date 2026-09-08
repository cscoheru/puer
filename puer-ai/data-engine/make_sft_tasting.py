#!/usr/bin/env python3
"""M1-A: tasting notes -> SFT instruction pairs (style/writing tasks).

Output: sft-tasting.jsonl (messages format). Excludes (资料) reference notes
from the style task (encyclopedia style would contaminate the voice).
"""
import json
import re

SRC = "/Users/kjonekong/Documents/puer-ai/data-engine/tasting-notes-all.json"
OUT = "/Users/kjonekong/Documents/puer-ai/data-engine/sft-tasting.jsonl"

PLACEHOLDER = re.compile(r"\[附件[^\]]*\]")
TAG = re.compile(r"<[^>]+>")

def clean(html: str) -> str:
    t = PLACEHOLDER.sub("", html or "")
    t = TAG.sub("", t)
    lines = [l.strip() for l in t.split("\n")]
    return "\n".join(l for l in lines if l).strip()

def brew_line(n):
    parts = []
    if n.get("brewMethod"): parts.append(f"冲泡方式:{n['brewMethod']}")
    if n.get("waterTemp") is not None: parts.append(f"水温:{n['waterTemp']}℃")
    if n.get("teaWeight"): parts.append(f"投茶量:{n['teaWeight']}")
    if n.get("steepCount") is not None: parts.append(f"耐泡度:{n['steepCount']}")
    return ";".join(parts)

notes = json.load(open(SRC))
n_style = n_sum = 0
TASTING_KW = ("汤色", "香气", "滋味", "回甘", "叶底", "喉韵", "生津", "苦涩", "水路", "茶汤", "陈香", "仓味", "烟味", "甜润", "醇厚")
PROMO_KW = ("套餐", "外卖", "优惠", "促销", "加微信", "联系电话", "限时限量", "到店", "包邮", "秒杀")

def is_tasting(body: str) -> bool:
    if any(k in body for k in PROMO_KW):
        return False
    hits = sum(1 for k in TASTING_KW if k in body)
    if hits < 2:
        return False
    # repetition guard: first 40 chars re-appearing verbatim later = garbled/loop text
    head = body[:40]
    if len(head) == 40 and body.find(head, 41) != -1:
        return False
    return True

with open(OUT, "w", encoding="utf-8") as f:
    for n in notes:
        title = (n.get("title") or "").strip()
        body = clean(n.get("content") or "")
        if not title or title.startswith(("（资料）", "(资料)")):
            continue
        if len(body) < 120:
            continue
        if not is_tasting(body):
            continue
        meta = f'茶品:"{title}"' + (f",{brew_line(n)}" if brew_line(n) else "")
        # task 1: write a tasting record
        f.write(json.dumps({
            "task": "tasting_write",
            "messages": [
                {"role": "user", "content": f"你是资深普洱茶客。根据以下信息撰写一篇品鉴记录,要求术语专业、只陈述可感知的事实、不虚构:\n{meta}"},
                {"role": "assistant", "content": body},
            ],
        }, ensure_ascii=False) + "\n")
        n_style += 1
        # task 2: summarize
        s = (n.get("summary") or "").strip()
        if s and len(s) >= 10:
            f.write(json.dumps({
                "task": "summary",
                "messages": [
                    {"role": "user", "content": f"用一两句话概括这篇品鉴记录的要点:\n{body[:800]}"},
                    {"role": "assistant", "content": s},
                ],
            }, ensure_ascii=False) + "\n")
            n_sum += 1

print(f"style pairs: {n_style}, summary pairs: {n_sum}, total: {n_style + n_sum}")
