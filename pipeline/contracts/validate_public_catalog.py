"""Validate the committed public catalog without regenerating it.

This is the read-only consumer side of the ownership transition. Public
workflows treat the checked-in JSON as an input and fail closed if its shape or
cross-record invariants drift; they never rewrite it during ingestion or
deployment. Legacy semantic parity remains mandatory until a verifiable private
producer attestation replaces it.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr
from pydantic import ValidationError

from catalog.schemas.models import CostClass, EntityType, Granularity
REPO_ROOT = Path(__file__).resolve().parents[2]
COMPILED_PATH = REPO_ROOT / "worker" / "src" / "generated" / "catalog.json"


class PublicCatalogError(ValueError):
    """Raised when the committed consumer artifact violates its contract."""


class PublicMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric_id: StrictStr
    label_en: StrictStr
    label_es: StrictStr
    description: StrictStr
    description_es: StrictStr
    granularity: Granularity
    unit: StrictStr
    decimals: StrictInt = Field(ge=0, le=6)


class PublicCoverageCell(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric: StrictStr
    entity_type: EntityType
    granularity: Granularity
    season: StrictStr
    competition: StrictStr
    source_id: StrictStr
    redistributable: StrictBool
    cost_class: CostClass
    attribution_asset: StrictStr | None
    attribution_text: StrictStr | None
    attribution_text_es: StrictStr | None
    source_name: StrictStr

    @property
    def key(self) -> tuple[str, EntityType, Granularity, str, str]:
        return (
            self.metric,
            self.entity_type,
            self.granularity,
            self.season,
            self.competition,
        )


class PublicCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    metrics: list[PublicMetric]
    coverage: list[PublicCoverageCell]


def _require_nonempty(value: str | None, path: str) -> None:
    if value is not None and not value.strip():
        raise PublicCatalogError(f"{path} must be non-empty when present")


def validate_public_catalog_value(value: object) -> PublicCatalog:
    """Decode the closed public shape and enforce cross-record invariants."""
    if not isinstance(value, dict):
        raise PublicCatalogError("catalog must be an object")
    version = value.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != 1:
        raise PublicCatalogError("version must be integer 1")

    try:
        catalog = PublicCatalog.model_validate(value)
    except ValidationError as exc:
        raise PublicCatalogError(f"public catalog schema violation: {exc}") from exc

    metrics: dict[str, PublicMetric] = {}
    for index, metric in enumerate(catalog.metrics):
        _require_nonempty(metric.metric_id, f"metrics[{index}].metric_id")
        if metric.metric_id in metrics:
            raise PublicCatalogError(f"duplicate metric_id: {metric.metric_id}")
        metrics[metric.metric_id] = metric

    seen_cells: set[tuple[str, EntityType, Granularity, str, str]] = set()
    source_display: dict[str, tuple[object, ...]] = {}
    for index, cell in enumerate(catalog.coverage):
        for field in ("metric", "season", "competition", "source_id", "source_name"):
            _require_nonempty(getattr(cell, field), f"coverage[{index}].{field}")
        if re.fullmatch(r"[a-z][a-z0-9_]*", cell.source_id) is None:
            raise PublicCatalogError(
                f"coverage[{index}].source_id does not match the public contract"
            )

        if cell.key in seen_cells:
            raise PublicCatalogError(f"duplicate coverage cell: {cell.key}")
        seen_cells.add(cell.key)

        metric = metrics.get(cell.metric)
        if metric is None:
            raise PublicCatalogError(
                f"coverage[{index}] references missing metric: {cell.metric}"
            )
        if cell.granularity is not metric.granularity:
            raise PublicCatalogError(
                f"coverage[{index}] granularity disagrees with metric {cell.metric}"
            )

        display = (
            cell.source_name,
            cell.redistributable,
            cell.attribution_asset,
            cell.attribution_text,
            cell.attribution_text_es,
        )
        prior = source_display.setdefault(cell.source_id, display)
        if prior != display:
            raise PublicCatalogError(
                f"coverage[{index}] source display disagrees for {cell.source_id}"
            )

    return catalog


def load_public_catalog(path: Path = COMPILED_PATH) -> PublicCatalog:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublicCatalogError(f"cannot read public catalog: {exc}") from exc
    return validate_public_catalog_value(value)


def main() -> int:
    try:
        catalog = load_public_catalog()
    except PublicCatalogError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1
    print(
        f"public catalog OK: {len(catalog.metrics)} metrics, "
        f"{len(catalog.coverage)} coverage cells -> "
        f"{COMPILED_PATH.relative_to(REPO_ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
