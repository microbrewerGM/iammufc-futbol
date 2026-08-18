"""Unit tests for the pin-bump computation, no network required.

Two of these tests exist because the FIRST version of n1_minor got them wrong
while this exact script was being built: it proposed "typescript 5.9.3 ->
7.0.2" and "vitest 4.1.10 -> 5.0.0" -- silently crossing the major-version
boundaries that ADR-0003 rule 2 and exceptions E-001/E-002 exist to keep a
human deciding about. Caught by testing against the real npm registry before
it ever reached a workflow. These tests are what stop it coming back.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github" / "scripts"))

from pin_check import MAX_AGE, WARN_AGE, n1_minor  # noqa: E402


def test_normal_n1_minor():
    # Latest 4.13.3, minors present [11, 12, 13] -> N-1 minor is 12, highest
    # patch. current is behind that target -- this is the "yes, propose a
    # bump" case, mirroring how the real pydantic 2.12.5 -> 2.13.4 proposal
    # fired: current sits in an older minor than the N-1 target.
    candidates = ["4.11.0", "4.12.30", "4.12.34", "4.13.0", "4.13.3"]
    assert n1_minor("4.11.5", candidates) == "4.12.34"


def test_current_already_at_target_proposes_nothing():
    candidates = ["4.11.0", "4.12.30", "4.12.34", "4.13.0", "4.13.3"]
    assert n1_minor("4.12.34", candidates) is None


def test_current_ahead_of_target_proposes_nothing():
    # Being ON latest is not a violation -- N-1 is a floor, not a mandate to
    # downgrade. Real-world case: pandas/pyyaml were left on latest patch
    # because ADR-0003 rule 2 made the mechanical N-1 a major downgrade.
    candidates = ["4.11.0", "4.12.30", "4.12.34", "4.13.0", "4.13.3"]
    assert n1_minor("4.13.3", candidates) is None


def test_rule_2_patch_step_when_latest_has_no_prior_minor():
    # Only minor 0 exists in major 3 -> step the patch back instead. current
    # behind the stepped-back target -- the propose-a-bump case.
    candidates = ["3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5"]
    assert n1_minor("3.0.2", candidates) == "3.0.4"


def test_cross_major_gap_proposes_nothing():
    """THE regression test. current=5.9.3, latest=7.0.2, and 7.0.x has no
    prior minor -- the buggy version's rule-2 fallback computed a target
    relative to latest's own major (7) and happily proposed jumping from 5 to
    7. A cross-major gap is not this function's call to make."""
    candidates = ["5.8.0", "5.9.0", "5.9.3", "6.0.0", "6.0.3", "7.0.0", "7.0.1", "7.0.2"]
    assert n1_minor("5.9.3", candidates) is None


def test_cross_major_gap_with_single_patch_in_latest_minor():
    """The exact shape that triggered the original bug: only ONE patch visible
    for latest's minor, which used to make the same-major-minor fallback
    return patches[-1] (== latest itself) rather than skip entirely."""
    candidates = ["4.1.0", "4.1.10", "4.1.11", "5.0.0"]
    assert n1_minor("4.1.10", candidates) is None


def test_current_ahead_of_every_candidate():
    # Defensive: a current version not present in the candidate list at all
    # (e.g. registry lag) must not crash or propose nonsense.
    assert n1_minor("9.9.9", ["1.0.0", "1.1.0"]) is None


def test_unparseable_current_is_inert():
    assert n1_minor("not-a-version", ["1.0.0", "1.1.0", "1.2.0"]) is None


def test_no_candidates_is_inert():
    assert n1_minor("1.0.0", []) is None


def test_rights_freshness_thresholds():
    from pin_check import check_rights_freshness

    # WARN_AGE and MAX_AGE are the two thresholds the manifest gate depends on.
    # Pin them here so a future edit to pin_check.py can't silently loosen the
    # 12-month hard limit that governs what may legally be published.
    assert WARN_AGE.days == 305
    assert MAX_AGE.days == 365
    # Smoke test: runs against the real manifest, must not raise even if the
    # manifest doesn't exist in some future layout change.
    check_rights_freshness(today=date(2026, 8, 18))
