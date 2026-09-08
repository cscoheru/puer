#!/usr/bin/env python3
"""Internal-only FastAPI wrapper around rag_pipeline.answer_question.

Deployed on the puer-hub docker network (puer-net); no published port, no
nginx location. The only caller is the Next.js app's /api/qa route, which
authenticates with the shared RAG_SERVICE_TOKEN (Bearer). Images arrive as
same-site /uploads/... paths fetched from RAG_PUBLIC_BASE (the app container).

Env:
  RAG_SERVICE_TOKEN  shared secret ("" = open, dev only)
  RAG_PUBLIC_BASE    where /uploads/... lives (default http://app:3000)
  RAG_MAX_IMAGES     max images per question (default 3)
  RAG_MAX_CONCURRENT max in-flight pipeline calls (default 3)
  RAG_USE_EMBED      "true" to enable bge embedding search (default false)
"""
import hmac
import os
import re
import tempfile
import threading
import urllib.parse

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

import rag_pipeline

app = FastAPI(title="puer-rag-service", version="1.0")

RAG_TOKEN = os.environ.get("RAG_SERVICE_TOKEN", "")
PUBLIC_BASE = os.environ.get("RAG_PUBLIC_BASE", "http://app:3000").rstrip("/")
# Preferred: read uploaded images straight off a read-only bind mount of the
# host uploads/ dir (RAG_UPLOADS_DIR). This bypasses Next.js static serving
# entirely — ISR can cache a sticky 404 page for files requested in a race
# window around upload completion.
UPLOADS_DIR = os.environ.get("RAG_UPLOADS_DIR", "/host-uploads")
MAX_IMG = int(os.environ.get("RAG_MAX_IMAGES", "3"))
MAX_IMG_BYTES = 10 * 1024 * 1024
USE_EMBED = os.environ.get("RAG_USE_EMBED", "false") == "true"
_sem = threading.BoundedSemaphore(int(os.environ.get("RAG_MAX_CONCURRENT", "3")))

_IMG_RE = re.compile(
    r"^/uploads/(forum|sessions|inventory|collected)/[A-Za-z0-9._-]+\.(jpe?g|png|gif|webp)$")


def _authorized(token: str | None) -> bool:
    return (not RAG_TOKEN) or bool(token and hmac.compare_digest(token, RAG_TOKEN))


@app.get("/healthz")
def healthz():
    return {"status": "ok", "pid": os.getpid()}


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    image_urls: list[str] = Field(default_factory=list)
    topk: int | None = Field(default=6, ge=3, le=12)

    @field_validator("image_urls")
    @classmethod
    def _safe_images(cls, v: list[str]):
        if len(v) > MAX_IMG:
            raise ValueError(f"at most {MAX_IMG} images per question")
        bad = [u for u in v if not _IMG_RE.match(u)]
        if bad:
            raise ValueError("unsafe image_url")
        return v


def _resolve_image(url: str, dest: str) -> str:
    """Materialize the image at dest. Bind-mount read first (no Next.js static
    serving in the loop); HTTP download from RAG_PUBLIC_BASE as fallback."""
    local = UPLOADS_DIR + url[len("/uploads"):]  # /uploads/forum/x.jpg -> $DIR/forum/x.jpg
    if os.path.isfile(local):
        import shutil
        return shutil.copy(local, dest)
    import requests
    full = urllib.parse.urljoin(PUBLIC_BASE + "/", url.lstrip("/"))
    if not full.startswith(PUBLIC_BASE + "/"):
        raise HTTPException(400, "image URL escapes allowed base")
    with requests.get(full, timeout=30, stream=True) as r:
        r.raise_for_status()
        n = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(64 * 1024):
                n += len(chunk)
                if n > MAX_IMG_BYTES:
                    raise HTTPException(413, "image too large")
                f.write(chunk)
    from PIL import Image  # must decode as a real image
    Image.open(dest).verify()
    return dest


@app.post("/api/ask")
def ask(body: AskBody, authorization: str | None = Header(default=None)):
    if not _authorized(authorization.removeprefix("Bearer ").strip()
                       if authorization else None):
        raise HTTPException(401, "unauthorized")
    if not _sem.acquire(timeout=30):
        raise HTTPException(429, "too many concurrent requests")
    try:
        tmp = tempfile.TemporaryDirectory()
        try:
            local = [_resolve_image(u, os.path.join(tmp.name, f"img{i}.jpg"))
                     for i, u in enumerate(body.image_urls)]
            return rag_pipeline.answer_question(
                body.question, image_paths=local or None,
                topk=body.topk or 6, use_embed=USE_EMBED)
        finally:
            tmp.cleanup()
    except HTTPException:
        raise
    except Exception as e:  # never leak internals past the container boundary
        import traceback
        traceback.print_exc()  # full stack to docker logs for diagnosis
        raise HTTPException(502, f"rag pipeline failed: {type(e).__name__}")
    finally:
        _sem.release()
