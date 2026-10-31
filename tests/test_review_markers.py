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

HEAD, BASE, JUDGED, MERGE = (letter * 40 for letter in "abcd")
REPO = "microbrewerGM/iammufc-futbol"


class GitStub:
    paths = ["src/app.ts"]
    ancestry: dict[tuple[str, str], int] = {}
    diffs: dict[tuple[str, str], str] = {}
    fail_diff = False
    calls: list[tuple[str, ...]] = []

    @classmethod
    def run(cls, argv, **kwargs):
        args = argv[1:]
        cls.calls.append(tuple(args))
        if args[0] == "diff" and "--name-only" in args:
            if cls.fail_diff:
                return subprocess.CompletedProcess(argv, 2, "", "stubbed diff failure")
            return subprocess.CompletedProcess(
                argv, 0, "\0".join(cls.paths) + ("\0" if cls.paths else ""), ""
            )
        if args[0] == "diff":
            left, right = args[-2:]
            return subprocess.CompletedProcess(argv, 0, cls.diffs.get((left, right), "patch"), "")
        if args[:2] == ["merge-base", "--is-ancestor"]:
            code = cls.ancestry.get((args[2], args[3]), 1)
            return subprocess.CompletedProcess(argv, code, "", "")
        if args[0] == "merge-base":
            return subprocess.CompletedProcess(argv, 0, MERGE + "\n", "")
        raise AssertionError(argv)


@pytest.fixture(autouse=True)
def stub_git(monkeypatch):
    GitStub.paths = ["src/app.ts"]
    GitStub.ancestry = {(JUDGED, HEAD): 0}
    GitStub.diffs = {(MERGE, JUDGED): "same", (BASE, HEAD): "same"}
    GitStub.fail_diff = False
    GitStub.calls = []
    monkeypatch.setattr(review_markers.subprocess, "run", GitStub.run)


def body(sha=HEAD, *, red_team=False):
    lines = [f"Reviewer: APPROVE {sha}", f"Validator: PASS {sha}"]
    if red_team:
        lines.append(f"Red-team: PASS {sha}")
    return "\n".join(lines)


def check(text, *, head=HEAD, base=BASE, head_repo=REPO, repository=REPO):
    return review_markers.check(base, head, text, head_repo, repository)


@pytest.mark.parametrize(
    ("description", "paths", "text", "expected"),
    [
        ("missing marker", ["src/app.ts"], f"Validator: PASS {HEAD}", False),
        ("stale SHA", ["src/app.ts"], body("e" * 40), False),
        ("lowercase hex", ["src/app.ts"], body(HEAD), True),
        ("uppercase hex", ["src/app.ts"], body(HEAD.upper()), False),
        ("valid", ["src/app.ts"], body(), True),
        ("protected without red-team", ["infra/config.toml"], body(), False),
        ("injection-shaped body text", ["src/app.ts"], f"$(injected shell text)\n{body()}", False),
        (
            "obsolete CI validator",
            ["src/app.ts"],
            f"Reviewer: APPROVE {HEAD}\nValidator: CI 123 on {HEAD}",
            False,
        ),
        ("negative verdict", ["src/app.ts"], body() + f"\nValidator: FAIL {HEAD}", False),
        ("conflicting role verdicts", ["src/app.ts"], body() + f"\nReviewer: BLOCK {HEAD}", False),
        ("fork PR", ["src/app.ts"], body(), False),
        (
            "comment rejected",
            ["src/app.ts"],
            f"<!--\n{body()}",
            False,
        ),
        (
            "byte check targets another head",
            ["src/app.ts"],
            f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {'e' * 40}",
            False,
        ),
        (
            "protected byte check missing judged red-team",
            ["infra/config.toml"],
            f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}",
            False,
        ),
        ("marker mid-line", ["src/app.ts"], f"prefix Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("marker trailing text", ["src/app.ts"], body() + " trailing", False),
        ("decorated role", ["src/app.ts"], f"- **Reviewer:** APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("indented role", ["src/app.ts"], f" Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("four space role", ["src/app.ts"], f"    Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("lowercase role", ["src/app.ts"], f"reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("failed token", ["src/app.ts"], body() + f"\nValidator: FAILED {HEAD}", False),
        ("reject token", ["src/app.ts"], body() + f"\nReviewer: REJECT {HEAD}", False),
        ("lgtm token", ["src/app.ts"], body() + f"\nReviewer: LGTM {HEAD}", False),
        ("fence opener", ["src/app.ts"], f"```\n{body()}", False),
        ("unterminated fence", ["src/app.ts"], f"~~~\n{body()}", False),
        ("raw html", ["src/app.ts"], f"{body()}\n<div>text</div>", False),
        ("link reference", ["src/app.ts"], f"{body()}\n[ref]: https://example.com", False),
        ("vertical tab", ["src/app.ts"], f"{body()}\v", False),
        ("form feed", ["src/app.ts"], f"{body()}\f", False),
        ("next line", ["src/app.ts"], f"{body()}\x85", False),
        ("unicode line separator", ["src/app.ts"], f"{body()}\u2028", False),
        ("unicode paragraph separator", ["src/app.ts"], f"{body()}\u2029", False),
        ("tab rejected", ["src/app.ts"], f"\t{body()}", False),
        (
            "wrong role validator approve",
            ["src/app.ts"],
            f"Reviewer: APPROVE {HEAD}\nValidator: APPROVE {HEAD}",
            False,
        ),
        (
            "wrong role reviewer pass",
            ["src/app.ts"],
            f"Reviewer: PASS {HEAD}\nValidator: PASS {HEAD}",
            False,
        ),
    ],
)
def test_verdict_cases(description, paths, text, expected):
    GitStub.paths = paths
    repo = "fork/iammufc-futbol" if description == "fork PR" else REPO
    assert check(text, head_repo=repo)[0] is expected, description


def test_protected_paths_pass_with_red_team():
    GitStub.paths = ["infra/config.toml"]
    assert check(body(red_team=True))[0]


@pytest.mark.parametrize(
    "path",
    [
        "package.json",
        "package-lock.json",
        "pyproject.toml",
        "uv.lock",
        ".gitleaks.toml",
        ".gitignore",
        "catalog/rights/index.json",
        "worker/src/budget/limits.ts",
        "scripts/a.mjs",
        "pipeline/__init__.py",
        "catalog/schemas/model.json",
        ".gitleaksignore",
        "ruff.toml",
        ".ruff.toml",
        "uv.toml",
        ".python-version",
        "pydantic.py",
    ],
)
def test_rework_paths_are_protected(path):
    assert review_markers.is_protected(path)


@pytest.mark.parametrize(
    "judged_kind,identical,expected",
    [
        ("equal_base", True, False),
        ("old_main", True, False),
        ("internal_same", True, True),
        ("internal_different", False, False),
    ],
)
def test_byte_check_only_accepts_identical_pr_internal_patch(judged_kind, identical, expected):
    judged = BASE if judged_kind == "equal_base" else JUDGED
    if judged_kind == "old_main":
        GitStub.ancestry[(judged, BASE)] = 0
    GitStub.ancestry[(judged, HEAD)] = 0
    GitStub.diffs[(MERGE, judged)] = "same" if identical else "different"
    GitStub.diffs[(BASE, HEAD)] = "same"
    text = f"{body(judged)}\nLead: BYTE-CHECK {judged} {HEAD}"
    assert check(text)[0] is expected


def test_crlf_byte_check_passes():
    text = f"{body(JUDGED)}\r\nLead: BYTE-CHECK {JUDGED} {HEAD}"
    assert check(text)[0]


@pytest.mark.parametrize("path", ["pipeline/__init__.py", "pydantic.py"])
def test_rework_6_paths_require_red_team(path):
    GitStub.paths = [path]
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


def test_legitimate_integrator_body_passes():
    text = (
        "Review for REVIEW-MARKER-CHECK-WEB https://example.com/card.\n\n"
        f"{body(red_team=True)}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"
        "https://claude.ai/code/session_abC-123"
    )
    GitStub.paths = ["pipeline/__init__.py"]
    assert check(text)[0]


@pytest.mark.parametrize(
    "hostile",
    [
        f"Red-team: FAIL {HEAD} token reaches argv", f"Red-team: FAIL on {HEAD}",
        f"> Red-team: FAIL {HEAD}", f"1. Red-team: FAIL {HEAD}", f"## Red-team: FAIL {HEAD}",
        f"Red-team:\u00a0FAIL {HEAD}", "<!-->", '<div title="...markers...">',
        "[reference]: https://example.com\n  \"multi-line title\"", f"prefix\u2028Red-team: FAIL {HEAD}",
        "`Reviewer`: APPROVE " + HEAD, "_Reviewer_: APPROVE " + HEAD,
        "\\Reviewer: APPROVE " + HEAD, "Reviewer&#58; APPROVE " + HEAD,
        "verdict: Reviewer APPROVE " + HEAD, "Reviewer:\u200b APPROVE " + HEAD,
        "Reviewer\u2011: APPROVE " + HEAD, "Reviewer： APPROVE " + HEAD,
        "~~Reviewer: APPROVE\nValidator: PASS~~", "[review\nreference]: https://example.com",
        "- [x]: https://example.com", "<?xml version='1.0'?>",
    ],
)
def test_allow_list_rejects_all_recorded_red_team_inputs(hostile):
    assert not check(body() + "\n\n" + hostile)[0]


def test_verdict_trailing_space_fails():
    assert not check(f"Reviewer: APPROVE {HEAD} \nValidator: PASS {HEAD}")[0]


def test_verdict_block_must_be_contiguous_and_separated():
    assert not check(f"Reviewer: APPROVE {HEAD}\nordinary prose\nValidator: PASS {HEAD}")[0]
    assert not check(f"ordinary prose\nReviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}")[0]


def test_byte_check_git_argv_is_pinned():
    text = f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}"
    assert check(text)[0]
    assert GitStub.calls == [
        ("diff", "--name-only", "-z", "--no-renames", f"{BASE}...{HEAD}"),
        ("merge-base", "--is-ancestor", JUDGED, BASE),
        ("merge-base", "--is-ancestor", JUDGED, HEAD),
        ("merge-base", BASE, JUDGED),
        ("diff", "--no-renames", "--full-index", MERGE, JUDGED),
        ("diff", "--no-renames", "--full-index", BASE, HEAD),
    ]


def test_merge_base_error_fails_closed():
    GitStub.ancestry[(JUDGED, HEAD)] = 1
    GitStub.ancestry[(JUDGED, BASE)] = 128
    assert not check(f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}")[0]


def test_uppercase_head_from_environment_is_rejected():
    assert not check(body(HEAD), head=HEAD.upper())[0]


def test_head_negative_verdict_fails_even_when_judged_markers_pass():
    text = f"{body(JUDGED)}\nValidator: CHANGES {HEAD}\nLead: BYTE-CHECK {JUDGED} {HEAD}"
    assert not check(text)[0]


def test_empty_diff_and_git_error_fail_closed():
    GitStub.paths = []
    assert not check(body())[0]
    GitStub.fail_diff = True
    assert not check(body())[0]


def test_invalid_sha_fails_closed():
    assert not check(body(), base="missing")[0]


def test_workflow_shape():
    workflow = (ROOT / ".github/workflows/review-markers.yml").read_text()
    assert "pull_request_target:" in workflow
    assert "types: [opened, synchronize, reopened, edited]" in workflow
    assert "ref: ${{ github.event.pull_request.base.sha }}" in workflow
    assert "persist-credentials: false" in workflow
    assert "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in workflow
    assert "permissions:" in workflow
    assert (
        "concurrency:" in workflow
        and "review-markers-${{ github.event.pull_request.number }}" in workflow
    )
    assert "HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}" in workflow
    assert "GITHUB_REPOSITORY: ${{ github.repository }}" in workflow
    assert "${{ github.event.pull_request.body }}" not in workflow
    parsed = __import__("yaml").safe_load(workflow)
    assert parsed["permissions"] == {"contents": "read", "pull-requests": "read"}
    assert "write" not in workflow and "write-all" not in workflow
    for job in parsed["jobs"].values():
        assert "permissions" not in job
        for step in job.get("steps", []):
            run = step.get("run", "")
            assert "${{" not in run
            for value in step.get("env", {}).values():
                assert "${{ github.event.pull_request.body }}" not in value


def test_all_workflow_executed_scripts_and_install_manifests_are_protected():
    workflows = list((ROOT / ".github/workflows").glob("*.yml"))
    invoked_scripts = {
        "package.json", "package-lock.json", "pyproject.toml", "uv.lock",
        ".gitleaksignore", "ruff.toml", ".ruff.toml", "uv.toml",
        "pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg",
    }
    for workflow in workflows:
        text = workflow.read_text()
        for match in __import__("re").finditer(
            r"\b(?:node|python3?|uv run python)\s+([\w./-]+\.(?:py|mjs|js|cjs))", text
        ):
            invoked_scripts.add(match.group(1))
        if "npm ci" in text or "npm install" in text:
            invoked_scripts.update(("package.json", "package-lock.json"))
        if "uv sync" in text:
            invoked_scripts.update(("pyproject.toml", "uv.lock"))
    repo_files = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file()}
    missing = sorted(
        path
        for path in invoked_scripts
        if path in repo_files and not review_markers.is_protected(path)
    )
    assert not missing, f"workflow inputs must be protected: {missing}"


@pytest.mark.parametrize(
    "path",
    [
        "pipeline/contracts/a.py",
        "tests/test_feasibility.py",
        "x/.npmrc",
        ".yarnrc.yml",
        ".nvmrc",
        ".node-version",
        "vitest.config.ts",
        "tsconfig.json",
        ".gitattributes",
        "GEMINI.md",
        "copilot_instructions.md",
    ],
)
def test_rework_3_protected(path):
    assert review_markers.is_protected(path)


@pytest.mark.parametrize(
    "path",
    [
        "pytest.ini",
        "tests/conftest.py",
        "nested/.pytest.ini",
        "config/tox.ini",
        "nested/setup.cfg",
        "vitest.config.mts",
        "vitest.workspace.js",
        "vite.config.ts",
        "nested/vite.config.mjs",
    ],
)
def test_rework_5_paths_are_protected(path):
    assert review_markers.is_protected(path)


@pytest.mark.parametrize("path", ["pytest.ini", "tests/conftest.py"])
def test_rework_5_protected_paths_require_red_team(path):
    GitStub.paths = [path]
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


@pytest.mark.parametrize(
    "hostile",
    [
        f"Red-team: FAIL {HEAD} token reaches argv",
        f"Red-team: FAIL on {HEAD}",
        f"> Red-team: FAIL {HEAD}",
        f"1. Red-team: FAIL {HEAD}",
        f"## Red-team: FAIL {HEAD}",
        f"Red-team:\u00a0FAIL {HEAD}",
        "<!-->",
        '<div title="...markers...">',
        f"[reference]: https://example.com\n  \"multi-line title\"\n{body()}",
        f"prefix\u2028Red-team: FAIL {HEAD}",
    ],
)
def test_red_team_hostile_inputs_fail(hostile):
    assert not check(body() + "\n" + hostile)[0]


def test_reject_and_lgtm_conflict_and_case_markup():
    assert not check(body() + f"\nReviewer: REJECT {HEAD}")[0]
    assert not check(body() + f"\nReviewer: LGTM {HEAD}")[0]
    assert not check(f"- **Reviewer:** APPROVE {HEAD}\n* **Validator:** PASS {HEAD}")[0]


def test_prefix_negatives_and_stale_negative():
    for token in ("REJECTED", "FAILURE", "BLOCKED", "CHANGES_NEEDED", "REQUESTED"):
        assert not check(body() + f"\nReviewer: {token} {HEAD}")[0]
    assert not check(body() + f"\nReviewer: FAIL {'e' * 40}")[0]


def test_ancestor_errors_raise_for_both_calls():
    GitStub.ancestry[(JUDGED, BASE)] = 128
    assert not check(f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}")[0]
    GitStub.ancestry[(JUDGED, BASE)] = 1
    GitStub.ancestry[(JUDGED, HEAD)] = 128
    assert not check(f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}")[0]


def test_commonmark_unterminated_fence_and_comment():
    assert not check(f"   ```\n{body()}\n```")[0]
    assert not check(f"~~~\n{body()}")[0]
    assert not check(f"<!-- hidden\n{body()}")[0]
    assert not check(f"````\n{body()}\n```\n{body()}\n````")[0]


def test_live_api_url_and_refresh(monkeypatch):
    import json

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return json.dumps({"body": body(), "head": {"sha": HEAD}}).encode()

        def geturl(self):
            return f"https://api.github.com/repos/{REPO}/pulls/42"

    calls = []

    class Opener:
        def open(self, req, timeout):
            calls.append(req.full_url)
            return Response()

    def build_opener(handler):
        assert issubclass(handler, review_markers.urllib.request.HTTPRedirectHandler)
        return Opener()

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", build_opener)
    assert review_markers._live_pull_request(REPO, "42", "token")[1] == HEAD
    assert calls == [f"https://api.github.com/repos/{REPO}/pulls/42"]


def test_live_api_redirect_fails_without_forwarding_token(monkeypatch):
    requests = []

    class Opener:
        def open(self, req, timeout):
            requests.append(req)
            raise review_markers.urllib.error.HTTPError(
                req.full_url, 302, "redirect", {"Location": "https://attacker.invalid/"}, None
            )

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(review_markers.urllib.error.HTTPError):
        review_markers._live_pull_request(REPO, "42", "secret-token")
    assert len(requests) == 1
    assert requests[0].get_header("Authorization") == "Bearer secret-token"
    assert "attacker.invalid" not in repr(requests)


def test_workflow_body_expression_once():
    text = (ROOT / ".github/workflows/review-markers.yml").read_text()
    assert text.count("${{ github.event.pull_request.body }}") == 0
    assert "PR_NUMBER:" in text and "GITHUB_TOKEN:" in text


def test_rights_gate_module_and_pytest_are_protected():
    assert review_markers.is_protected("pipeline/contracts/validate_public_catalog.py")
    assert review_markers.is_protected("tests/test_feasibility.py")
    assert review_markers.is_protected("nested/.npmrc")
    assert review_markers.is_protected("catalog/schemas/manifest.json")
    assert review_markers.is_protected("tests/conftest.py")
    assert review_markers.is_protected("tests/nested/conftest.py")
