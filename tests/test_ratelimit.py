"""TokenBucket correctness -- fake clock/sleep so this runs in zero wall-clock
time. What matters for `ingest-fdorg` (10 req/min, free tier) is that the
bucket never lets more than `capacity` requests through before a refill, and
that it blocks for the right duration rather than busy-spinning or
under-sleeping past the real API's limit.
"""

from __future__ import annotations

import pytest

from pipeline.sources.ratelimit import TokenBucket


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        assert seconds >= 0
        self.now += seconds


def make_bucket(rate_per_minute: float, capacity: int | None = None) -> tuple[TokenBucket, FakeClock]:
    clock = FakeClock()
    bucket = TokenBucket(rate_per_minute, capacity=capacity, time_fn=clock.time, sleep_fn=clock.sleep)
    return bucket, clock


def test_starts_full_and_spends_down_without_sleeping():
    bucket, clock = make_bucket(rate_per_minute=10)
    for _ in range(10):
        bucket.acquire()
    assert clock.now == 0.0  # ten tokens available immediately, no throttling yet


def test_eleventh_request_within_the_minute_blocks_for_the_shortfall():
    bucket, clock = make_bucket(rate_per_minute=10)
    for _ in range(10):
        bucket.acquire()
    bucket.acquire()
    # rate = 10/60 tokens/sec -> one token takes 6s to regenerate
    assert clock.now == pytest.approx(6.0)


def test_refills_continuously_not_in_a_lump_at_the_minute_boundary():
    bucket, clock = make_bucket(rate_per_minute=10)
    for _ in range(10):
        bucket.acquire()
    clock.now += 3.0  # half a token's worth of time passes
    bucket.acquire()  # needs the other half-token
    assert clock.now == pytest.approx(6.0)


def test_never_exceeds_capacity_even_after_a_long_idle_period():
    bucket, clock = make_bucket(rate_per_minute=10)
    clock.now += 3600  # an hour idle
    for _ in range(10):
        bucket.acquire()  # all ten satisfied from the (capped) bucket, no sleep
    assert clock.now == 3600.0
    bucket.acquire()  # the eleventh still has to wait for a real refill
    assert clock.now == pytest.approx(3606.0)


def test_capacity_can_be_set_independently_of_rate():
    bucket, clock = make_bucket(rate_per_minute=10, capacity=1)
    bucket.acquire()
    bucket.acquire()
    assert clock.now == pytest.approx(6.0)


def test_rejects_non_positive_rate():
    with pytest.raises(ValueError):
        TokenBucket(rate_per_minute=0)


def test_rejects_a_request_larger_than_capacity():
    bucket, _clock = make_bucket(rate_per_minute=10, capacity=5)
    with pytest.raises(ValueError):
        bucket.acquire(n=6)
