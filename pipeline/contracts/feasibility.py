"""The feasibility resolver — answered BEFORE any compute.

Five states, and the distinction between the last two is the point of the whole
design. NO_DATA is a gap we could close by integrating a source. NO_RIGHTS is a
gap we may never close without paying for a licence. Collapsing them into a
generic "unavailable" throws away the information a user most needs.

This must be EXACT, never optimistic. A false positive here produces a
confident wrong answer, which is the worst outcome the system can produce.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict

from catalog.schemas.models import VIZ_GRANULARITY, Catalog, CostClass, Granularity
from pipeline.contracts.intent import QueryIntent


class FeasibilityState(str, Enum):
    AVAILABLE = "available"
    COMPUTABLE_QUEUED = "computable_now_queued"
    COMPUTABLE_EXPENSIVE = "computable_but_expensive"
    NO_DATA = "not_computable_data_missing"
    NO_RIGHTS = "not_computable_no_rights"


class FeasibilityResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: FeasibilityState
    reason: str
    attribution_asset: str | None = None
    attribution_text: str | None = None
    source_name: str | None = None
    nearest_alternative: QueryIntent | None = None
    cost_class: CostClass = CostClass.CHEAP


def granularity_for(intent: QueryIntent) -> Granularity:
    """Pitch overlays need event coordinates. This mapping is what turns
    'show me a shot map for 2024-25' into an honest refusal rather than a
    silent fallback to box-score data."""
    return VIZ_GRANULARITY[intent.viz]


def _nearest_alternative(intent: QueryIntent, catalog: Catalog) -> QueryIntent | None:
    """Find a genuinely feasible neighbour, or None.

    Never fabricates. Preference order changes as little as possible about what
    the user asked for:
      1. same metric and viz, a season we actually cover
      2. same season, coarser granularity (downgrade the visualisation)
      3. any covered season at box-score granularity (change both)

    Rule 3 matters more than it looks: without it, asking for a pitch map in a
    season with no coverage at all yields a bare refusal and a dead end.
    """
    from catalog.schemas.models import VizType

    wanted = granularity_for(intent)

    same_metric = [
        c
        for c in catalog.coverage
        if c.metric == intent.metric
        and c.entity_type == intent.entity_type
        and c.redistributable
    ]
    if not same_metric:
        return None

    # 1. Same shape, different season.
    for cell in sorted(same_metric, key=lambda c: c.season, reverse=True):
        if cell.granularity == wanted and cell.season != intent.season:
            return intent.model_copy(update={"season": cell.season})

    # 2. Same season, coarser granularity -> downgrade the visualisation.
    for cell in same_metric:
        if cell.season == intent.season and cell.granularity == Granularity.BOX_SCORE:
            return intent.model_copy(update={"viz": VizType.BAR})

    # 3. Most recent season we cover at all, with the viz downgraded to match.
    box_score = sorted(
        (c for c in same_metric if c.granularity == Granularity.BOX_SCORE),
        key=lambda c: c.season,
        reverse=True,
    )
    if box_score:
        return intent.model_copy(
            update={"season": box_score[0].season, "viz": VizType.BAR}
        )

    # Nothing honest to offer.
    return None


def check_feasibility(
    intent: QueryIntent,
    catalog: Catalog,
    artifact_exists: bool = False,
) -> FeasibilityResult:
    if artifact_exists:
        return FeasibilityResult(
            state=FeasibilityState.AVAILABLE,
            reason="Cached artifact exists.",
        )

    metrics = catalog.metrics_by_id()
    if intent.metric not in metrics:
        # A hallucinated metric is caught here, by the catalog, not by the model.
        return FeasibilityResult(
            state=FeasibilityState.NO_DATA,
            reason=f"'{intent.metric}' is not a metric this site defines.",
        )

    granularity = granularity_for(intent)
    key = (
        intent.metric,
        intent.entity_type,
        granularity,
        intent.season,
        intent.competition,
    )
    cell = catalog.coverage_index().get(key)

    if cell is None:
        label = metrics[intent.metric].label_en
        return FeasibilityResult(
            state=FeasibilityState.NO_DATA,
            reason=(
                f"No integrated source provides {label} at {granularity.value} "
                f"granularity for {intent.season} {intent.competition}."
            ),
            nearest_alternative=_nearest_alternative(intent, catalog),
        )

    rights = catalog.rights_by_id()[cell.source_id]

    if not cell.redistributable or not rights.redistributable:
        # We may hold it privately. We may not publish it. Say which.
        return FeasibilityResult(
            state=FeasibilityState.NO_RIGHTS,
            reason=(
                f"{metrics[intent.metric].label_en} for {intent.season} comes from "
                f"{rights.name}, which grants no redistribution licence. We cannot "
                f"publish it."
            ),
            source_name=rights.name,
            nearest_alternative=_nearest_alternative(intent, catalog),
        )

    if cell.cost_class == CostClass.EXPENSIVE:
        return FeasibilityResult(
            state=FeasibilityState.COMPUTABLE_EXPENSIVE,
            reason="Event-level render; deferred to the nightly batch.",
            attribution_asset=rights.attribution_asset,
            attribution_text=rights.attribution_text,
            source_name=rights.name,
            cost_class=CostClass.EXPENSIVE,
        )

    return FeasibilityResult(
        state=FeasibilityState.COMPUTABLE_QUEUED,
        reason="Feasible and cheap; generated on request.",
        attribution_asset=rights.attribution_asset,
        attribution_text=rights.attribution_text,
        source_name=rights.name,
    )
