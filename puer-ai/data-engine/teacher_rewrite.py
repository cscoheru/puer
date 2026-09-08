#!/usr/bin/env python3
"""M1-C2: teacher (qwen3.7-plus) rewrites the 52 non-mechanical corrections under
expert style rules (incl. tangse baseline). Output is a v2 DRAFT for quick expert pass.
Resolves "同上" references to the previous sheet row's correction.
"""
import base64
import json
import os
import subprocess
import time
import requests

SESSION = requests.Session()
SESSION.trust_env = False

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
QUEUE = f"{BASE}/review-queue.jsonl"
RW = f"{BASE}/rewrite-queue.jsonl"
OUT = f"{BASE}/rewrite-drafts.jsonl"
CACHE = f"{BASE}/img-cache"

TOKEN = subprocess.run(
    ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
     "SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') FROM providers WHERE app_type='claude' AND name='百炼 Token Plan';"],
    capture_output=True, text=True).stdout.strip()

SYSTEM = """你是普洱茶图片编目助手,任务:按专家批注意见重写一条图片编目。只输出一行:类型 | 描述(一句话,含可验证细节)。

必须遵守的行规:
1. 颜色档位阶梯(干仓生茶):黄绿(新)→金黄→橙黄(5-10年)→橙/深橙(10-15年)→橙红(15-22年)→栗红/琥珀(20年+干仓)。贴图取档,宁浅勿深,严禁高报。
2. 透亮=清澈见底、透光性高,只有玻璃公道杯才能判断;品茗杯不说透亮只说明亮;透光性不高只说明亮;混浊就诚实说混浊。
3. 琥珀色只用于干仓、透亮、色深的老生茶;湿仓茶色偏红用"红浓明亮",严禁琥珀色。
4. 器物行话:紫砂壶/青花(非白底蓝花)/青瓷(非浅蓝浅青花口)/内飞(非标签纸)。
5. 内飞描述从简;破损一句带过;环境性描述(塑料膜/背景/置物架)不写;叶底未泡开不写"舒展";干茶条索"紧结"非"卷曲"。
6. 专家批注是最高指令,批注指出的问题必须改;批注未提及的教师原文中同类问题也一并改。"""

def fetch(url_path):
    fname = url_path.rsplit("/", 1)[-1]
    local = f"{CACHE}/{fname}"
    if not (os.path.exists(local) and os.path.getsize(local) > 1000):
        r = SESSION.get("https://puer.im" + url_path, timeout=60)
        if r.status_code != 200:
            return None
        open(local, "wb").write(r.content)
    return local

def ask(local, teacher_label, correction):
    data = base64.b64encode(open(local, "rb").read()).decode()
    user_text = (f"教师原标签:{teacher_label}\n专家批注:{correction}\n"
                 "请按专家批注与行规重写这条编目,只输出一行:类型 | 描述。")
    body = {"model": "qwen3.7-plus", "max_tokens": 4000, "system": SYSTEM,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": user_text}]}]}
    for attempt in range(3):
        try:
            r = SESSION.post("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
                headers={"x-api-key": TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json=body, timeout=120)
            r.raise_for_status()
            ans = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
            if ans:
                return ans
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    return ""

def main():
    queue = {i: json.loads(l) for i, l in enumerate(open(QUEUE), 1)}
    # walk all rows in order to resolve 同上 against the last non-empty correction
    resolved = {}
    last_corr = ""
    for i in range(1, len(queue) + 1):
        q = queue.get(i, {})
        corr = q.get("expert_correction", "")
        if corr and "同上" in corr and last_corr:
            resolved[i] = corr.replace("同上", last_corr)
            corr = resolved[i]
        elif corr:
            resolved[i] = corr
        if corr:
            last_corr = corr

    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            try:
                r = json.loads(l)
                if r.get("rewrite"):
                    done.add(r["row"])
            except Exception:
                pass
    todo = [json.loads(l) for l in open(RW)]
    todo = [t for t in todo if t["row"] not in done]
    print(f"rewrite todo: {len(todo)} (done {len(done)})", flush=True)
    with open(OUT, "a", encoding="utf-8") as f:
        for t in todo:
            local = fetch(t["image"])
            corr = resolved.get(t["row"], t["expert_correction"])
            rewrite = ask_teacher = ask(local, t["teacher_label"], corr) if local else ""
            f.write(json.dumps({"row": t["row"], "image": t["image"], "note_title": t["note_title"],
                                "teacher_label": t["teacher_label"], "expert_correction": corr,
                                "rewrite": rewrite}, ensure_ascii=False) + "\n")
            f.flush()
            print(f"#{t['row']}: {rewrite[:60] if rewrite else 'FAIL'}", flush=True)
    print("rewrite done ->", OUT)

if __name__ == "__main__":
    main()
