#!/usr/bin/env python3
"""F3 driver: E2_SIBLING_BIAS=1 on v6 manifest.

Pool-only first (cheap, no M3), then verdict if metrics look promising.

Two output files:
  - /opt/puer-hub/rag-data/eval/scores.v6.f3.pool.jsonl  (pool-only recall)
  - /opt/puer-hub/rag-data/eval/scores.v6.f3.verdict.jsonl  (full verdict, ~100 M3 calls)
"""
import os
import subprocess
import sys

ENV_FILE = "/opt/puer-hub/.env"
loaded = []
with open(ENV_FILE, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if not k or not all(c.isalnum() or c == "_" for c in k):
            continue
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)
        loaded.append(k)

run_env = {
    "RAG_DATA_HOST": "/opt/puer-hub/rag-data",
    "RAG_DATA_DIR": "/opt/puer-hub/rag-data",
    "SIBLING_INJECT": "1",      # F1 reserved-slot injection ON
    "E2_SIBLING_BIAS": "1",     # F3: E2 ON (字面 sibling: 要求)
    "B2_DEMOTE_NOTES": "1",
    "HARD_NEG_DEMOTE": "1",
}
for k, v in run_env.items():
    os.environ[k] = v

need = ["MINIMAX_API_KEY", "GLM_API_KEY", "KIMI_API_KEY"]
missing = [k for k in need if not os.environ.get(k)]
print(f"env loaded keys: {len(loaded)}; provider check: "
      f"{'MISSING ' + repr(missing) if missing else 'all present'}")
if missing:
    sys.exit(3)

mode = sys.argv[1] if len(sys.argv) > 1 else "recall"
out = sys.argv[2] if len(sys.argv) > 2 \
    else ("/opt/puer-hub/rag-data/eval/scores.v6.f3.pool.jsonl"
          if mode == "recall"
          else "/opt/puer-hub/rag-data/eval/scores.v6.f3.verdict.jsonl")

cmd = [sys.executable, "/opt/puer-hub/rag-src/v20-w1-base/eval_offline.py",
       "--manifest", "/opt/puer-hub/rag-data/eval/manifest.v6.jsonl",
       "--mode", mode, "--out", out]
print("CMD:", " ".join(cmd))
sys.exit(subprocess.call(cmd, cwd="/opt/puer-hub/rag-src/v20-w1-base"))