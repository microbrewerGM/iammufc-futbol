"""Public decoder keeps arrivals/manager metadata optional and fail-closed."""

from __future__ import annotations

import json

import pytest

from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    validate_public_catalog_value,
)


def candidate() -> dict:
    return json.loads(COMPILED_PATH.read_text(encoding="utf-8"))


def test_arrival_manager_capability_is_metadata_only_and_unknown():
    value = candidate()
    value["output_coverage"] = [
        {"output_id": "arrival_manager_groups", "state": "unknown"}
    ]

    decoded = validate_public_catalog_value(value)

    assert decoded.output_coverage[0].output_id == "arrival_manager_groups"
    assert decoded.output_coverage[0].state == "unknown"
    assert {state.value for state in __import__(
        "pipeline.contracts.feasibility", fromlist=["FeasibilityState"]
    ).FeasibilityState} == {
        "available", "computable_now_queued", "computable_but_expensive", "no_data", "no_rights"
    }


def test_legacy_catalog_without_output_coverage_remains_valid():
    value = candidate()
    value.pop("output_coverage", None)
    assert validate_public_catalog_value(value).output_coverage == []


@pytest.mark.parametrize(
    "entry",
    [
        {"output_id": "arrival_manager_groups", "state": "loaded"},
        {"output_id": "arrival_manager_groups", "state": "unknown", "private_note": "x"},
    ],
)
def test_arrival_manager_capability_rejects_invalid_public_entries(entry):
    value = candidate()
    value["output_coverage"] = [entry]
    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(value)


def test_arrival_manager_capability_rejects_duplicate_ids():
    value = candidate()
    value["output_coverage"] = [
        {"output_id": "arrival_manager_groups", "state": "unknown"},
        {"output_id": "arrival_manager_groups", "state": "partial"},
    ]
    with pytest.raises(PublicCatalogError, match="duplicate output coverage entry"):
        validate_public_catalog_value(value)


def test_output_coverage_keeps_schema_maximum():
    value = candidate()
    value["output_coverage"] = [
        {"output_id": output_id, "state": "unknown"}
        for output_id in ("shot_map", "season_splits", "arrival_manager_groups", "extra")
    ]
    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(value)
