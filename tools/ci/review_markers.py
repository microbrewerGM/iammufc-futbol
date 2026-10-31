#!/usr/bin/env python3
"""Validate review verdict markers against the exact pull request head."""

from __future__ import annotations

import os
import re
import subprocess
import unicodedata
import json
import urllib.error
import urllib.request


SHA = r"[0-9a-fA-F]{40}"
SHA_RE = re.compile(rf"^{SHA}$")
ROLES = ("Reviewer", "Validator", "Red-team")
NEGATIVE_PREFIXES = ("FAIL", "REJECT", "BLOCK", "CHANGES", "REQUEST")
BYTE_CHECK = re.compile(rf"^Lead: BYTE-CHECK ({SHA}) ({SHA})$", re.MULTILINE)
PROTECTED_PREFIXES = (
    ".github/",
    ".claude/",
    ".codex/",
    ".agents/",
    "infra/",
    "worker/src/security/",
    "worker/src/budget/",
    "tools/ci/",
    "scripts/",
    "gauntlet/",
    "tools/fleet/",
    "tools/",
    "catalog/rights/",
    "pipeline/contracts/",
)
PROTECTED_FILES = {
    ".mcp.json",
    ".gitmodules",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "uv.lock",
    ".gitleaks.toml",
    ".gitignore",
    ".nvmrc",
    ".node-version",
    "vitest.config.ts",
    "tsconfig.json",
    ".gitattributes",
    "tests/test_feasibility.py",
}
PROTECTED_BASENAMES = {".pre-commit-config.yaml", "gemini.md", "copilot_instructions.md"}


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
        or basename == ".npmrc"
        or basename.startswith(".yarnrc")
        or normalized.startswith(PROTECTED_PREFIXES)
    )


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
    visible, fence, length, comment = [], "", 0, False
    for line in body.splitlines(keepends=True):
        parts, i = [], 0
        while i < len(line):
            if comment:
                end = line.find("-->", i)
                if end < 0:
                    i = len(line)
                    break
                comment, i = False, end + 3
                continue
            start = line.find("<!--", i)
            if start < 0:
                parts.append(line[i:])
                break
            parts.append(line[i:start])
            comment, i = True, start + 4
        content = "".join(parts)
        if fence:
            if re.match(rf"^ {{0,3}}{re.escape(fence)}{{{length},}}[ \t]*(?:\r?\n)?$", content):
                fence, length = "", 0
            visible.append("\n" if content.endswith("\n") else "")
            continue
        opener = re.match(r"^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$", content)
        if opener:
            fence, length = opener.group(1)[0], len(opener.group(1))
            visible.append("\n" if content.endswith("\n") else "")
        else:
            visible.append(content)
    return "".join(visible)


def _verdicts(body: str, sha: str, protected: bool) -> bool:
    seen = {role: set() for role in ROLES}
    for line in _visible_body(body).splitlines():
        line = re.sub(r"^\s*(?:[-*]\s+)?\*{0,2}", "", line).strip()
        line = re.sub(r"\*{0,2}", "", line).strip()
        match = re.fullmatch(rf"(Reviewer|Validator|Red-team): (\S+) ({SHA})", line, re.I)
        if match:
            role, token, marker = match.groups()
            if marker.lower() == sha.lower():
                role = next(r for r in ROLES if r.lower() == role.lower())
                seen[role].add(token.upper())
    if any(
        any(token.startswith(p) for token in values for p in NEGATIVE_PREFIXES) or len(values) > 1
        for values in seen.values()
    ):
        return False
    required = {"Reviewer": {"APPROVE"}, "Validator": {"PASS"}}
    if protected:
        required["Red-team"] = {"PASS"}
    return all(seen[role] == accepted for role, accepted in required.items())


def _byte_identical(base_sha: str, head_sha: str, judged_sha: str) -> bool:
    if judged_sha.lower() == base_sha.lower():
        return False
    # Reject judged heads already on base history before comparing their patch.
    judged_base = _git("merge-base", "--is-ancestor", judged_sha, base_sha)
    if judged_base.returncode not in (0, 1):
        raise RuntimeError("git ancestry check failed")
    if judged_base.returncode == 0:
        return False
    judged_is_head_ancestor = _git("merge-base", "--is-ancestor", judged_sha, head_sha)
    if judged_is_head_ancestor.returncode != 0:
        if judged_is_head_ancestor.returncode != 1:
            raise RuntimeError(
                judged_is_head_ancestor.stderr.strip() or "git ancestry check failed"
            )
        return False
    merge_base = _git_ok("merge-base", base_sha, judged_sha).strip()
    if not SHA_RE.fullmatch(merge_base):
        raise RuntimeError("git merge-base returned an invalid SHA")
    judged_patch = _git_ok("diff", "--no-renames", "--full-index", merge_base, judged_sha)
    head_patch = _git_ok("diff", "--no-renames", "--full-index", base_sha, head_sha)
    return judged_patch == head_patch


def check(
    base_sha: str, head_sha: str, body: str, head_repo: str, repository: str
) -> tuple[bool, str]:
    if not SHA_RE.fullmatch(base_sha) or not SHA_RE.fullmatch(head_sha):
        return False, "base and head SHAs must each be 40 hex characters"
    if base_sha != base_sha.lower() or head_sha != head_sha.lower():
        return False, "base and head SHAs must be lowercase"
    if not head_repo or not repository or head_repo != repository:
        return False, "fork pull requests are not accepted"
    try:
        paths = changed_paths(base_sha, head_sha)
        if not paths:
            return False, "pull request has no changed files"
        protected = any(is_protected(path) for path in paths)
        if _verdicts(body, head_sha, False) is False and any(
            re.search(
                rf"^(Reviewer|Validator|Red-team): (FAIL|REJECT|BLOCK|CHANGES|REQUEST)\S* {head_sha}$",
                line,
                re.I,
            )
            for line in _visible_body(body).splitlines()
        ):
            return False, "negative verdict for current head"
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


def _live_pull_request(repository, number, token):
    url = f"https://api.github.com/repos/{repository}/pulls/{number}"
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode())
    return payload["body"] or "", payload["head"]["sha"]


def main() -> int:
    try:
        live_body, live_head = _live_pull_request(
            os.environ.get("GITHUB_REPOSITORY", ""),
            os.environ.get("PR_NUMBER", ""),
            os.environ.get("GITHUB_TOKEN", ""),
        )
        event_head = os.environ.get("HEAD_SHA", "").strip()
        if live_head != event_head:
            raise RuntimeError("live head differs from event head")
        ok, message = check(
            os.environ.get("BASE_SHA", "").strip(),
            live_head,
            live_body,
            os.environ.get("HEAD_REPO", ""),
            os.environ.get("GITHUB_REPOSITORY", ""),
        )
    except Exception as exc:
        ok, message = False, str(exc)
    print(f"Review markers {'passed' if ok else 'failed'}: {message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
