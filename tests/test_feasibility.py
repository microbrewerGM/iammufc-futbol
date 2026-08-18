"""Feasibility negative cases.

Negative-path coverage matters more than positive here. The failure mode that
destroys trust is an OPTIMISTIC false positive -- claiming data exists, then
producing a plausible wrong number. These tests assert the system refuses, and
refuses for the *right* reason.
"""

from __future__ import annotations

import pytest

from catalog.schemas.models import EntityType, VizType
from pipeline.contracts.build_catalog import check_invariants, load_catalog
from pipeline.contracts.feasibility import FeasibilityState, check_feasibility
from pipeline.contracts.intent import QueryIntent


@pytest.fixture(scope="module")
def catalog():
    return load_catalog()


def intent(**kw) -> QueryIntent:
    base = {
        "metric": "goals",
        "entity_type": EntityType.PLAYER,
        "entity_id": "p1",
        "season": "2024-25",
        "viz": VizType.BAR,
    }
    base.update(kw)
    return QueryIntent(**base)


def test_catalog_invariants_hold(catalog):
    assert check_invariants(catalog) == []


def test_feasible_cheap_query(catalog):
    r = check_feasibility(intent(), catalog)
    assert r.state is FeasibilityState.COMPUTABLE_QUEUED
    assert r.source_name == "Fantasy Premier League public API"


def test_attribution_travels_with_the_result(catalog):
    """Attribution must render from lineage, never be hand-coded. If it does
    not arrive with the feasibility result, the page has nothing to render."""
    r = check_feasibility(intent(), catalog)
    assert r.attribution_text is not None
    assert "Fantasy Premier League" in r.attribution_text


def test_event_coordinates_outside_coverage_are_no_data(catalog):
    """Free republishable Man United event data covers 2017-18 only, and that
    is not ingested yet. Every pitch-overlay request must refuse."""
    r = check_feasibility(intent(viz=VizType.SHOT_MAP), catalog)
    assert r.state is FeasibilityState.NO_DATA
    assert "event_with_coords" in r.reason


def test_no_data_offers_an_honest_alternative(catalog):
    r = check_feasibility(intent(viz=VizType.SHOT_MAP), catalog)
    assert r.nearest_alternative is not None
    # The alternative must itself be feasible, or we have just moved the lie.
    alt = check_feasibility(r.nearest_alternative, catalog)
    assert alt.state is FeasibilityState.COMPUTABLE_QUEUED


def test_season_outside_coverage_is_no_data(catalog):
    r = check_feasibility(intent(season="2013-14"), catalog)
    assert r.state is FeasibilityState.NO_DATA
    assert "2013-14" in r.reason


def test_non_redistributable_source_is_no_rights_not_no_data(catalog):
    """The distinction is the point. NO_DATA is a gap we could close by
    integrating a source; NO_RIGHTS is a gap we may never close without a
    licence. Collapsing them throws away what the user most needs to know."""
    r = check_feasibility(intent(metric="progressive_passes"), catalog)
    assert r.state is FeasibilityState.NO_RIGHTS
    assert r.state is not FeasibilityState.NO_DATA
    assert "FBref" in r.reason
    assert "redistribution" in r.reason


def test_hallucinated_metric_is_rejected_by_the_catalog(catalog):
    """The LLM can propose anything. Validation, not the model, is what stops
    an invented metric from reaching the executor."""
    r = check_feasibility(intent(metric="vibes_per_90"), catalog)
    assert r.state is FeasibilityState.NO_DATA
    assert "vibes_per_90" in r.reason


def test_never_optimistic_for_any_unseeded_combination(catalog):
    """Sweep the space. Anything not explicitly in the coverage matrix must
    refuse -- absence of a cell never means 'probably fine'."""
    covered = {(c.metric, c.season) for c in catalog.coverage if c.redistributable}
    for metric in ("goals", "assists", "minutes", "points", "xg", "progressive_passes"):
        for season in ("2013-14", "2017-18", "2023-24", "2024-25", "2025-26", "2030-31"):
            r = check_feasibility(intent(metric=metric, season=season), catalog)
            feasible = r.state in (
                FeasibilityState.AVAILABLE,
                FeasibilityState.COMPUTABLE_QUEUED,
                FeasibilityState.COMPUTABLE_EXPENSIVE,
            )
            assert feasible == ((metric, season) in covered), (
                f"{metric}/{season}: state={r.state.value} but coverage "
                f"{'exists' if (metric, season) in covered else 'does not exist'}"
            )


def test_uncovered_season_still_offers_an_alternative(catalog):
    """A season with no coverage at all must not be a dead end. Without the
    third fallback rule this returned a bare refusal and nowhere to go."""
    r = check_feasibility(intent(season="2022-23", viz=VizType.SHOT_MAP), catalog)
    assert r.state is FeasibilityState.NO_DATA
    assert r.nearest_alternative is not None
    alt = check_feasibility(r.nearest_alternative, catalog)
    assert alt.state is FeasibilityState.COMPUTABLE_QUEUED


def test_no_alternative_invented_when_none_exists(catalog):
    """Honesty cuts both ways: a metric we cannot serve in any season must
    return None rather than a plausible-looking suggestion."""
    r = check_feasibility(intent(metric="progressive_passes"), catalog)
    assert r.state is FeasibilityState.NO_RIGHTS
    assert r.nearest_alternative is None
