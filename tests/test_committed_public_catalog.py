"""The committed public artifact is an input, never a deploy-time build output."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    load_public_catalog,
    validate_public_catalog_value,
)


@pytest.fixture()
def artifact() -> dict:
    return json.loads(COMPILED_PATH.read_text(encoding="utf-8"))


def test_committed_artifact_satisfies_the_closed_public_contract():
    catalog = load_public_catalog()

    assert len(catalog.metrics) == 6
    assert len(catalog.coverage) == 59


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update({"private_notes": "forbidden"}), "extra_forbidden"),
        (lambda value: value.update({"version": "1"}), "version must be integer 1"),
        (
            lambda value: value["metrics"][0].update({"granularity": "invented"}),
            "schema violation",
        ),
        (
            lambda value: value["coverage"][0].update({"redistributable": 1}),
            "schema violation",
        ),
    ],
)
def test_schema_drift_fails_closed(artifact, mutate, message):
    candidate = deepcopy(artifact)
    mutate(candidate)

    with pytest.raises(PublicCatalogError, match=message):
        validate_public_catalog_value(candidate)


def test_duplicate_metrics_and_cells_fail_closed(artifact):
    duplicate_metric = deepcopy(artifact)
    duplicate_metric["metrics"].append(deepcopy(duplicate_metric["metrics"][0]))
    with pytest.raises(PublicCatalogError, match="duplicate metric_id"):
        validate_public_catalog_value(duplicate_metric)

    duplicate_cell = deepcopy(artifact)
    duplicate_cell["coverage"].append(deepcopy(duplicate_cell["coverage"][0]))
    with pytest.raises(PublicCatalogError, match="duplicate coverage cell"):
        validate_public_catalog_value(duplicate_cell)


def test_cross_record_drift_fails_closed(artifact):
    missing_metric = deepcopy(artifact)
    missing_metric["coverage"][0]["metric"] = "missing"
    with pytest.raises(PublicCatalogError, match="references missing metric"):
        validate_public_catalog_value(missing_metric)

    granularity_drift = deepcopy(artifact)
    granularity_drift["coverage"][0]["granularity"] = "tracking"
    with pytest.raises(PublicCatalogError, match="granularity disagrees"):
        validate_public_catalog_value(granularity_drift)

    source_drift = deepcopy(artifact)
    source_id = source_drift["coverage"][0]["source_id"]
    same_source = next(
        cell
        for cell in source_drift["coverage"][1:]
        if cell["source_id"] == source_id
    )
    same_source["source_name"] = "inconsistent source name"
    with pytest.raises(PublicCatalogError, match="source display disagrees"):
        validate_public_catalog_value(source_drift)


def test_consumer_rejects_unsafe_contract_edges(artifact):
    allowed = deepcopy(artifact)
    allowed["metrics"][0]["label_en"] = ""
    next(cell for cell in allowed["coverage"] if cell["source_id"] == "fbref")[
        "attribution_text"
    ] = ""
    validate_public_catalog_value(allowed)

    excessive_decimals = deepcopy(artifact)
    excessive_decimals["metrics"][0]["decimals"] = 7
    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(excessive_decimals)

    whitespace_season = deepcopy(artifact)
    whitespace_season["coverage"][0]["season"] = " "
    with pytest.raises(PublicCatalogError, match="season must be non-empty"):
        validate_public_catalog_value(whitespace_season)

    bad_source = deepcopy(artifact)
    bad_source["coverage"][0]["source_id"] = "Bad-Source"
    with pytest.raises(PublicCatalogError, match="source_id does not match"):
        validate_public_catalog_value(bad_source)
