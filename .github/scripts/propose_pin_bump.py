#!/usr/bin/env python3
"""Turn one pin_check.py Proposal into one branch, one commit, one PR.

ADR-0004: "one PR per pin site, never combined -- a phone-reviewable diff is
the whole point." This script enforces that by construction: it is invoked
once per proposal, edits exactly the file that proposal names, and never
batches.

Default is --dry-run: print what would happen, touch nothing. Requires
--apply AND a real git remote to actually branch/commit/push/open a PR --
there is no value pretending those succeed against a repository that doesn't
have one yet (this project's M0 GitHub setup is a separate, human step; see
docs/runbooks/m0-github-setup.md).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True, **kw)


def has_remote() -> bool:
    r = run(["git", "remote", "get-url", "origin"])
    return r.returncode == 0


def apply_npm(name: str, target: str, path: Path | None = None) -> Path:
    path = path or (REPO_ROOT / "package.json")
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(rf'("{re.escape(name)}"\s*:\s*")[^"]+(")')
    new_text, n = pattern.subn(rf"\g<1>{target}\g<2>", text)
    if n != 1:
        raise RuntimeError(f"expected exactly one match for {name} in package.json, found {n}")
    path.write_text(new_text, encoding="utf-8")
    return path


def apply_python(name: str, target: str, path: Path | None = None) -> Path:
    path = path or (REPO_ROOT / "pyproject.toml")
    text = path.read_text(encoding="utf-8")
    # Matches `name==X.Y.Z` and `name[extra]==X.Y.Z` -- extras must survive the bump.
    pattern = re.compile(rf'({re.escape(name)}(?:\[[^\]]+\])?==)[\d.]+')
    new_text, n = pattern.subn(rf"\g<1>{target}", text)
    if n != 1:
        raise RuntimeError(f"expected exactly one match for {name} in pyproject.toml, found {n}")
    path.write_text(new_text, encoding="utf-8")
    return path


def apply_action(repo: str, target: str) -> list[Path]:
    """`target` is "<sha[:12]> (tag)" from pin_check.py; we need the full SHA,
    which the proposal doesn't carry (only the short form, for readability).
    Re-resolve it here rather than threading a second field through JSON."""
    m = re.match(r"([0-9a-f]{12,40})\s*\((\S+)\)", target)
    if not m:
        raise RuntimeError(f"unexpected action target format: {target!r}")
    tag = m.group(2)

    import urllib.request
    import os

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")

    def get(url):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "iammufc-pin-check",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    ref = get(f"https://api.github.com/repos/{repo}/git/ref/tags/{tag}")
    obj = ref["object"]
    full_sha = obj["sha"]
    if obj["type"] == "tag":
        full_sha = get(f"https://api.github.com/repos/{repo}/git/tags/{full_sha}")["object"]["sha"]

    changed = []
    workflows = REPO_ROOT / ".github" / "workflows"
    old_pin_re = re.compile(rf"({re.escape(repo)}(?:/\S+)?@)[0-9a-f]{{40}}(\s*#\s*)\S+")
    for path in sorted(workflows.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        new_text, n = old_pin_re.subn(rf"\g<1>{full_sha}\g<2>{tag}", text)
        if n:
            path.write_text(new_text, encoding="utf-8")
            changed.append(path)
    if not changed:
        raise RuntimeError(f"no workflow file referenced {repo} -- nothing to change")
    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("proposal_json", help="one JSON object from pin_check.py --json")
    ap.add_argument("--apply", action="store_true", help="actually branch/commit/push/PR")
    args = ap.parse_args()

    p = json.loads(args.proposal_json)
    branch = f"pin-bump/{p['category']}-{re.sub(r'[^a-zA-Z0-9._-]', '-', p['name'])}"
    title = f"pin: {p['name']} {p['current']} -> {p['target']}"
    body = (
        f"Automated pin-review proposal ({p['site']}, {p['category']}).\n\n"
        f"Reason: {p['reason']}\n\n"
        f"See docs/pin-registry.md for the review cadence and "
        f"docs/adr/0003-dependency-version-policy.md / "
        f"docs/adr/0004-pin-everything-pinnable.md for the policy.\n\n"
        f"This PR was opened by the scheduled pin-check workflow, not a person "
        f"-- review it exactly as you would review any dependency bump."
    )

    if not args.apply:
        print(f"[dry-run] would open PR: {title}")
        print(f"[dry-run] branch: {branch}")
        print(f"[dry-run] body:\n{body}")
        return 0

    if not has_remote():
        print(
            "ERROR --apply requires a real git remote. This repository has none yet "
            "(see docs/runbooks/m0-github-setup.md, task #9). Run without --apply "
            "to see what would happen.",
            file=sys.stderr,
        )
        return 1

    if p["category"] == "npm":
        changed = [apply_npm(p["name"], p["target"])]
    elif p["category"] == "python":
        changed = [apply_python(p["name"], p["target"])]
    elif p["category"] == "actions":
        changed = apply_action(p["name"], p["target"])
    else:
        print(f"ERROR unknown category {p['category']!r} -- refusing to guess a file to edit", file=sys.stderr)
        return 1

    run(["git", "checkout", "-b", branch])
    run(["git", "add", *[str(c.relative_to(REPO_ROOT)) for c in changed]])
    run(["git", "commit", "-m", title])
    push = run(["git", "push", "-u", "origin", branch])
    if push.returncode != 0:
        print(f"ERROR git push failed:\n{push.stderr}", file=sys.stderr)
        return 1

    pr = run(["gh", "pr", "create", "--title", title, "--body", body])
    if pr.returncode != 0:
        print(f"ERROR gh pr create failed:\n{pr.stderr}", file=sys.stderr)
        return 1

    print(pr.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
