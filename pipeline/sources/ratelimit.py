"""Token bucket for the football-data.org ingest (M2 roadmap line: `ingest-fdorg`
with a token-bucket honouring 10 req/min).

Free-tier limit confirmed against docs.football-data.org/general/v4 (checked
2026-08-22): auth via the `X-Auth-Token` header; 10 requests/minute on Tier
One. This module only enforces the budget -- it has no opinion on the key
itself, which per hard rule 2 lives in Cloudflare Secrets Store, never here.

`time_fn`/`sleep_fn` are injectable so tests run in zero wall-clock time --
the algorithm is what's under test, not the clock.
"""

from __future__ import annotations

import time
from collections.abc import Callable


class TokenBucket:
    """Classic token bucket: `capacity` tokens, refilled continuously at
    `rate` tokens/second. `acquire()` blocks (via `sleep_fn`) until a token
    is available, then spends it -- callers never need their own throttling
    loop."""

    def __init__(
        self,
        rate_per_minute: float,
        capacity: int | None = None,
        time_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        if rate_per_minute <= 0:
            raise ValueError("rate_per_minute must be positive")
        self._rate_per_second = rate_per_minute / 60.0
        self._capacity = float(capacity if capacity is not None else rate_per_minute)
        self._tokens = self._capacity
        self._time_fn = time_fn
        self._sleep_fn = sleep_fn
        self._last_refill = time_fn()

    def _refill(self) -> None:
        now = self._time_fn()
        elapsed = max(0.0, now - self._last_refill)
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate_per_second)
        self._last_refill = now

    def acquire(self, n: int = 1) -> None:
        if n <= 0:
            raise ValueError("n must be positive")
        if n > self._capacity:
            raise ValueError(f"n={n} exceeds bucket capacity={self._capacity}")
        while True:
            self._refill()
            if self._tokens >= n:
                self._tokens -= n
                return
            shortfall = n - self._tokens
            self._sleep_fn(shortfall / self._rate_per_second)
