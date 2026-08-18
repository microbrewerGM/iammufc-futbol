"""Cross-language contract: Python must reproduce the committed vectors.

The same fixture is asserted by tests/intent.vectors.test.ts. If the two
languages ever disagree, one of these suites fails -- which is the entire
point. The vector file is read-only here; regenerating it to make a test pass
would defeat the check it exists to provide.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from catalog.schemas.models import EntityType, VizType
from pipeline.contracts.intent import (
    RENDERER_VERSION,
    TRANSFORM_CODE_VERSION,
    QueryIntent,
    artifact_key,
    canonicalize,
)

VECTORS = json.loads(
    (Path(__file__).parent / "vectors" / "artifact-keys.json").read_text(encoding="utf-8")
)


def build(raw: dict) -> QueryIntent:
    return QueryIntent(
        metric=raw["metric"],
        entity_type=EntityType(raw["entity_type"]),
        entity_id=raw["entity_id"],
        season=raw["season"],
        competition=raw.get("competition", "PL"),
        dimensions=raw.get("dimensions", []),
        filters=raw.get("filters", {}),
        viz=VizType(raw.get("viz", "table")),
        limit=raw.get("limit", 10),
    )


def test_versions_match_fixture():
    """If a version constant is bumped, the fixture must be regenerated
    deliberately -- catching the bump in review rather than as silent cache
    invalidation in production."""
    assert VECTORS["transform_code_version"] == TRANSFORM_CODE_VERSION
    assert VECTORS["renderer_version"] == RENDERER_VERSION


@pytest.mark.parametrize("vec", VECTORS["vectors"], ids=lambda v: v["name"])
def test_canonical_form(vec):
    assert canonicalize(build(vec["input"])) == vec["canonical"]


@pytest.mark.parametrize("vec", VECTORS["vectors"], ids=lambda v: v["name"])
def test_artifact_key(vec):
    assert artifact_key(build(vec["input"]), VECTORS["snapshot_id"]) == vec["key"]


def by_name(name: str) -> dict:
    return next(v for v in VECTORS["vectors"] if v["name"] == name)


def test_defaults_are_order_and_presence_invariant():
    """An omitted field and an explicitly-default field must collide, or the
    builder path and the chat path would produce different keys for the same
    question."""
    assert (
        by_name("minimal defaults applied")["key"]
        == by_name("explicit defaults hash the same as omitted ones")["key"]
    )


def test_dimension_order_is_not_semantic():
    assert (
        by_name("dimension order is not semantic")["key"]
        == by_name("same dimensions, reversed input order")["key"]
    )


def test_filter_order_is_not_semantic():
    assert (
        by_name("filter key order is not semantic")["key"]
        == by_name("same filters, reversed key order")["key"]
    )


def test_viz_change_changes_the_key():
    """A shot map and a table of the same metric are different artifacts and
    must not share a cache entry."""
    assert by_name("minimal defaults applied")["key"] != by_name(
        "event-coordinate viz changes the key"
    )["key"]


def test_snapshot_change_changes_the_key():
    """Retroactive data corrections are routine in football. A snapshot bump
    must invalidate, or corrected data would never reach the site."""
    intent = build(by_name("minimal defaults applied")["input"])
    assert artifact_key(intent, "snap-a") != artifact_key(intent, "snap-b")


def test_key_is_sha256_hex():
    for vec in VECTORS["vectors"]:
        assert len(vec["key"]) == 64
        assert all(c in "0123456789abcdef" for c in vec["key"])
