#!/usr/bin/env python3
"""Validate exact-head verdicts in an allow-listed pull request body.

Allowed body lines are canonical verdicts (Reviewer: APPROVE, Validator: PASS,
Red-team: PASS, or Lead: BYTE-CHECK with lowercase 40-hex SHAs), blank lines,
the exact Claude Code footer, a Claude session URL, or plain ASCII prose using
only letters, digits, spaces, and `,.;:()'\"/#?=%+@-`. Prose cannot contain
verdict-related words. Verdict lines form one contiguous block separated from
prose by blank lines.
Stale canonical verdict lines must be replaced; an old verdict alongside a
current one makes the allow-listed block invalid.

Only regular .ts files under worker/src/views/ except layout.ts, files under
tests/ ending in .test.ts, Markdown files under docs/, and root README.md skip
the red-team verdict. Every other changed path requires
Red-team: PASS for the head. Prose deny words are not verdicts: a
human-written FAIL in prose is not machine-read; failed heads have no PASS
line because the integrator does not write one for them.
"""

from __future__ import annotations

import os
import re
import subprocess
import json
import unicodedata
import urllib.error
import urllib.request


SHA = r"[0-9a-f]{40}"
SHA_RE = re.compile(rf"^{SHA}$")
ROLES = ("Reviewer", "Validator", "Red-team")
CANONICAL_MARKER = re.compile(
    rf"^(?:Reviewer: APPROVE {SHA}|Validator: PASS {SHA}|"
    rf"Red-team: PASS {SHA}|Lead: BYTE-CHECK {SHA} {SHA})$"
)
SESSION_URL = re.compile(r"^https://claude\.ai/code/session_[A-Za-z0-9_-]+$")
PROSE_LINE = re.compile(r'^[A-Za-z0-9 ,.;:()\'"/#?=%+@-]*$')
PROSE_FORBIDDEN = re.compile(
    r"reviewer|validator|red-team|red team|redteam|lead:|approve|fail|reject|block|byte-check",
    re.IGNORECASE,
)
FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
def needs_red_team(path: str) -> bool:
    normalized = path.removeprefix("./")
    if normalized == "README.md":
        return False
    if not path.isascii() or unicodedata.normalize("NFC", path) != path or path.casefold() != path:
        return True
    if normalized.startswith("docs/") and normalized.endswith(".md"):
        return False
    if normalized.startswith("tests/") and normalized.endswith(".test.ts"):
        return False
    if normalized.startswith("worker/src/views/") and normalized.endswith(".ts") and normalized != "worker/src/views/layout.ts":
        return False
    return True


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False, timeout=30)


def _git_ok(*args: str) -> str:
    result = _git(*args)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args[:2])} failed")
    return result.stdout


def changed_paths(base_sha: str, head_sha: str) -> list[str]:
    output = _git_ok("diff", "--raw", "--no-renames", f"{base_sha}...{head_sha}")
    paths = []
    for line in output.splitlines():
        match = re.match(r"^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\t(.*)$", line)
        if not match:
            raise RuntimeError("cannot parse raw git diff")
        old_mode, new_mode, path = match.groups()
        paths.append(path)
        if old_mode in {"120000", "160000"} or new_mode in {"120000", "160000"}:
            paths.append("__unsupported_file_mode__")
    return paths


def _normalized_body(body: str) -> str:
    return body.replace("\r\n", "\n").replace("\r", "\n")


def _allowed_line(line: str) -> bool:
    if CANONICAL_MARKER.fullmatch(line) or not line or line == FOOTER or SESSION_URL.fullmatch(line):
        return True
    return bool(PROSE_LINE.fullmatch(line) and not PROSE_FORBIDDEN.search(line))


def _allowed_body(body: str) -> bool:
    lines = _normalized_body(body).split("\n")
    if not all(_allowed_line(line) for line in lines):
        return False
    marker_indexes = [i for i, line in enumerate(lines) if CANONICAL_MARKER.fullmatch(line)]
    if not marker_indexes:
        return True
    start, end = marker_indexes[0], marker_indexes[-1]
    if marker_indexes != list(range(start, end + 1)):
        return False
    return (start == 0 or lines[start - 1] == "") and (end == len(lines) - 1 or lines[end + 1] == "")


def _verdicts(body: str, sha: str, protected: bool) -> bool:
    if not _allowed_body(body):
        return False
    seen: dict[str, set[str]] = {role: set() for role in ROLES}
    for line in _normalized_body(body).split("\n"):
        if line.startswith("Reviewer:"):
            seen["Reviewer"].add(line.removeprefix("Reviewer: "))
        elif line.startswith("Validator:"):
            seen["Validator"].add(line.removeprefix("Validator: "))
        elif line.startswith("Red-team:"):
            seen["Red-team"].add(line.removeprefix("Red-team: "))

    if seen["Reviewer"] != {f"APPROVE {sha}"} or seen["Validator"] != {f"PASS {sha}"}:
        return False
    if protected and seen["Red-team"] != {f"PASS {sha}"}:
        return False
    if seen["Red-team"] and seen["Red-team"] != {f"PASS {sha}"}:
        return False
    return not (seen["Red-team"] - {f"PASS {sha}"})


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
    body = _normalized_body(body)
    try:
        paths = changed_paths(base_sha, head_sha)
        if not paths:
            return False, "pull request has no changed files"
        protected = any(needs_red_team(path) for path in paths)
        if _verdicts(body, head_sha, protected):
            return True, "current-head verdict markers found"
        for line in body.split("\n"):
            match = re.fullmatch(rf"Lead: BYTE-CHECK ({SHA}) ({SHA})", line)
            if not match:
                continue
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
    class RejectRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise urllib.error.HTTPError(req.full_url, code, "redirect rejected", headers, fp)

    opener = urllib.request.build_opener(RejectRedirects)
    with opener.open(request, timeout=20) as response:
        if response.geturl() != url:
            raise RuntimeError("live pull request response redirected")
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
