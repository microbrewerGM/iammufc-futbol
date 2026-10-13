"""The legacy compiler remains a closed projection, not publication authority."""

import json

from pipeline.contracts.build_catalog import compile_for_worker, load_catalog
from pipeline.contracts.validate_public_catalog import validate_public_catalog_value


def test_legacy_compiler_projection_remains_closed_and_contract_valid():
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


def test_legacy_compiler_omits_internal_rights_and_retrieval_rationale():
    serialized = json.dumps(compile_for_worker(load_catalog())).lower()
    for forbidden in (
        "licence_id", "notes", "freshness", "verified_date", "tos_snapshot",
        "retrieval_url", "forbids building", "no redistribution licence",
        "rights problem", "green-tier",
    ):
        assert forbidden not in serialized
