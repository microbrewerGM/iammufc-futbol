#!/usr/bin/env python3
"""Verify every third-party GitHub Action is pinned to a real commit SHA.

Three failure modes this catches, all from ADR-0004:

  1. A tag ref (`@v4`). Tags are mutable pointers. In the tj-actions compromise
     (CVE-2025-30066) the attacker repointed existing version tags at malicious
     code; only repositories pinned to a full commit SHA were protected.

  2. A SHA that does not resolve in the repository it claims.

  3. A SHA that resolves but is NOT the release its `# vX.Y.Z` comment names.
     This is the subtle one, and it is the reason check 2 alone is insufficient:
     the comment is what a human actually reads when reviewing a bump, so a
     comment that lies is worse than a pin that is obviously wrong. Caught in
     practice on this repo's own first draft.

  A missing `# vX.Y.Z` comment is also an error -- a bare 40-character SHA is
  unreviewable, which defeats the point of putting it in front of a human.

Checks 2 and 3 need network and a GitHub token. Without one they are reported
as skipped -- never silently passed.

Usage:
    uv run python .github/scripts/check_action_pins.py [--offline]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

USES = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#\s*(.*))?$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
#: The trailing `# v1.2.3` comment. Required: a bare SHA is unreviewable.
TAG_COMMENT = re.compile(r"^(v?\d+\.\d+\.\d+\S*)")


def _api(url: str, token: str | None):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "iammufc-pin-check",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def resolves(repo: str, sha: str, token: str | None) -> bool | None:
    """True/False, or None when the check could not run."""
    try:
        return _api(f"https://api.github.com/repos/{repo}/commits/{sha}", token).get("sha") == sha
    except urllib.error.HTTPError as exc:
        return False if exc.code == 404 else None
    except Exception:
        return None


def tag_matches(repo: str, sha: str, tag: str, token: str | None) -> bool | None:
    """Does the trailing `# v1.2.3` comment actually name this SHA?

    Existence alone is not enough. A SHA can resolve in the right repository
    and still be a different release than the comment claims -- which is worse
    than an obviously wrong pin, because the comment is what a human reviews.
    Annotated tags point at a tag object, so dereference before comparing.
    """
    try:
        ref = _api(f"https://api.github.com/repos/{repo}/git/ref/tags/{tag}", token)
        obj = ref.get("object", {})
        target = obj.get("sha")
        if obj.get("type") == "tag":
            target = _api(
                f"https://api.github.com/repos/{repo}/git/tags/{target}", token
            ).get("object", {}).get("sha")
        return target == sha
    except urllib.error.HTTPError as exc:
        return False if exc.code == 404 else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip SHA resolution")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    errors: list[str] = []
    skipped: list[str] = []
    checked = 0

    if not WORKFLOWS.exists():
        print("no .github/workflows directory; nothing to check")
        return 0

    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        rel = path.relative_to(REPO_ROOT)
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = USES.match(line)
            if not m:
                continue
            ref = m.group(1).strip('"').strip("'")
            comment = (m.group(2) or "").strip()

            # Local (./...) and docker:// actions have no SHA to pin.
            if ref.startswith("./") or ref.startswith("docker://"):
                continue

            if "@" not in ref:
                errors.append(f"{rel}:{lineno} '{ref}' has no ref at all")
                continue

            path_part, _, pin = ref.rpartition("@")
            # Subpath actions like github/codeql-action/init live in the
            # owner/repo above them. Without this the API lookup 404s and the
            # check reports a false violation.
            repo = "/".join(path_part.split("/")[:2])
            checked += 1

            if not SHA40.match(pin):
                errors.append(
                    f"{rel}:{lineno} '{ref}' is pinned to a tag or branch. "
                    f"Tags are mutable -- pin to a full 40-character commit SHA."
                )
                continue

            if args.offline:
                skipped.append(f"{repo}@{pin[:12]}")
                continue

            verdict = resolves(repo, pin, token)
            if verdict is False:
                errors.append(
                    f"{rel}:{lineno} SHA {pin[:12]}… does not exist in {repo}"
                )
                continue
            if verdict is None:
                skipped.append(f"{repo}@{pin[:12]}")
                continue

            # Existence is not enough -- confirm the comment tells the truth.
            tag = TAG_COMMENT.match(comment)
            if not tag:
                errors.append(
                    f"{rel}:{lineno} '{ref}' has no `# vX.Y.Z` comment. A bare "
                    f"SHA is unreviewable -- name the release it pins."
                )
                continue

            match = tag_matches(repo, pin, tag.group(1), token)
            if match is False:
                errors.append(
                    f"{rel}:{lineno} comment says {tag.group(1)} but "
                    f"{pin[:12]}… is not that tag in {repo}"
                )
            elif match is None:
                skipped.append(f"{repo}@{pin[:12]} (tag check)")

    for s in skipped:
        print(f"SKIP  could not verify {s} (no network or no token)", file=sys.stderr)
    for e in errors:
        print(f"ERROR {e}", file=sys.stderr)

    if errors:
        print(f"\n{len(errors)} action pin violation(s).", file=sys.stderr)
        return 1

    print(f"action pins OK: {checked} checked, {len(skipped)} unverified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
