#!/usr/bin/env python3
"""Unified LLM client for the RAG answer pipeline.

Two wire kinds:
  - "anthropic": Bailian qwen3.7-plus (primary teacher, vision-capable) plus
    GLM / Kimi Anthropic-compatible backups. Same endpoint/auth/retry pattern
    as data-engine/teacher_prelabel_b2.py.
  - "openai": DeepSeek chat/completions — cheap text-only answers (no vision;
    passing images raises ValueError). puer-hub already owns a DEEPSEEK_API_KEY.

Token resolution per provider: dedicated env var first (token_env, the only
path available on a server), then the local cc-switch sqlite DB inside
try/except (dev machine convenience). Tokens stay in memory only — never
printed or written to disk. NOTE: the generic ANTHROPIC_AUTH_TOKEN env var
belongs to Claude Code itself and is deliberately NOT consulted.

Active provider = RAG_PROVIDER env at import (default "bailian"). ask() takes
an optional per-call `provider` WITHOUT mutating the global (thread-safe for
the FastAPI service); callers use RAG_ANSWER_PROVIDER / RAG_OCR_PROVIDER to
route answer generation vs image OCR independently.
"""
import base64
import mimetypes
import os
import re
import subprocess
import time

import requests

PROVIDERS = {
    "bailian": {"kind": "anthropic",
                "url": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
                "model": "qwen3.7-plus", "token_env": "ANTHROPIC_TEACHER_TOKEN",
                "db_name": "百炼 Token Plan"},
    "glm": {"kind": "anthropic", "url": "https://open.bigmodel.cn/api/anthropic/v1/messages",
            "model": "glm-5.2", "token_env": "GLM_API_KEY", "db_name": "智谱GLM"},
    "kimi": {"kind": "anthropic", "url": "https://api.moonshot.cn/anthropic/v1/messages",
             "model": "kimi-k3", "token_env": "KIMI_API_KEY", "db_name": "Kimi",
             # kimi-k3 thinking burns the whole max_tokens budget ~50% of the
             # time → empty content. Disabling it: 3/3 verbatim reads.
             "disable_thinking": True},
    "minimax": {"kind": "anthropic", "url": "https://api.minimaxi.com/anthropic/v1/messages",
                "model": "MiniMax-M3", "token_env": "MINIMAX_API_KEY", "db_name": "MiniMax"},
    "deepseek": {"kind": "openai", "url": "https://api.deepseek.com/chat/completions",
                 "model": "deepseek-chat", "token_env": "DEEPSEEK_API_KEY", "db_name": ""},
}
PROVIDER = os.environ.get("RAG_PROVIDER", "bailian")
if PROVIDER not in PROVIDERS:
    PROVIDER = "bailian"
_TOKENS = {}
SESSION = requests.Session()


def set_provider(name):
    if name not in PROVIDERS:
        raise ValueError(f"unknown provider {name}; have {list(PROVIDERS)}")
    global PROVIDER
    PROVIDER = name


def provider_model():
    return f"{PROVIDER}/{PROVIDERS[PROVIDER]['model']}"


def _get_token(name):
    if name in _TOKENS:
        return _TOKENS[name]
    prov = PROVIDERS[name]
    tok = os.environ.get(prov.get("token_env", ""), "").strip()
    if not tok and prov.get("db_name"):
        try:  # dev-machine fallback; sqlite3 CLI may be absent on servers
            tok = subprocess.run(
                ["sqlite3", os.path.expanduser("~/.cc-switch/cc-switch.db"),
                 "SELECT json_extract(settings_config,'$.env.ANTHROPIC_AUTH_TOKEN') "
                 f"FROM providers WHERE app_type='claude' AND name='{prov['db_name']}';"],
                capture_output=True, text=True).stdout.strip()
        except Exception:
            tok = ""
    if not tok:
        env_hint = prov.get("token_env") or "ANTHROPIC_TEACHER_TOKEN"
        raise RuntimeError(f"no token for provider {name} (set {env_hint})")
    _TOKENS[name] = tok
    return tok


def _image_block(path):
    data = base64.b64encode(open(path, "rb").read()).decode()
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    if mime not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        mime = "image/jpeg"
    return {"type": "image",
            "source": {"type": "base64", "media_type": mime, "data": data}}


class RateLimited(Exception):
    """Provider quota/window exhausted — retrying the same provider is
    pointless; callers should fall through to the next one in the chain."""


def _call_anthropic(prov, tok, prompt, images, system, max_tokens):
    content = [_image_block(p) for p in (images or [])]
    content.append({"type": "text", "text": prompt})
    body = {"model": prov["model"], "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}]}
    if system:
        body["system"] = system
    if prov.get("disable_thinking"):
        body["thinking"] = {"type": "disabled"}
    r = SESSION.post(prov["url"],
                     headers={"x-api-key": tok,
                              "anthropic-version": "2023-06-01",
                              "content-type": "application/json"},
                     json=body, timeout=180)
    if r.status_code == 429:
        raise RateLimited(f"{prov['model']} quota")
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json().get("content", [])
                   if b.get("type") == "text").strip()


def _call_openai(prov, tok, prompt, system, max_tokens):
    if not system:
        messages = [{"role": "user", "content": prompt}]
    else:
        messages = [{"role": "system", "content": system},
                    {"role": "user", "content": prompt}]
    body = {"model": prov["model"], "max_tokens": max_tokens, "messages": messages}
    r = SESSION.post(prov["url"],
                     headers={"Authorization": f"Bearer {tok}",
                              "content-type": "application/json"},
                     json=body, timeout=180)
    if r.status_code == 429:
        raise RateLimited(f"{prov['model']} quota")
    r.raise_for_status()
    return (r.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def ask(prompt, images=None, system=None, max_tokens=4000, retries=3, provider=None):
    """One LLM call on the active (or given) provider. `images` is a list of
    local file paths (sent before the text; vision providers only). Returns
    concatenated text, or "" after all retries fail."""
    name = provider or PROVIDER  # per-call override; global NOT mutated (thread-safe)
    prov = PROVIDERS[name]
    if images and prov["kind"] != "anthropic":
        raise ValueError(f"provider {name} has no vision; use a vision provider for images")
    for attempt in range(retries):
        try:
            tok = _get_token(name)
            if prov["kind"] == "anthropic":
                ans = _call_anthropic(prov, tok, prompt, images, system, max_tokens)
            else:
                ans = _call_openai(prov, tok, prompt, system, max_tokens)
            if ans:
                return ans
        except ValueError:
            raise  # programming error (images on non-vision) — do not retry
        except RateLimited:
            break  # quota/window — same-provider retries are wasted time
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    return ""


# vision chain for OCR-style calls: first provider returning text wins.
# A provider with no token is skipped by _get_token raising RuntimeError,
# which ask() swallows into "" — safe to include unconfigured names.
VISION_CHAIN = [p for p in
                os.environ.get("RAG_OCR_FALLBACK", "glm,kimi,bailian").split(",") if p]


def ask_vision(prompt, images, system=None, max_tokens=1500, providers=None):
    """Chain-fallback vision call: (answer, provider_used). Empty answer means
    every provider in the chain failed (quota/network) OR every provider
    returned a refusal boilerplate (GLM anthropic-compat silently drops large
    base64 images and invents "无法访问图片链接"-style refusals — those pass
    truthiness but are useless; treating them as failure lets the next
    provider in the chain have a shot)."""
    # Refusal-like text short-circuits the provider and lets the chain fall
    # through. Must NOT match legitimate answers like "无法识别某具体字"(rare
    # in our prompts — both visual_match and image_ocr forbid identity guess).
    REFUSAL = re.compile(
        r"无法访问图片|无法获取图片|无法加载图片|无法查看图片|无法辨认.*图|图片链接无效|"
        r"不能.*访问.*图像|image.*not.*available|image.*unavailable", re.I)

    for name in (providers or VISION_CHAIN):
        ans = ask(prompt, images=images, system=system,
                  max_tokens=max_tokens, provider=name, retries=1)
        if not ans:
            continue
        if REFUSAL.search(ans):
            # log so the refusal is visible — fall through
            print(f"[teacher_api] refusal boilerplate from {name}: {ans[:80]!r}", flush=True)
            continue
        return ans, name
    return "", None


if __name__ == "__main__":
    import sys
    prov = sys.argv[1] if len(sys.argv) > 1 else "bailian"
    out = ask("1+1等于几?只回答数字。", max_tokens=200, provider=prov)
    print(f"[{prov}/{PROVIDERS[prov]['model']}]", "OK" if out else "FAIL", repr(out[:50]))
