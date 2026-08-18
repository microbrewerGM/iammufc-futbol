#!/usr/bin/env python3
"""Compute pin-bump proposals for every category in docs/pin-registry.md.

This is the "what should change" half of the periodic review cycle. It never
writes anything itself -- `propose_pin_bump.py` (invoked by the scheduled
workflow) consumes its JSON output to edit one file and open one PR per site,
per ADR-0004's "one PR per pin site, never combined" rule.

Four checks, matching the registry:

  npm      package.json dependencies/devDependencies    -> ADR-0003 N-1 minor
  python   pyproject.toml dependencies + dependency-groups -> ADR-0003 N-1 minor
  actions  .github/workflows/*.yml third-party actions   -> latest verified
           release (Actions are governed by ADR-0004's review cadence, not
           N-1 -- the risk N-1 defends against is a hostile FRESH release;
           actions are already SHA-pinned and comment-verified by
           check_action_pins.py, so quarterly review means catching up to the
           current verified tag, not lagging deliberately)
  rights   catalog/rights/manifest.yml verified_date freshness -> P9

Usage:
    uv run python .github/scripts/pin_check.py [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    print("ERROR needs Python 3.11+. Run via `uv run python`.", file=sys.stderr)
    raise SystemExit(1) from None


# ---------------------------------------------------------------------------
# Shared: version parsing and the N-1-minor rule (ADR-0003)
# ---------------------------------------------------------------------------


def _parse(v: str) -> tuple[int, int, int] | None:
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", v)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def n1_minor(current: str, candidates: list[str]) -> str | None:
    """The ADR-0003 target: latest major, minor one behind current-latest,
    highest patch of that minor. Falls back to a patch step when the latest
    release has no prior minor in its major (rule 2).

    Deliberately returns None -- no mechanical proposal -- when `current` sits
    on an OLDER MAJOR than latest. Found by testing: an early version of this
    function computed a same-major patch-step relative to latest's own major
    even when current was several majors behind, which produced "typescript
    5.9.3 -> 7.0.2" and "vitest 4.1.10 -> 5.0.0" -- silently proposing to cross
    exactly the major-version boundaries ADR-0003 rule 2 and the exceptions
    register (E-001, E-002) exist to prevent automating past. A cross-major
    gap is a judgment call — TypeScript 7 is a compiler rewrite, vitest 5 has
    a peer-dependency constraint from vitest-pool-workers — not a mechanical
    N-1 computation. Leave it for a human, which is exactly what happened the
    first time around."""
    parsed = sorted((p for v in candidates if (p := _parse(v))), key=lambda p: p)
    cur = _parse(current)
    if not parsed or cur is None:
        return None

    latest = parsed[-1]
    major, minor, _ = latest

    if cur[0] != major:
        return None  # cross-major: not this function's call to make

    minors_in_latest_major = sorted({p[1] for p in parsed if p[0] == major})
    idx = minors_in_latest_major.index(minor) if minor in minors_in_latest_major else -1

    if idx > 0:
        target_minor = minors_in_latest_major[idx - 1]
        target = max(p for p in parsed if p[0] == major and p[1] == target_minor)
    else:
        # Rule 2: no prior minor this major -- step the patch instead.
        same_major_minor = [p for p in parsed if p[0] == major and p[1] == minor]
        patches = sorted(same_major_minor)
        target = patches[-2] if len(patches) > 1 else patches[-1]

    if cur >= target:
        return None
    return ".".join(map(str, target))


def _get_json(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers={"User-Agent": "iammufc-pin-check", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


@dataclass
class Proposal:
    site: str          # registry id, e.g. "P1"
    category: str       # npm | python | actions | rights
    name: str
    current: str
    target: str
    reason: str


# ---------------------------------------------------------------------------
# npm (P1)
# ---------------------------------------------------------------------------


def check_npm() -> list[Proposal]:
    pkg_path = REPO_ROOT / "package.json"
    if not pkg_path.exists():
        return []
    data = json.loads(pkg_path.read_text(encoding="utf-8"))
    out = []
    for section in ("dependencies", "devDependencies"):
        for name, current in (data.get(section) or {}).items():
            try:
                versions = _get_json(f"https://registry.npmjs.org/{name}")["versions"].keys()
            except Exception as exc:
                print(f"SKIP npm {name}: {exc}", file=sys.stderr)
                continue
            target = n1_minor(current, list(versions))
            if target:
                out.append(
                    Proposal("P1", "npm", name, current, target, "ADR-0003 N-1 minor")
                )
    return out


# ---------------------------------------------------------------------------
# Python (P2)
# ---------------------------------------------------------------------------


def check_python() -> list[Proposal]:
    pj_path = REPO_ROOT / "pyproject.toml"
    if not pj_path.exists():
        return []
    data = tomllib.loads(pj_path.read_text(encoding="utf-8"))

    specs: list[str] = list(data.get("project", {}).get("dependencies", []) or [])
    for deps in (data.get("dependency-groups") or {}).values():
        specs += [d for d in deps if isinstance(d, str)]

    out = []
    for spec in specs:
        m = re.match(r"^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?==([\d.]+)", spec.replace(" ", ""))
        if not m:
            continue
        name, current = m[1], m[2]
        try:
            releases = _get_json(f"https://pypi.org/pypi/{name}/json")["releases"]
            versions = [v for v, files in releases.items() if files]
        except Exception as exc:
            print(f"SKIP pypi {name}: {exc}", file=sys.stderr)
            continue
        target = n1_minor(current, versions)
        if target:
            out.append(Proposal("P2", "python", name, current, target, "ADR-0003 N-1 minor"))
    return out


# ---------------------------------------------------------------------------
# GitHub Actions (P4) -- quarterly catch-up to the current verified release,
# reusing the same tag/SHA resolution as check_action_pins.py.
# ---------------------------------------------------------------------------


def check_actions(token: str | None) -> list[Proposal]:
    workflows = REPO_ROOT / ".github" / "workflows"
    if not workflows.exists():
        return []

    uses_re = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#\s*(v?\d+\.\d+\.\d+\S*))?")
    seen: dict[str, str] = {}  # repo -> current pinned sha

    for path in sorted(workflows.glob("*.yml")):
        for line in path.read_text(encoding="utf-8").splitlines():
            m = uses_re.match(line)
            if not m:
                continue
            ref = m.group(1)
            if "@" not in ref or ref.startswith(("./", "docker://")):
                continue
            path_part, _, sha = ref.rpartition("@")
            repo = "/".join(path_part.split("/")[:2])
            seen[repo] = sha

    out = []
    for repo, current_sha in seen.items():
        try:
            # NOT /releases/latest. Found by testing: github/codeql-action
            # publishes two release tracks (its own vX.Y.Z semver AND
            # codeql-bundle-vX.Y.Z for bundle pinning), and /releases/latest
            # returned the bundle track -- a release OLDER than our current
            # pin (2026-08-12 vs the pinned commit's 2026-08-13). Trusting it
            # would have proposed a silent security-scanning-action REGRESSION
            # dressed as a routine catch-up. Take the highest proper vX.Y.Z
            # tag instead, matching how the pin was originally verified.
            tags = _get_json(
                f"https://api.github.com/repos/{repo}/tags?per_page=100",
                {"Authorization": f"Bearer {token}"} if token else None,
            )
            semver_tags = [t["name"] for t in tags if _parse(t["name"])]
            if not semver_tags:
                print(f"SKIP action {repo}: no vX.Y.Z tags found", file=sys.stderr)
                continue
            tag = max(semver_tags, key=lambda t: _parse(t))
            ref = _get_json(
                f"https://api.github.com/repos/{repo}/git/ref/tags/{tag}",
                {"Authorization": f"Bearer {token}"} if token else None,
            )
            obj = ref["object"]
            target_sha = obj["sha"]
            if obj["type"] == "tag":
                target_sha = _get_json(
                    f"https://api.github.com/repos/{repo}/git/tags/{target_sha}",
                    {"Authorization": f"Bearer {token}"} if token else None,
                )["object"]["sha"]
        except Exception as exc:
            print(f"SKIP action {repo}: {exc}", file=sys.stderr)
            continue

        if target_sha == current_sha:
            continue

        # Belt-and-braces against the class of bug above: whatever the tag
        # source, never propose a commit that is chronologically OLDER than
        # what is already pinned. A regression must never look like a routine
        # catch-up.
        try:
            cur_date = _get_json(
                f"https://api.github.com/repos/{repo}/commits/{current_sha}",
                {"Authorization": f"Bearer {token}"} if token else None,
            )["commit"]["committer"]["date"]
            target_date = _get_json(
                f"https://api.github.com/repos/{repo}/commits/{target_sha}",
                {"Authorization": f"Bearer {token}"} if token else None,
            )["commit"]["committer"]["date"]
        except Exception as exc:
            print(f"SKIP action {repo}: could not compare commit dates: {exc}", file=sys.stderr)
            continue

        if target_date < cur_date:
            print(
                f"SKIP action {repo}: proposed {tag} ({target_date}) is OLDER than "
                f"the current pin ({cur_date}) -- refusing to propose a regression",
                file=sys.stderr,
            )
            continue

        out.append(
            Proposal(
                "P4", "actions", repo, current_sha[:12], f"{target_sha[:12]} ({tag})",
                "quarterly catch-up to current verified release",
            )
        )
    return out


# ---------------------------------------------------------------------------
# Rights manifest freshness (P9) -- the highest-consequence one on the list.
# ---------------------------------------------------------------------------

WARN_AGE = timedelta(days=305)
MAX_AGE = timedelta(days=365)


def check_rights_freshness(today: date | None = None) -> list[Proposal]:
    import yaml  # local import: only this check needs it

    today = today or date.today()
    manifest = REPO_ROOT / "catalog" / "rights" / "manifest.yml"
    if not manifest.exists():
        return []
    data = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}

    out = []
    for r in data.get("rights", []):
        verified = date.fromisoformat(str(r["verified_date"]))
        age = today - verified
        if age > MAX_AGE:
            out.append(
                Proposal(
                    "P9", "rights", r["source_id"], str(verified), str(today),
                    f"ERROR: {age.days}d since verification, exceeds the 365-day limit",
                )
            )
        elif age > WARN_AGE:
            out.append(
                Proposal(
                    "P9", "rights", r["source_id"], str(verified), str(today),
                    f"WARN: {age.days}d since verification, re-verify before it lapses",
                )
            )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--skip-network", action="store_true",
        help="rights-freshness only; skip npm/pypi/actions lookups (offline dev)",
    )
    args = ap.parse_args()
    import os

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")

    proposals: list[Proposal] = []
    proposals += check_rights_freshness()
    if not args.skip_network:
        proposals += check_npm()
        proposals += check_python()
        proposals += check_actions(token)

    if args.json:
        print(json.dumps([asdict(p) for p in proposals], indent=2))
    else:
        if not proposals:
            print("no pin bumps due")
        for p in proposals:
            print(f"[{p.site}/{p.category}] {p.name}: {p.current} -> {p.target}  ({p.reason})")

    errors = [p for p in proposals if p.category == "rights" and "ERROR" in p.reason]
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
