from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("review_markers", ROOT / "tools/ci/review_markers.py")
review_markers = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(review_markers)

HEAD = "a" * 40
BASE = "b" * 40
OTHER = "c" * 40


class GitStub:
    paths = ["src/app.ts"]
    ancestry = True
    fail_diff = False

    @classmethod
    def run(cls, argv, **kwargs):
        if argv[1] == "diff":
            if cls.fail_diff:
                return subprocess.CompletedProcess(argv, 2, "", "stubbed diff failure")
            return subprocess.CompletedProcess(argv, 0, "\0".join(cls.paths) + "\0", "")
        if argv[1] == "merge-base":
            code = 0 if cls.ancestry else 1
            return subprocess.CompletedProcess(argv, code, "", "")
        raise AssertionError(argv)


@pytest.fixture(autouse=True)
def stub_git(monkeypatch):
    GitStub.paths = ["src/app.ts"]
    GitStub.ancestry = True
    GitStub.fail_diff = False
    monkeypatch.setattr(review_markers.subprocess, "run", GitStub.run)


def body(sha=HEAD, *, red_team=False):
    lines = [f"Reviewer: APPROVE {sha}", f"Validator: PASS {sha}"]
    if red_team:
        lines.append(f"Red-team: PASS {sha}")
    return "\n".join(lines)


@pytest.mark.parametrize(
    ("description", "paths", "text", "expected"),
    [
        ("missing marker", ["src/app.ts"], f"Validator: PASS {HEAD}", False),
        ("stale SHA", ["src/app.ts"], body(OTHER), False),
        ("lowercase hex", ["src/app.ts"], body(HEAD), True),
        ("uppercase hex", ["src/app.ts"], body(HEAD.upper()), True),
        ("valid", ["src/app.ts"], body(), True),
        ("protected without red-team", ["infra/config.toml"], body(), False),
        (
            "byte-check line",
            ["src/app.ts"],
            f"{body(BASE)}\nLead: BYTE-CHECK {BASE} {HEAD}",
            True,
        ),
        (
            "injection-shaped body text",
            ["src/app.ts"],
            f"$(injected shell text)\n{body()}",
            True,
        ),
    ],
)
def test_verdict_cases(description, paths, text, expected):
    GitStub.paths = paths
    ok, _ = review_markers.check(BASE, HEAD, text)
    assert ok is expected, description


def test_protected_paths_pass_with_red_team():
    GitStub.paths = ["infra/config.toml"]
    assert review_markers.check(BASE, HEAD, body(red_team=True))[0]


def test_byte_check_requires_ancestor():
    GitStub.ancestry = False
    text = f"{body(BASE)}\nLead: BYTE-CHECK {BASE} {HEAD}"
    assert not review_markers.check(BASE, HEAD, text)[0]


def test_empty_diff_and_git_error_fail_closed():
    GitStub.paths = []
    assert not review_markers.check(BASE, HEAD, body())[0]
    GitStub.fail_diff = True
    assert not review_markers.check(BASE, HEAD, body())[0]


def test_invalid_sha_fails_closed():
    assert not review_markers.check("missing", HEAD, body())[0]


def test_workflow_shape():
    workflow = (ROOT / ".github/workflows/review-markers.yml").read_text()
    assert "pull_request_target:" in workflow
    assert "types: [opened, synchronize, reopened, edited, labeled, unlabeled]" in workflow
    assert "ref: ${{ github.event.pull_request.base.sha }}" in workflow
    assert "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in workflow
    assert "permissions:\n  contents: read\n  pull-requests: read" in workflow
    assert "${{ github.event.pull_request.body }}" in workflow
    for line in workflow.splitlines():
        if line.lstrip().startswith("run:"):
            assert "${{" not in line
