#!/usr/bin/env python3
"""E1+E2 combined verdict run driver (host, offline, no prod touch).
Loads /opt/puer-hub/.env safely (python parse, no shell interpretation),
never prints token values, then runs eval_offline.py --mode verdict."""
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
    "SIBLING_INJECT": "1",
    "B2_DEMOTE_NOTES": "1",
    "E2_SIBLING_BIAS": os.environ.get("E2_SIBLING_BIAS", "1"),
    "E2_SELF_SIM_FLOOR": os.environ.get("E2_SELF_SIM_FLOOR", "0.95"),
}
for k, v in run_env.items():
    os.environ[k] = v

need = ["MINIMAX_API_KEY", "GLM_API_KEY", "KIMI_API_KEY"]
missing = [k for k in need if not os.environ.get(k)]
print(f"env loaded keys: {len(loaded)}; provider check: "
      f"{'MISSING ' + repr(missing) if missing else 'all present'}")
if missing:
    sys.exit(3)

out = sys.argv[1] if len(sys.argv) > 1 else "/opt/puer-hub/rag-data/eval/scores.v5.e12.jsonl"
extra = sys.argv[2:]
cmd = [sys.executable, "/opt/puer-hub/rag-src/v20-w1-base/eval_offline.py",
       "--manifest", "/opt/puer-hub/rag-data/eval/manifest.v5.jsonl",
       "--mode", "verdict", "--out", out] + extra
print("CMD:", " ".join(cmd))
sys.exit(subprocess.call(cmd, cwd="/opt/puer-hub/rag-src/v20-w1-base"))
