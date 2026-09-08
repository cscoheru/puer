#!/usr/bin/env python3
"""M2 eval runner (server-side, transformers inference).

Usage:
  python3 eval_student.py e16   [--adapter PATH]   # E-class 16 questions, identity-blind
  python3 eval_student.py val   [--adapter PATH]   # val split catalog one-liners (style regression)

Outputs to /root/autodl-tmp/m2/eval/{student-e16,student-val}.jsonl (or base-e16/... without adapter).
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image

BASE_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
ROOT = "/root/autodl-tmp/m2"
IMG_E = f"{ROOT}/eval-images"      # E-class images (N001.jpg etc.)
IMG_V = f"{ROOT}/dataset_v1/images"
OUT_DIR = f"{ROOT}/eval"

SYSTEM_TEACHER = ("你是普洱茶图片编目助手。只输出一行:类型 | 描述。类型只能是:"
                  "汤色/叶底/饼面/饼背/版面/内飞或特写/大票或内票/其他。"
                  "描述一句话,含颜色/状态等可验证细节。")
SYSTEM_EXPERT = "你是一位有二十年经验的普洱茶专家。请直接、简洁地回答,术语专业,不确定时明确说明。"

# identical to eval/run_images.py (identity-blind)
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

def load_model(adapter):
    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        BASE_MODEL, torch_dtype=torch.bfloat16, device_map="auto",
        attn_implementation="sdpa")
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
        model = model.merge_and_unload()
        print("adapter merged:", adapter, file=sys.stderr)
    model.eval()
    processor = AutoProcessor.from_pretrained(BASE_MODEL)
    return model, processor

def gen(model, processor, images, system, qtext, max_new=768):
    content = [{"type": "image", "image": p} for p in images]
    content.append({"type": "text", "text": qtext})
    messages = [{"role": "system", "content": [{"type": "text", "text": system}]},
                {"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    import torch
    inputs = processor(text=[text], images=[Image.open(p).convert("RGB") for p in images],
                       return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new, do_sample=False)
    new_tok = out[0][inputs["input_ids"].shape[1]:]
    return processor.decode(new_tok, skip_special_tokens=True).strip()

def run_e16(model, processor, out_path):
    done = set()
    if os.path.exists(out_path):
        for l in open(out_path):
            try:
                r = json.loads(l)
                if r.get("answer"):
                    done.add(r["id"])
            except Exception:
                pass
    with open(out_path, "a", encoding="utf-8") as f:
        for qid, tags, qtext in QUESTIONS:
            if qid in done:
                continue
            paths = [f"{IMG_E}/{t}.jpg" for t in tags]
            missing = [p for p in paths if not os.path.exists(p)]
            if missing:
                print(f"{qid}: MISSING {missing}", flush=True)
                continue
            ans = gen(model, processor, paths, SYSTEM_EXPERT, qtext)
            f.write(json.dumps({"id": qid, "images": tags, "answer": ans}, ensure_ascii=False) + "\n")
            f.flush()
            print(f"{qid}: {ans[:50]}", flush=True)

def run_val(model, processor, out_path):
    keys = [json.loads(l) for l in open(f"{ROOT}/dataset_v1/val-keys.json")]
    done = set()
    if os.path.exists(out_path):
        for l in open(out_path):
            try:
                r = json.loads(l)
                if r.get("answer"):
                    done.add(r["row"])
            except Exception:
                pass
    with open(out_path, "a", encoding="utf-8") as f:
        for k in keys:
            if k["row"] in done:
                continue
            p = f"{IMG_V}/{k['fname']}"
            ans = gen(model, processor, [p], SYSTEM_TEACHER, "编目这张图。", max_new=200)
            f.write(json.dumps({"row": k["row"], "gold": k["label"], "answer": ans},
                               ensure_ascii=False) + "\n")
            f.flush()
            print(f"#{k['row']}: {ans[:50]}", flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["e16", "val"])
    ap.add_argument("--adapter", default="")
    ap.add_argument("--latest", action="store_true", help="use latest checkpoint under saves/")
    args = ap.parse_args()
    adapter = args.adapter
    if args.latest and not adapter:
        cks = sorted(glob.glob(f"{ROOT}/saves/qwen3vl-8b-puer-v1/checkpoint-*"))
        adapter = cks[-1] if cks else ""
    model, processor = load_model(adapter)
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = "student" if adapter else "base"
    out = f"{OUT_DIR}/{tag}-{args.mode}.jsonl"
    (run_e16 if args.mode == "e16" else run_val)(model, processor, out)
    print("done ->", out)

if __name__ == "__main__":
    main()
