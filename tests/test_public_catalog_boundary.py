"""The deploy-time catalog compiler must not leak producer-only metadata."""

from __future__ import annotations

import json

from pipeline.contracts.build_catalog import COMPILED_PATH, compile_for_worker, load_catalog


def test_worker_catalog_is_closed_and_matches_the_committed_artifact():
    compiled = compile_for_worker(load_catalog())

    assert set(compiled) == {"version", "metrics", "coverage"}
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
    assert json.loads(COMPILED_PATH.read_text(encoding="utf-8")) == compiled


def test_worker_catalog_omits_internal_rights_and_retrieval_rationale():
    serialized = json.dumps(compile_for_worker(load_catalog())).lower()

    for forbidden in (
        "licence_id", "notes", "freshness", "verified_date", "tos_snapshot",
        "retrieval_url", "forbids building", "no redistribution licence",
        "rights problem", "green-tier",
    ):
        assert forbidden not in serialized
