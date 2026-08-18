"""Generate tests/vectors/artifact-keys.json.

The vector file is a COMMITTED FIXTURE, not a build output. Both the Python and
TypeScript test suites assert against it read-only. Regenerating it is a
deliberate act that must appear in a diff, because regenerating silently is
exactly how cross-language drift would hide: if the TS side disagrees, the fix
is to correct TS, not to re-bless the vectors.

Run only when the canonical form changes on purpose:
    uv run python -m pipeline.contracts.gen_vectors --write
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from catalog.schemas.models import EntityType, VizType
from pipeline.contracts.intent import (
    RENDERER_VERSION,
    TRANSFORM_CODE_VERSION,
    QueryIntent,
    artifact_key,
    canonicalize,
)

VECTORS_PATH = Path(__file__).resolve().parents[2] / "tests" / "vectors" / "artifact-keys.json"

SNAPSHOT = "snap-test-0000000000000000000000000000000000000000000000000000000000"

CASES: list[tuple[str, dict]] = [
    (
        "minimal defaults applied",
        {"metric": "goals", "entity_type": "player", "entity_id": "p1", "season": "2024-25"},
    ),
    (
        "explicit defaults hash the same as omitted ones",
        {
            "metric": "goals",
            "entity_type": "player",
            "entity_id": "p1",
            "season": "2024-25",
            "competition": "PL",
            "dimensions": [],
            "filters": {},
            "viz": "table",
            "limit": 10,
        },
    ),
    (
        "dimension order is not semantic",
        {
            "metric": "assists",
            "entity_type": "player",
            "entity_id": "p7",
            "season": "2023-24",
            "dimensions": ["opponent", "matchday", "home_away"],
            "viz": "bar",
        },
    ),
    (
        "same dimensions, reversed input order",
        {
            "metric": "assists",
            "entity_type": "player",
            "entity_id": "p7",
            "season": "2023-24",
            "dimensions": ["home_away", "matchday", "opponent"],
            "viz": "bar",
        },
    ),
    (
        "filter key order is not semantic",
        {
            "metric": "minutes",
            "entity_type": "player",
            "entity_id": "p9",
            "season": "2025-26",
            "filters": {"venue": "home", "competition_stage": "group"},
        },
    ),
    (
        "same filters, reversed key order",
        {
            "metric": "minutes",
            "entity_type": "player",
            "entity_id": "p9",
            "season": "2025-26",
            "filters": {"competition_stage": "group", "venue": "home"},
        },
    ),
    (
        "non-ascii entity id survives round trip",
        {
            "metric": "goals",
            "entity_type": "player",
            "entity_id": "garnacho-fernández",
            "season": "2024-25",
            "viz": "bar",
        },
    ),
    (
        "event-coordinate viz changes the key",
        {
            "metric": "goals",
            "entity_type": "player",
            "entity_id": "p1",
            "season": "2017-18",
            "viz": "shot_map",
        },
    ),
    (
        "season entity",
        {"metric": "goals", "entity_type": "season", "entity_id": "2024-25", "season": "2024-25"},
    ),
]


def build() -> dict:
    vectors = []
    for name, raw in CASES:
        intent = QueryIntent(
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
        vectors.append(
            {
                "name": name,
                "input": raw,
                "canonical": canonicalize(intent),
                "key": artifact_key(intent, SNAPSHOT),
            }
        )
    return {
        "_comment": (
            "Committed fixture shared by the Python and TypeScript test suites. "
            "Both assert read-only. If TS disagrees, fix TS -- do not regenerate."
        ),
        "snapshot_id": SNAPSHOT,
        "transform_code_version": TRANSFORM_CODE_VERSION,
        "renderer_version": RENDERER_VERSION,
        "vectors": vectors,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="overwrite the committed fixture")
    args = ap.parse_args()

    data = build()
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    if args.write:
        VECTORS_PATH.parent.mkdir(parents=True, exist_ok=True)
        VECTORS_PATH.write_text(text, encoding="utf-8")
        print(f"wrote {len(data['vectors'])} vectors -> {VECTORS_PATH}")
        return 0

    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
