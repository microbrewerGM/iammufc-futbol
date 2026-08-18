"""Pydantic models for the capability catalog.

This module is the source of truth for the catalog's shape. JSON Schema is
exported from here to platform/contracts/; the Worker reads a compiled JSON
build of the catalog, never these files directly.

The single most important property: feasibility is a LOOKUP over CoverageCell,
never an inference. An optimistic false positive here is the primary failure
mode of the whole design -- it produces a confident wrong answer, which is worse
than no answer on a site whose entire value is correctness.
"""

from __future__ import annotations

from datetime import date
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class Granularity(str, Enum):
    """What shape of source data a metric needs.

    Coverage is radically uneven across these tiers for Manchester United:
    box scores from 2016-17, event coordinates for 2017-18 ONLY, no free
    tracking at all. That unevenness drives the entire application design.
    """

    BOX_SCORE = "box_score"
    EVENT_COORDS = "event_with_coords"
    TRACKING = "tracking"


class EntityType(str, Enum):
    PLAYER = "player"
    MATCH = "match"
    SEASON = "season"
    OPPONENT = "opponent"
    COMPETITION = "competition"


class VizType(str, Enum):
    TABLE = "table"
    BAR = "bar"
    LINE = "line"
    SHOT_MAP = "shot_map"
    PASS_MAP = "pass_map"
    HEATMAP = "heatmap"


#: Which granularity each visualisation requires. Pitch overlays need event
#: coordinates, which exist for one season only -- this mapping is what turns
#: "show me a shot map for 2024-25" into an honest NO_DATA instead of a guess.
VIZ_GRANULARITY: dict[VizType, Granularity] = {
    VizType.TABLE: Granularity.BOX_SCORE,
    VizType.BAR: Granularity.BOX_SCORE,
    VizType.LINE: Granularity.BOX_SCORE,
    VizType.SHOT_MAP: Granularity.EVENT_COORDS,
    VizType.PASS_MAP: Granularity.EVENT_COORDS,
    VizType.HEATMAP: Granularity.EVENT_COORDS,
}


class CostClass(str, Enum):
    CHEAP = "cheap"
    EXPENSIVE = "expensive"


class RightsEntry(BaseModel):
    """One source's licence position.

    `redistributable` is the field that decides whether anything derived from
    this source may be served publicly. A public site is redistribution even
    with zero revenue -- "non-commercial" grants nothing on its own.
    """

    model_config = ConfigDict(extra="forbid")

    source_id: str
    name: str
    licence_id: str
    redistributable: bool
    attribution_asset: str | None = Field(
        default=None,
        description="Key into attribution assets. Rendered from lineage, never hand-coded.",
    )
    attribution_text: str | None = Field(
        default=None,
        description="Verbatim required wording, where the licence mandates exact text.",
    )
    tos_snapshot: str | None = Field(
        default=None,
        description="Path to a human-captured ToS snapshot. The rights agent reasons "
        "ONLY over these -- fetching live ToS pages would put untrusted web "
        "content into the context of the compliance gate.",
    )
    verified_date: date
    notes: str | None = None


class Metric(BaseModel):
    """A declared, answerable quantity.

    Declaring metrics is what converts an open-ended question into a constrained,
    validatable query. The surface is finite, so every element is checkable --
    categorically safer than free-form SQL.
    """

    model_config = ConfigDict(extra="forbid")

    metric_id: str
    label_en: str
    label_es: str
    description: str
    granularity: Granularity
    unit: str = "count"
    decimals: int = 0


class CoverageCell(BaseModel):
    """One exact fact about what we have and may publish.

    The matrix of these cells is the single source of truth for feasibility.
    Absence of a cell means NO_DATA. It never means "probably fine".
    """

    model_config = ConfigDict(extra="forbid")

    metric: str
    entity_type: EntityType
    granularity: Granularity
    season: str
    competition: str = "PL"
    source_id: str
    freshness: date | None = None
    redistributable: bool
    cost_class: CostClass = CostClass.CHEAP
    notes: str | None = None

    @property
    def key(self) -> tuple[str, EntityType, Granularity, str, str]:
        return (
            self.metric,
            self.entity_type,
            self.granularity,
            self.season,
            self.competition,
        )


class Catalog(BaseModel):
    """The assembled catalog. Validated as a whole so cross-file invariants
    (every cell's source exists, every source has a snapshot) are enforced
    at build time rather than discovered at request time."""

    model_config = ConfigDict(extra="forbid")

    rights: list[RightsEntry]
    metrics: list[Metric]
    coverage: list[CoverageCell]

    def rights_by_id(self) -> dict[str, RightsEntry]:
        return {r.source_id: r for r in self.rights}

    def metrics_by_id(self) -> dict[str, Metric]:
        return {m.metric_id: m for m in self.metrics}

    def coverage_index(self) -> dict[tuple[str, EntityType, Granularity, str, str], CoverageCell]:
        return {c.key: c for c in self.coverage}
