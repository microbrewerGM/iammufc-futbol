#!/usr/bin/env python3
"""Validate pull request verdict markers against the exact current head."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unicodedata


SHA = r"[0-9a-fA-F]{40}"
SHA_RE = re.compile(rf"^{SHA}$")
MARKERS = {
    "reviewer": re.compile(rf"^Reviewer: APPROVE ({SHA})$", re.MULTILINE),
    "validator": re.compile(rf"^Validator: (?:PASS|CI [^\r\n]+ on) ({SHA})$", re.MULTILINE),
    "red-team": re.compile(rf"^Red-team: PASS ({SHA})$", re.MULTILINE),
}
BYTE_CHECK = re.compile(rf"^Lead: BYTE-CHECK ({SHA}) ({SHA})$", re.MULTILINE)
PROTECTED_PREFIXES = (
    ".github/", ".claude/", ".codex/", ".agents/", "infra/",
    "worker/src/security/", "tools/ci/", "gauntlet/", "tools/fleet/",
)
PROTECTED_FILES = {".mcp.json", ".gitmodules"}
PROTECTED_BASENAMES = {".pre-commit-config.yaml"}


def canonical(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold().removeprefix("./")


def is_protected(path: str) -> bool:
    normalized = canonical(path)
    basename = normalized.rsplit("/", 1)[-1]
    agent_doc = basename.endswith(".md") and basename.startswith(("agents", "claude"))
    return (
        normalized in PROTECTED_FILES
        or basename in PROTECTED_BASENAMES
        or agent_doc
        or normalized.startswith(PROTECTED_PREFIXES)
    )


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False, timeout=30
    )


def changed_paths(base_sha: str, head_sha: str) -> list[str]:
    result = _git("diff", "--name-only", "-z", "--no-renames", f"{base_sha}...{head_sha}")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git diff failed")
    return [path for path in result.stdout.split("\0") if path]


def is_ancestor(judged: str, head: str) -> bool:
    result = _git("merge-base", "--is-ancestor", judged, head)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or "git ancestry check failed")
    return result.returncode == 0


def _has_marker(body: str, role: str, sha: str) -> bool:
    return any(match.group(1).lower() == sha.lower() for match in MARKERS[role].finditer(body))


def _verdicts_for(body: str, judged: str, protected: bool) -> bool:
    required = ("reviewer", "validator", "red-team") if protected else ("reviewer", "validator")
    return all(_has_marker(body, role, judged) for role in required)


def check(base_sha: str, head_sha: str, body: str) -> tuple[bool, str]:
    if not SHA_RE.fullmatch(base_sha) or not SHA_RE.fullmatch(head_sha):
        return False, "base and head SHAs must each be 40 hex characters"
    try:
        paths = changed_paths(base_sha, head_sha)
        if not paths:
            return False, "pull request has no changed files"
        protected = any(is_protected(path) for path in paths)
        if _verdicts_for(body, head_sha, protected):
            return True, "current-head verdict markers found"
        for match in BYTE_CHECK.finditer(body):
            judged, target = match.groups()
            if target.lower() != head_sha.lower():
                continue
            if not _verdicts_for(body, judged, protected):
                continue
            try:
                if is_ancestor(judged, head_sha):
                    return True, "ancestor verdict markers and byte-check found"
            except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
                return False, f"cannot verify judged-head ancestry: {exc}"
        return False, "body lacks verdict markers for the current head"
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        return False, f"cannot list changed paths: {exc}"


def main() -> int:
    ok, message = check(
        os.environ.get("BASE_SHA", "").strip(),
        os.environ.get("HEAD_SHA", "").strip(),
        os.environ.get("PR_BODY", "").replace("\r\n", "\n"),
    )
    print(f"Review markers {'passed' if ok else 'failed'}: {message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
