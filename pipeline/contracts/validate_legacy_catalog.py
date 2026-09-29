"""Read-only semantic parity with the legacy public producer.

Source retrieval and D1 production have not migrated yet, so deploy and nightly
runs must continue checking the legacy rights records and exact artifact parity
while they consume those adapters. This command deliberately does not regenerate
the public artifact. It remains authoritative until verifiable private-producer
attestation replaces it.
"""

from __future__ import annotations

import json
import sys

from pipeline.contracts.build_catalog import (
    check_invariants,
    compile_for_worker,
    load_catalog,
    warnings,
)
from pipeline.contracts.validate_public_catalog import (
    COMPILED_PATH,
    PublicCatalogError,
    validate_public_catalog_value,
)


def validate_legacy_parity(committed: object) -> tuple[int, int, int]:
    """Require the committed artifact to retain legacy rights provenance."""
    catalog = load_catalog()
    errors = check_invariants(catalog)
    if errors:
        raise PublicCatalogError(
            f"legacy catalog invariant violations: {'; '.join(errors)}"
        )

    compiled = compile_for_worker(catalog)
    validate_public_catalog_value(compiled)
    if committed != compiled:
        raise PublicCatalogError(
            "committed public catalog does not match the reviewed legacy "
            "rights/coverage producer"
        )
    return len(catalog.metrics), len(catalog.coverage), len(catalog.rights)


def main() -> int:
    try:
        committed = json.loads(COMPILED_PATH.read_text(encoding="utf-8"))
        counts = validate_legacy_parity(committed)
    except (OSError, json.JSONDecodeError, PublicCatalogError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1
    for warning in warnings(load_catalog()):
        print(f"WARN  {warning}", file=sys.stderr)
    print(
        f"legacy catalog parity OK: {counts[0]} metrics, "
        f"{counts[1]} coverage cells, {counts[2]} sources"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
