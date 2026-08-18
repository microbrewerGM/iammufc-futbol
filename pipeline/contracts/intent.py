"""QueryIntent, canonicalization, and the content-addressed artifact key.

DUAL IMPLEMENTATION WARNING
---------------------------
This logic exists twice: here (pipeline precompute path) and in
worker/src/core/intent.ts (request path). They MUST produce byte-identical
canonical JSON and identical sha256 digests, or the Worker will miss cache
entries the pipeline wrote and regenerate artifacts forever.

Drift is caught by tests/vectors/artifact-keys.json, which both test suites
assert against. Change the canonical form in one language and the other
language's test fails. Do not edit one side alone.

Canonical JSON rules, chosen to match what JSON.stringify can be made to do in
TypeScript without a serialization library:
  * keys sorted lexicographically at every level
  * separators ",", ":" with no whitespace
  * non-ASCII emitted literally (ensure_ascii=False), UTF-8 encoded
  * dimensions sorted; filters key-sorted
  * defaults applied BEFORE serialization, so an omitted field and an
    explicitly-default field hash identically
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from catalog.schemas.models import EntityType, VizType

#: Bump when metric or transform logic changes in a way that alters output.
#: Participates in the artifact key, so bumping invalidates every cached
#: artifact. That is the point: a silent logic change serving stale results is
#: worse than a cache miss.
TRANSFORM_CODE_VERSION = "2026.08.1"

#: Bump when visual output changes. Pin site P7 in docs/pin-registry.md.
RENDERER_VERSION = "vega-lite-poc-1"


class QueryIntent(BaseModel):
    """The constrained intent a builder or an LLM emits.

    The LLM's ONLY job is to fill these slots. It never emits SQL. Free-form
    text-to-SQL fails silently -- the query runs, the number looks plausible,
    and it is wrong -- which is disqualifying for a site whose entire value is
    correctness.
    """

    model_config = ConfigDict(extra="forbid")

    metric: str
    entity_type: EntityType
    entity_id: str
    season: str
    competition: str = "PL"
    dimensions: list[str] = Field(default_factory=list)
    filters: dict[str, str] = Field(default_factory=dict)
    viz: VizType = VizType.TABLE
    limit: int = 10


def canonicalize(intent: QueryIntent) -> str:
    """Deterministic canonical form.

    Two semantically identical requests MUST serialize identically so their
    hashes collide and dedup works. Ordering differences in `dimensions` or
    `filters` are semantically meaningless and must not produce a new key.
    """
    payload: dict[str, Any] = intent.model_dump(mode="json")
    payload["dimensions"] = sorted(payload["dimensions"])
    payload["filters"] = dict(sorted(payload["filters"].items()))
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def artifact_key(intent: QueryIntent, data_snapshot_id: str) -> str:
    """Bazel-style action key over the version 4-tuple.

    (canonical query, data snapshot, transform code version, renderer version)

    Any change to any of the four yields a new key, so invalidation is correct
    by construction. Unchanged inputs reuse forever.

    The data snapshot is part of the key rather than metadata specifically
    because football data is retroactively corrected -- goals reassigned,
    assists changed, xG models revised. A correction bumps the snapshot, which
    changes the key, which invalidates affected artifacts automatically.
    """
    material = "|".join(
        [
            canonicalize(intent),
            data_snapshot_id,
            TRANSFORM_CODE_VERSION,
            RENDERER_VERSION,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
