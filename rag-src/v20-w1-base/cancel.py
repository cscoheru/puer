"""W3-2 cooperative cancellation token.

server.py sets it when the HTTP client disconnects; rag_pipeline /
visual_match call check() at stage boundaries and inside the M3-compare
semaphore wait to abort work nobody is waiting for anymore.

Rollback: CANCEL_PROPAGATE=0 (server never sets the token; checks are no-ops).
"""
import threading


class Cancelled(Exception):
    """Raised by CancelToken.check() when cancellation was requested."""


class CancelToken:
    """Thread-safe cooperative cancel flag (thin wrapper over Event)."""

    def __init__(self):
        self._ev = threading.Event()

    def set(self) -> None:
        self._ev.set()

    def is_set(self) -> bool:
        return self._ev.is_set()

    def check(self) -> None:
        """Raise Cancelled if set. Call at stage boundaries; never blocks."""
        if self._ev.is_set():
            raise Cancelled("request cancelled by client disconnect")


if __name__ == "__main__":
    import time

    ok = 0
    t = CancelToken()
    # 1. fresh token: check passes
    t.check(); ok += 1
    # 2. after set: check raises
    t.set()
    try:
        t.check()
        raise AssertionError("check() must raise after set()")
    except Cancelled:
        ok += 1
    assert t.is_set(); ok += 1
    # 3. set from another thread is visible immediately (Event memory model)
    t2 = CancelToken()
    th = threading.Thread(target=t2.set); th.start(); th.join()
    try:
        t2.check()
        raise AssertionError("cross-thread set must be visible")
    except Cancelled:
        ok += 1
    # 4. None-token ergonomics: call sites do `if cancel: cancel.check()`
    none_t = None
    if none_t:
        none_t.check()  # must be skipped, not crash
    ok += 1
    print(f"cancel.py self-test: {ok}/5 PASS")
