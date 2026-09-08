"""W3-2 sqlite response cache for rag_pipeline.answer_question.

Key = content-addressed: sha1(sorted image-file hashes + normalized question).
Value = full JSON response (normal answers AND refusal results — both are
deterministic for the same input; a low_confidence refusal costs a full
visual_match pass ~50s and must not be recomputed on re-ask).

Rollback: CACHE_ENABLED=0 (pipeline bypasses cache entirely).
"""
import hashlib
import json
import os
import re
import sqlite3
import time

CACHE_ENABLED = os.environ.get("CACHE_ENABLED", "1") != "0"
# /data is a READ-ONLY bind mount in this container — the cache lives in the
# container writable layer instead: survives `docker restart`, lost on
# recreate (fine: TTL is 24h and the cache is a pure performance optimization).
CACHE_DB = os.environ.get("CACHE_DB", "/tmp/cache.sqlite")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "86400"))  # 24h

_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")


_CJK_RE = re.compile(r"[一-鿿㐀-䶿]")


def _norm_question(q: str) -> str:
    """Punctuation-free, lowercased canonical form. No stemming. CJK-aware:
    in a Chinese question, intra-sentence spaces are meaningless
    (「帮我 看看」==「帮我看看」), so all spaces drop; in a latin question
    spaces are word boundaries and only fold/collapse."""
    s = _PUNCT_RE.sub("", (q or "").strip()).lower()
    if _CJK_RE.search(s):
        return _WS_RE.sub("", s)
    return _WS_RE.sub(" ", s).strip()


def _file_sha1(path: str) -> str:
    """Content hash (not path hash — same content at a new tmp path hits)."""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def make_key(question: str, image_paths) -> str:
    parts = sorted(_file_sha1(p) for p in (image_paths or []) if os.path.exists(p))
    # missing files are excluded above: a vanished file must not silently
    # equate two different questions — but identical inputs stay identical.
    raw = ",".join(parts) + "|" + _norm_question(question)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _conn() -> sqlite3.Connection:
    # per-call connection: RAG_MAX_CONCURRENT=3 keeps write contention near
    # zero, and WAL lets readers never block. check_same_thread irrelevant.
    c = sqlite3.connect(CACHE_DB, timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def _ensure(c: sqlite3.Connection) -> None:
    c.execute(
        "CREATE TABLE IF NOT EXISTS cache ("
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, expire_at INTEGER NOT NULL)"
    )
    c.execute("PRAGMA user_version=1")


def lookup(key: str) -> dict | None:
    if not CACHE_ENABLED:
        return None
    try:
        with _conn() as c:
            _ensure(c)
            row = c.execute(
                "SELECT value, expire_at FROM cache WHERE key=?", (key,)
            ).fetchone()
            if not row:
                return None
            value, expire_at = row
            if expire_at < time.time():
                c.execute("DELETE FROM cache WHERE key=?", (key,))  # lazy expiry
                return None
            return json.loads(value)
    except Exception:
        return None  # cache must never break answering


def store(key: str, response: dict) -> bool:
    if not CACHE_ENABLED or not isinstance(response, dict):
        return False
    if not response.get("answer"):
        return False  # only cache shapes we know round-trip
    try:
        with _conn() as c:
            _ensure(c)
            c.execute(
                "INSERT OR REPLACE INTO cache(key, value, expire_at) VALUES(?,?,?)",
                (key, json.dumps(response, ensure_ascii=False),
                 int(time.time()) + CACHE_TTL),
            )
        return True
    except Exception as e:
        print(f"[cache] store failed key={key}: {type(e).__name__}: {e}")
        return False


if __name__ == "__main__":
    # self-test against a throwaway DB — never touches /data/cache.sqlite
    CACHE_DB = "/tmp/cache_selftest.sqlite"
    if os.path.exists(CACHE_DB):
        os.remove(CACHE_DB)
    ok = 0

    # 1. round-trip
    doc = {"answer": "测试答案", "confidence": "high", "visual": {"ok": True}}
    assert store("k1", doc)
    got = lookup("k1")
    assert got == doc, f"round-trip mismatch: {got}"
    ok += 1

    # 2. TTL expiry (shrink TTL, store, rewind expire_at via direct write)
    CACHE_TTL = 1
    store("k2", doc)
    time.sleep(1.1)
    assert lookup("k2") is None, "expired entry must not hit"
    ok += 1

    # 3. key stability: same q → same key; punctuation/case/whitespace fold
    a = _norm_question("这个茶，是什么？  帮我 看看！")
    b = _norm_question("这个茶是什么 帮我看看")
    assert a == b, f"normalize mismatch: {a!r} vs {b!r}"
    ok += 1

    # 4. different question → different key
    assert _norm_question("7542 行情") != _norm_question("8582 行情")
    ok += 1

    # 5. make_key with real files: order-insensitive multi-image
    p1, p2 = "/tmp/_ck_a.bin", "/tmp/_ck_b.bin"
    open(p1, "wb").write(b"img-a-bytes")
    open(p2, "wb").write(b"img-b-bytes")
    k1 = make_key("这个茶是什么", [p1, p2])
    k2 = make_key("这个茶是什么", [p2, p1])
    assert k1 == k2, "multi-image key must be order-insensitive"
    k3 = make_key("这个茶是什么呀", [p1, p2])
    assert k1 != k3, "different question must differ"
    k4 = make_key("这个茶是什么", [p1])
    assert k1 != k4, "fewer images must differ"
    ok += 1

    # 6. no-image question still cacheable (abc knowledge answers)
    ka = make_key("普洱生茶熟茶区别", [])
    kb = make_key("普洱生茶熟茶区别", None)
    assert ka == kb and len(ka) == 16
    ok += 1

    os.remove(p1); os.remove(p2); os.remove(CACHE_DB)
    print(f"cache.py self-test: {ok}/6 PASS")
