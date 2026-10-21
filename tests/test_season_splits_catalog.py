"""Public Python decoder accepts only sanitized optional output metadata."""

from __future__ import annotations

import pytest

from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    validate_public_catalog_value,
)


def candidate() -> dict:
    import json

    return json.loads(COMPILED_PATH.read_text(encoding="utf-8"))


def test_season_splits_output_metadata_decodes_separately_from_coverage():
    value = candidate()
    value["output_coverage"] = [{"output_id": "season_splits", "state": "unknown"}]

    decoded = validate_public_catalog_value(value)

    assert decoded.output_coverage[0].output_id == "season_splits"
    assert decoded.output_coverage[0].state == "unknown"
    assert all(cell.entity_type != "venue" for cell in decoded.coverage)


def test_legacy_catalog_without_output_metadata_remains_valid():
    value = candidate()
    value.pop("output_coverage", None)

    decoded = validate_public_catalog_value(value)

    assert decoded.output_coverage == []


@pytest.mark.parametrize("entry", [
    {"output_id": "venue", "state": "clear"},
    {"output_id": "season_splits", "state": "loaded"},
    {"output_id": "season_splits", "state": "unknown", "private_note": "x"},
])
def test_invalid_season_split_output_metadata_fails_closed(entry):
    value = candidate()
    value["output_coverage"] = [entry]
    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(value)


def test_duplicate_season_split_output_metadata_fails_closed():
    value = candidate()
    value["output_coverage"] = [
        {"output_id": "season_splits", "state": "unknown"},
        {"output_id": "season_splits", "state": "partial"},
    ]

    with pytest.raises(PublicCatalogError, match="duplicate output coverage entry"):
        validate_public_catalog_value(value)
