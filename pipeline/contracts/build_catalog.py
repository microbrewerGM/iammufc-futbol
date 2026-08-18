"""Load, validate, and compile the capability catalog.

Two consumers:
  * the pipeline, which imports `load_catalog()` directly
  * the Worker, which reads the compiled JSON this module emits

The invariant checks here are the same ones the rights-gate CI job runs. That
is deliberate: a check that only exists in CI is discovered late, and a check
that only exists locally is skippable. The same function serves both.
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import yaml

from catalog.schemas.models import Catalog, CoverageCell, Metric, RightsEntry

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_DIR = REPO_ROOT / "catalog"
COMPILED_PATH = REPO_ROOT / "worker" / "src" / "generated" / "catalog.json"

#: A ToS snapshot older than this is an error. It governs what may legally be
#: published, so a lapsed one is a higher-consequence stale pin than any library.
TOS_MAX_AGE = timedelta(days=365)
TOS_WARN_AGE = timedelta(days=305)


class CatalogError(Exception):
    """Raised when a catalog invariant is violated. Always fatal."""


def _read_yaml(path: Path) -> dict:
    if not path.exists():
        raise CatalogError(f"missing catalog file: {path.relative_to(REPO_ROOT)}")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_catalog() -> Catalog:
    """Parse the three YAML files into a validated Catalog."""
    rights_raw = _read_yaml(CATALOG_DIR / "rights" / "manifest.yml").get("rights", [])
    metrics_raw = _read_yaml(CATALOG_DIR / "metrics" / "metrics.yml").get("metrics", [])
    coverage_raw = _read_yaml(CATALOG_DIR / "coverage" / "coverage.yml").get("coverage", [])

    return Catalog(
        rights=[RightsEntry(**r) for r in rights_raw],
        metrics=[Metric(**m) for m in metrics_raw],
        coverage=[CoverageCell(**c) for c in coverage_raw],
    )


def check_invariants(catalog: Catalog, today: date | None = None) -> list[str]:
    """Return a list of violations. Empty list means the catalog is sound.

    Returning rather than raising lets the caller report every problem at once,
    which matters when the caller is a CI job someone is reading on a phone.
    """
    today = today or date.today()
    rights = catalog.rights_by_id()
    metrics = catalog.metrics_by_id()
    errors: list[str] = []

    # Duplicate ids would make lookups non-deterministic.
    for label, items in (
        ("source_id", [r.source_id for r in catalog.rights]),
        ("metric_id", [m.metric_id for m in catalog.metrics]),
    ):
        dupes = {i for i in items if items.count(i) > 1}
        for d in sorted(dupes):
            errors.append(f"duplicate {label}: {d}")

    seen: set[tuple] = set()
    for cell in catalog.coverage:
        if cell.key in seen:
            errors.append(f"duplicate coverage cell: {cell.key}")
        seen.add(cell.key)

        # Every cell must resolve to a real source and a real metric.
        if cell.source_id not in rights:
            errors.append(
                f"coverage cell {cell.key} cites source '{cell.source_id}' "
                f"with no entry in rights/manifest.yml"
            )
        if cell.metric not in metrics:
            errors.append(
                f"coverage cell {cell.key} cites metric '{cell.metric}' "
                f"not declared in metrics/metrics.yml"
            )

        # A cell claiming redistributable while its source forbids it would let
        # unpublishable data reach the site. This is the highest-consequence
        # inconsistency the catalog can contain.
        src = rights.get(cell.source_id)
        if src and cell.redistributable and not src.redistributable:
            errors.append(
                f"coverage cell {cell.key} sets redistributable=true but source "
                f"'{cell.source_id}' is not redistributable"
            )

        # Granularity must match the metric's declaration, or a shot-map request
        # could silently resolve against box-score data.
        m = metrics.get(cell.metric)
        if m and m.granularity != cell.granularity:
            errors.append(
                f"coverage cell {cell.key} granularity '{cell.granularity.value}' "
                f"disagrees with metric '{cell.metric}' ({m.granularity.value})"
            )

    for r in catalog.rights:
        if r.tos_snapshot is None:
            errors.append(f"source '{r.source_id}' has no tos_snapshot")
        elif not (REPO_ROOT / r.tos_snapshot).exists():
            errors.append(
                f"source '{r.source_id}' references missing snapshot {r.tos_snapshot}"
            )

        age = today - r.verified_date
        if age > TOS_MAX_AGE:
            errors.append(
                f"source '{r.source_id}' ToS snapshot verified {r.verified_date} "
                f"({age.days} days ago) exceeds the 365-day limit"
            )

    # Every declared metric needs at least one cell, or the catalog is
    # advertising something it cannot answer.
    covered = {c.metric for c in catalog.coverage}
    for m in catalog.metrics:
        if m.metric_id not in covered:
            errors.append(
                f"metric '{m.metric_id}' has no coverage cell -- declare one or "
                f"remove the metric"
            )

    return errors


def warnings(catalog: Catalog, today: date | None = None) -> list[str]:
    today = today or date.today()
    out = []
    for r in catalog.rights:
        age = today - r.verified_date
        if TOS_WARN_AGE < age <= TOS_MAX_AGE:
            out.append(
                f"source '{r.source_id}' ToS snapshot is {age.days} days old -- "
                f"re-verify before it lapses at 365"
            )
    return out


def compile_for_worker(catalog: Catalog) -> dict:
    """Emit the shape the Worker reads.

    Rights are inlined per coverage cell so the Worker never has to join at
    request time, and so attribution travels with the thing it attributes.
    """
    rights = catalog.rights_by_id()
    return {
        "version": 1,
        "metrics": [m.model_dump(mode="json") for m in catalog.metrics],
        "coverage": [
            {
                **cell.model_dump(mode="json"),
                "attribution_asset": rights[cell.source_id].attribution_asset,
                "attribution_text": rights[cell.source_id].attribution_text,
                "source_name": rights[cell.source_id].name,
                "licence_id": rights[cell.source_id].licence_id,
            }
            for cell in catalog.coverage
            if cell.source_id in rights
        ],
    }


def main() -> int:
    catalog = load_catalog()

    errs = check_invariants(catalog)
    for w in warnings(catalog):
        print(f"WARN  {w}", file=sys.stderr)
    if errs:
        for e in errs:
            print(f"ERROR {e}", file=sys.stderr)
        print(f"\n{len(errs)} catalog invariant violation(s).", file=sys.stderr)
        return 1

    COMPILED_PATH.parent.mkdir(parents=True, exist_ok=True)
    compiled = compile_for_worker(catalog)
    COMPILED_PATH.write_text(
        json.dumps(compiled, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        f"catalog OK: {len(catalog.metrics)} metrics, "
        f"{len(catalog.coverage)} coverage cells, "
        f"{len(catalog.rights)} sources -> {COMPILED_PATH.relative_to(REPO_ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
