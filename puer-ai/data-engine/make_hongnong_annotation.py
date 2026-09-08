#!/usr/bin/env python3
"""Build the 红浓-3-case expert review table (vault md, write-once).

v3 student used 红浓 on 3 val rows whose v1 gold labels use 红褐/橙红.
Rule under test: 红浓只用于熟茶/湿仓生茶;干仓生茶(含老生茶)用
深橙红/褐红/橙红/深栗。Expert decides per image which camp it falls in.
Same format family as 教师预标注批注表-b2 (AI writes once, read-only after).
"""
import json

BASE = "/Users/kjonekong/Documents/puer-ai/data-engine"
VAULT = "/Users/kjonekong/Documents/Obsidian Vault/硅谷创新-QLoRA调优/红浓三案批注表-v3-val.md"

CASES = [22, 74, 113]

def esc(s):
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()

def main():
    sft = {r["row"]: r for r in (json.loads(l) for l in open(f"{BASE}/sft-visual-final.jsonl", encoding="utf-8"))}
    keys = {k["row"]: k for k in (json.loads(l) for l in open(f"{BASE}/dataset_v1/val-keys.json", encoding="utf-8"))}
    v3 = {json.loads(l)["row"]: json.loads(l)["answer"]
          for l in open("/Users/kjonekong/Documents/puer-ai/m2-artifacts/v3/student-val.jsonl", encoding="utf-8")}
    import re
    for r in v3:
        v3[r] = re.sub(r"<think>.*?</think>\s*", "", v3[r], flags=re.S).strip()

    lines = [
        "# 红浓三案批注表(v3 val 复核)",
        "",
        "> 生成于 2026-08-17。v3 学生在 val 的 3 张图上用了「红浓」,而 v1 金标是红褐/橙红。",
        "> **待裁规则**:红浓只用于熟茶/湿仓生茶;干仓生茶(含老生茶)用深橙红/褐红/橙红/深栗。",
        "> 批法:看图+参考茶记,判定茶类仓储,在「专家批注」写结论——",
        "> `红浓成立`(熟茶/湿仓 → v3 对、v1 金标待改口径)或 `红浓违规`(干仓生茶 → v3 错),可附正确色档。",
        "> **此文件 AI 只写一次,后续只读——你的批注不会被覆盖。**",
        "",
        "| 序号 | 图片(点开核对) | 茶记标题(参考) | v1 金标 | v3 学生答案 | 专家批注 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for i, row in enumerate(CASES, 1):
        s = sft[row]
        url = "https://puer.im" + s["image"]
        lines.append(
            f"| {i} | [图]({url}) | {esc(s['note_title'])} "
            f"| {esc(keys[row]['label'])} | {esc(v3[row])} | |"
        )
    lines += [
        "",
        "## 批后影响(供参考,不用批)",
        "",
        "- 若三案多为「红浓成立」:val 色档一致率 8/15 被低估,v1 金标需按新规回改,score_style_v3.py 加红浓豁免;",
        "- 若多为「红浓违规」:v3 训练数据里的熟茶红浓样本外溢到了干仓图,v4 需在红浓样本上加强茶类上下文(或只在有包装/叶底佐证时允许红浓)。",
        "",
    ]
    with open(VAULT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote", VAULT)

if __name__ == "__main__":
    main()
