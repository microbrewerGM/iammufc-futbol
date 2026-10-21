"""The optional output coverage projection is a small, closed public contract."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    validate_public_catalog_value,
)


@pytest.fixture()
def artifact() -> dict:
    return json.loads(COMPILED_PATH.read_text(encoding="utf-8"))


def test_catalog_without_output_coverage_remains_valid(artifact):
    artifact.pop("output_coverage", None)
    validated = validate_public_catalog_value(artifact)

    assert validated.output_coverage == []


@pytest.mark.parametrize("state", ["clear", "absent", "partial", "unknown"])
def test_allowlisted_output_coverage_states_are_valid(artifact, state):
    candidate = deepcopy(artifact)
    candidate["output_coverage"] = [{"output_id": "shot_map", "state": state}]

    validated = validate_public_catalog_value(candidate)

    assert validated.output_coverage is not None
    assert validated.output_coverage[0].output_id == "shot_map"
    assert validated.output_coverage[0].state == state


@pytest.mark.parametrize(
    "entry",
    [
        {"output_id": "pass_map", "state": "clear"},
        {"output_id": "shot_map", "state": "complete"},
        {"output_id": "shot_map", "state": "partial", "scope": "private"},
        {"output_id": "shot_map", "state": "unknown", "limitation": "private"},
    ],
)
def test_output_coverage_rejects_unknown_ids_states_and_extra_fields(artifact, entry):
    candidate = deepcopy(artifact)
    candidate["output_coverage"] = [entry]

    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(candidate)


def test_output_coverage_rejects_duplicate_output_ids(artifact):
    candidate = deepcopy(artifact)
    candidate["output_coverage"] = [
        {"output_id": "shot_map", "state": "clear"},
        {"output_id": "shot_map", "state": "partial"},
    ]

    with pytest.raises(PublicCatalogError, match="duplicate output coverage entry"):
        validate_public_catalog_value(candidate)


@pytest.mark.parametrize("value", [None, {}, "partial"])
def test_output_coverage_must_be_a_list_when_present(artifact, value):
    candidate = deepcopy(artifact)
    candidate["output_coverage"] = value

    with pytest.raises(PublicCatalogError, match="schema violation"):
        validate_public_catalog_value(candidate)
