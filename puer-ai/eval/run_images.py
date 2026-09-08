#!/usr/bin/env python3
"""Bare-run E-class image questions (identity-blind) against GLM-4.6V.

Models must NOT be told the SKU identity/year — that's what they're being tested on.
"""
import base64
import json
import os
import time
import requests
import subprocess

BASE = "/Users/kjonekong/Documents/puer-ai/eval"
IMG = f"{BASE}/images"

import sys
MODEL_KEY = sys.argv[1] if len(sys.argv) > 1 else "glm"
CFG = {
    "glm": {"model": "glm-4.6v", "url": "https://open.bigmodel.cn/api/anthropic/v1/messages",
            "provider": "智谱GLM"},
    "qwen-plus": {"model": "qwen3.7-plus", "url": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
            "provider": "百炼 Token Plan"},
    "qwen-max": {"model": "qwen3.8-max-preview", "url": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
            "provider": "百炼 Token Plan", "max_tokens": 8000},
}
TOKEN = subprocess.run(
    ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
     f"SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') FROM providers WHERE app_type='claude' AND name='{CFG[MODEL_KEY]['provider']}';"],
    capture_output=True, text=True).stdout.strip()

SYSTEM = "你是一位有二十年经验的普洱茶专家。请直接、简洁地回答,术语专业,不确定时明确说明。"

QUESTIONS = [
    ("E1", ["N249"], "描述这杯茶汤的颜色(术语专业),并估计一款干仓存放生茶的陈期区间。"),
    ("E2", ["N130", "N134"], "这是两杯茶汤(同一款茶)。哪一杯状态更好?说明判断理由。"),
    ("E3", ["N299"], "这杯茶汤的颜色是否正常?请判断茶品所处阶段,并说明依据。"),
    ("E4", ["N365"], "描述这个叶底的状态,并判断其工艺与仓储情况。"),
    ("E5", ["N301"], "根据叶底判断用料与采摘方式的大致口径,并明确说明不确定性。"),
    ("E6", ["N302"], "描述这个饼面的条索与色泽特征。"),
    ("E7", ["N344"], "这是茶饼背面。判断压制方式与松紧度,并描述饼窝特征。"),
    ("E8", ["N009"], "识别这饼茶的厂家、唛号与大致年代,并说明依据。"),
    ("E8b", ["N343"], "识别这饼茶的厂家、唛号与大致年代,并说明依据。"),
    ("E9", ["N348"], "描述图中内飞的鉴别要点(字体/版式特征)。"),
    ("E10", ["D8", "D5", "D3"], "解读图中的大票与内票:它们各承载什么信息?在防伪溯源链中的角色是什么?"),
    ("E11", ["N282", "N029"], "这是同一商标不同时期的两个版面。指出差异点,并判断哪一版更早、理由。"),
    ("E12", ["N299", "N301", "N303"], "综合这组汤色与叶底图,判断这款茶当前的仓储路径与转化状态。"),
    ("E13", ["N009"], "根据图片撰写一段 100 字左右的专业品鉴文案。"),
    ("E14", ["N250", "N132", "N299"], "这三杯均为干仓存放的生茶茶汤。按陈期从短到长排序,并说明理由。"),
    ("E15", ["N028"], "假设你要鉴别这饼茶的真伪,列出 3 个需要进一步核实的疑点。"),
]

def content(tags, qtext):
    blocks = []
    for t in tags:
        data = base64.b64encode(open(f"{IMG}/{t}.jpg", "rb").read()).decode()
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    blocks.append({"type": "text", "text": qtext})
    return blocks

out_path = f"{BASE}/results/{CFG[MODEL_KEY]['model']}/images-answers.jsonl"
os.makedirs(os.path.dirname(out_path), exist_ok=True)
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        try:
            r = json.loads(l)
            if r.get("answer") and not r.get("error"):
                done.add(r["id"])
        except Exception:
            pass

with open(out_path, "a", encoding="utf-8") as f:
    for qid, tags, qtext in QUESTIONS:
        if qid in done:
            continue
        body = {"model": CFG[MODEL_KEY]["model"], "max_tokens": CFG[MODEL_KEY].get("max_tokens", 4000), "system": SYSTEM,
                "messages": [{"role": "user", "content": content(tags, qtext)}]}
        ans, err = "", ""
        for attempt in range(3):
            try:
                r = requests.post(CFG[MODEL_KEY]["url"],
                    headers={"x-api-key": TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                    json=body, timeout=120)
                r.raise_for_status()
                ans = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
                if ans:
                    break
                err = "empty text"
            except Exception as e:
                err = str(e)[:150]
            time.sleep(3 * (attempt + 1))
        f.write(json.dumps({"id": qid, "images": tags, "answer": ans, "error": "" if ans else err}, ensure_ascii=False) + "\n")
        f.flush()
        print(f"{qid}: {'ok' if ans else 'ERR ' + err}")
print("done")
