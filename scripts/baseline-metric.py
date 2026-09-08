#!/usr/bin/env python3
"""task#7: compute 审校修改率 baseline (retention + edit-rate) from the
reconstructed verbatim baselines vs the current stored drafts. Read-only.

Metrics (agreed 口径):
  - 改动率 edit-rate  = fraction of drafts whose content was changed at all
  - 保留率 retention  = mean char-level similarity(plaintext baseline, plaintext
                        current) over ALL drafts (unedited count as 1.0)
  - 修改率 = 1 - retention
HTML is stripped to plain text before comparison so tag churn doesn't inflate.
"""
import html
import json
import re
import difflib

rows = json.load(open("/tmp/baseline-reconstructed.json"))

TAG = re.compile(r"<[^>]+>")
def to_plain(s):
    if not s:
        return ""
    s = TAG.sub("\n", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()

def sim(a, b):
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()

n = len(rows)
edited = 0
ret_sum = 0.0
print(f"{'note_title':<26} {'status':<10} {'保留率':>6} {'title改':>5} {'summary改':>7}")
print("-" * 64)
for r in rows:
    b = to_plain(r["baseline_content"])
    c = to_plain(r["current_content"])
    s = sim(b, c)
    is_edited = r["baseline_content"] != r["current_content"]
    edited += int(is_edited)
    ret_sum += s
    t_chg = "Y" if r["baseline_title"] != r["current_title"] else ""
    s_chg = "Y" if (r["baseline_summary"] or "") != (r["current_summary"] or "") else ""
    print(f"{r['note_title'][:24]:<26} {r['status']:<10} {s:>6.1%} {t_chg:>5} {s_chg:>7}")

retention = ret_sum / n
print("-" * 64)
print(f"草稿总数            : {n}")
print(f"被人工改过(改动率)   : {edited}/{n} = {edited/n:.0%}")
print(f"平均保留率          : {retention:.1%}")
print(f"审校修改率(1-保留率) : {1-retention:.1%}")
edited_sims = [sim(to_plain(r['baseline_content']), to_plain(r['current_content']))
               for r in rows if r['baseline_content'] != r['current_content']]
if edited_sims:
    print(f"仅看被改草稿的平均保留: {sum(edited_sims)/len(edited_sims):.1%} (改动力度)")
