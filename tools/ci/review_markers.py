#!/usr/bin/env python3
"""Validate review verdict markers against the exact pull request head."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unicodedata


SHA = r"[0-9a-fA-F]{40}"
SHA_RE = re.compile(rf"^{SHA}$")
ROLES = ("Reviewer", "Validator", "Red-team")
MARKER_RE = re.compile(rf"^(Reviewer|Validator|Red-team): (APPROVE|PASS) ({SHA})$", re.MULTILINE)
NEGATIVE_RE = re.compile(r"^(Reviewer|Validator|Red-team): (FAIL|REQUEST_CHANGES|BLOCK|CHANGES)\b", re.MULTILINE)
BYTE_CHECK = re.compile(rf"^Lead: BYTE-CHECK ({SHA}) ({SHA})$", re.MULTILINE)
PROTECTED_PREFIXES = (
    ".github/", ".claude/", ".codex/", ".agents/", "infra/",
    "worker/src/security/", "worker/src/budget/", "tools/ci/", "scripts/",
    "gauntlet/", "tools/fleet/", "tools/", "catalog/rights/",
)
PROTECTED_FILES = {
    ".mcp.json", ".gitmodules", "package.json", "package-lock.json",
    "pyproject.toml", "uv.lock", ".gitleaks.toml", ".gitignore",
}
PROTECTED_BASENAMES = {".pre-commit-config.yaml"}


def canonical(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold().removeprefix("./")


def is_protected(path: str) -> bool:
    normalized = canonical(path)
    basename = normalized.rsplit("/", 1)[-1]
    agent_doc = basename.endswith(".md") and basename.startswith(("agents", "claude"))
    return (normalized in PROTECTED_FILES or basename in PROTECTED_BASENAMES or agent_doc
            or normalized.startswith(PROTECTED_PREFIXES))


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False, timeout=30)


def _git_ok(*args: str) -> str:
    result = _git(*args)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args[:2])} failed")
    return result.stdout


def changed_paths(base_sha: str, head_sha: str) -> list[str]:
    output = _git_ok("diff", "--name-only", "-z", "--no-renames", f"{base_sha}...{head_sha}")
    return [path for path in output.split("\0") if path]


def _visible_body(body: str) -> str:
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    return re.sub(r"(^|\n)(```|~~~)[^\n]*\n.*?\n\2[^\n]*(?=\n|$)", "", body, flags=re.DOTALL)


def _verdicts(body: str, sha: str, protected: bool) -> bool:
    visible = _visible_body(body)
    if NEGATIVE_RE.search(visible):
        return False
    seen: dict[str, set[str]] = {role: set() for role in ROLES}
    for match in MARKER_RE.finditer(visible):
        role, verdict, marker_sha = match.groups()
        if marker_sha.lower() == sha.lower():
            seen[role].add(verdict)
    if any(len(values) > 1 for values in seen.values()):
        return False
    required = {"Reviewer": {"APPROVE"}, "Validator": {"PASS"}}
    if protected:
        required["Red-team"] = {"PASS"}
    return all(seen[role] == accepted for role, accepted in required.items())


def _byte_identical(base_sha: str, head_sha: str, judged_sha: str) -> bool:
    if judged_sha.lower() == base_sha.lower():
        return False
    # Reject judged heads already on base history before comparing their patch.
    if _git("merge-base", "--is-ancestor", judged_sha, base_sha).returncode == 0:
        return False
    judged_is_head_ancestor = _git("merge-base", "--is-ancestor", judged_sha, head_sha)
    if judged_is_head_ancestor.returncode != 0:
        if judged_is_head_ancestor.returncode != 1:
            raise RuntimeError(judged_is_head_ancestor.stderr.strip() or "git ancestry check failed")
        return False
    merge_base = _git_ok("merge-base", base_sha, judged_sha).strip()
    if not SHA_RE.fullmatch(merge_base):
        raise RuntimeError("git merge-base returned an invalid SHA")
    judged_patch = _git_ok("diff", "--no-renames", "--full-index", merge_base, judged_sha)
    head_patch = _git_ok("diff", "--no-renames", "--full-index", base_sha, head_sha)
    return judged_patch == head_patch


def check(base_sha: str, head_sha: str, body: str, head_repo: str, repository: str) -> tuple[bool, str]:
    if not SHA_RE.fullmatch(base_sha) or not SHA_RE.fullmatch(head_sha):
        return False, "base and head SHAs must each be 40 hex characters"
    if not head_repo or not repository or head_repo != repository:
        return False, "fork pull requests are not accepted"
    try:
        paths = changed_paths(base_sha, head_sha)
        if not paths:
            return False, "pull request has no changed files"
        protected = any(is_protected(path) for path in paths)
        if _verdicts(body, head_sha, protected):
            return True, "current-head verdict markers found"
        for match in BYTE_CHECK.finditer(_visible_body(body)):
            judged, target = match.groups()
            if target.lower() != head_sha.lower() or not SHA_RE.fullmatch(judged):
                continue
            if not _verdicts(body, judged, protected):
                continue
            if _byte_identical(base_sha, head_sha, judged):
                return True, "byte-identical PR-internal verdict markers found"
        return False, "body lacks valid verdict markers for the current head"
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        return False, f"cannot verify review markers: {exc}"


def main() -> int:
    ok, message = check(
        os.environ.get("BASE_SHA", "").strip(),
        os.environ.get("HEAD_SHA", "").strip(),
        os.environ.get("PR_BODY", "").replace("\r\n", "\n"),
        os.environ.get("HEAD_REPO", ""),
        os.environ.get("GITHUB_REPOSITORY", ""),
    )
    print(f"Review markers {'passed' if ok else 'failed'}: {message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
