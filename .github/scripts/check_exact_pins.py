#!/usr/bin/env python3
"""Verify dependency manifests use exact pins, never ranges (ADR-0004).

A range defers the version decision to install time, so two machines can get
different trees and the lockfile becomes the only real record of what ran. This
also enforces the N-1 minor policy in practice: you cannot follow ADR-0003 with
a caret, because the caret decides for you.

Checks package.json (dependencies + devDependencies) and pyproject.toml
(project.dependencies + dependency-groups).

Deliberately does NOT check transitive dependencies -- those are the lockfile's
job, and it does it with integrity hashes, which is stronger than anything
expressible here.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# tomllib is stdlib from 3.11. The project targets 3.12, but this script also
# runs under whatever `python3` a runner or a laptop happens to provide.
try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - depends on interpreter
    print(
        "ERROR this check needs Python 3.11+ for tomllib. Run it with "
        "`uv run python .github/scripts/check_exact_pins.py`.",
        file=sys.stderr,
    )
    raise SystemExit(1) from None

REPO_ROOT = Path(__file__).resolve().parents[2]

NPM_EXACT = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
PY_EXACT = re.compile(r"^[A-Za-z0-9._-]+(?:\[[^\]]+\])?==\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?$")


def check_package_json(errors: list[str]) -> int:
    path = REPO_ROOT / "package.json"
    if not path.exists():
        return 0
    data = json.loads(path.read_text(encoding="utf-8"))
    count = 0
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, spec in (data.get(section) or {}).items():
            count += 1
            # Local and protocol specifiers are not versions at all.
            if spec.startswith(("file:", "link:", "workspace:", "npm:")):
                continue
            if not NPM_EXACT.match(spec):
                errors.append(
                    f"package.json {section}.{name} = '{spec}' is not an exact "
                    f"version. Ranges are not permitted (ADR-0004)."
                )
    return count


def check_pyproject(errors: list[str]) -> int:
    path = REPO_ROOT / "pyproject.toml"
    if not path.exists():
        return 0
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    count = 0

    groups: list[tuple[str, list[str]]] = [
        ("project.dependencies", data.get("project", {}).get("dependencies", []) or [])
    ]
    for group, deps in (data.get("dependency-groups") or {}).items():
        groups.append((f"dependency-groups.{group}", [d for d in deps if isinstance(d, str)]))

    for label, deps in groups:
        for spec in deps:
            count += 1
            normalized = spec.replace(" ", "")
            if not PY_EXACT.match(normalized):
                errors.append(
                    f"pyproject.toml {label}: '{spec}' is not an exact `==` pin. "
                    f"Ranges are not permitted (ADR-0004)."
                )
    return count


def main() -> int:
    errors: list[str] = []
    total = check_package_json(errors) + check_pyproject(errors)

    for e in errors:
        print(f"ERROR {e}", file=sys.stderr)
    if errors:
        print(f"\n{len(errors)} inexact pin(s).", file=sys.stderr)
        return 1

    print(f"exact pins OK: {total} direct dependencies checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
