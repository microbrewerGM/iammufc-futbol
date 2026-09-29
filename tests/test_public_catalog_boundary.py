"""The deploy-time catalog compiler must not leak producer-only metadata."""

from __future__ import annotations

import json

import pytest

from pipeline.contracts.build_catalog import compile_for_worker, load_catalog
from pipeline.contracts.validate_legacy_catalog import (
    main as validate_legacy_main,
    validate_legacy_parity,
)
from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    validate_public_catalog_value,
)


def test_legacy_worker_catalog_is_closed_and_satisfies_the_consumer_contract():
    compiled = compile_for_worker(load_catalog())

    validated = validate_public_catalog_value(compiled)

    assert set(compiled) == {"version", "metrics", "coverage"}
    assert len(validated.metrics) == len(compiled["metrics"])
    assert len(validated.coverage) == len(compiled["coverage"])
    assert all(
        set(metric) == {
            "metric_id", "label_en", "label_es", "description", "description_es",
            "granularity", "unit", "decimals",
        }
        for metric in compiled["metrics"]
    )
    assert all(
        set(cell) == {
            "metric", "entity_type", "granularity", "season", "competition",
            "source_id", "redistributable", "cost_class", "attribution_asset",
            "attribution_text", "attribution_text_es", "source_name",
        }
        for cell in compiled["coverage"]
    )


def test_legacy_catalog_validation_is_read_only():
    before = COMPILED_PATH.read_bytes()

    assert validate_legacy_main() == 0
    assert COMPILED_PATH.read_bytes() == before


def test_legacy_parity_rejects_unreviewed_public_coverage():
    candidate = json.loads(COMPILED_PATH.read_text(encoding="utf-8"))
    candidate["coverage"][0]["season"] = "2099-00"

    with pytest.raises(PublicCatalogError, match="does not match"):
        validate_legacy_parity(candidate)


def test_worker_catalog_omits_internal_rights_and_retrieval_rationale():
    serialized = json.dumps(compile_for_worker(load_catalog())).lower()

    for forbidden in (
        "licence_id", "notes", "freshness", "verified_date", "tos_snapshot",
        "retrieval_url", "forbids building", "no redistribution licence",
        "rights problem", "green-tier",
    ):
        assert forbidden not in serialized
