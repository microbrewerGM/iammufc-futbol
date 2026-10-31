from __future__ import annotations

import importlib.util
import subprocess as stdlib_subprocess
import re
import shlex
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
    paths = ["worker/src/views/app.ts"]
    ancestry: dict[tuple[str, str], int] = {}
    diffs: dict[tuple[str, str], str] = {}
    fail_diff = False
    modes = {}
    statuses = {}
    calls: list[tuple[str, ...]] = []

    @classmethod
    def run(cls, argv, **kwargs):
        args = argv[1:]
        cls.calls.append(tuple(args))
        if args[0] == "diff" and "--raw" in args:
            if cls.fail_diff:
                return subprocess.CompletedProcess(argv, 2, "", "stubbed diff failure")
            records = []
            for path in cls.paths:
                old_mode, new_mode = cls.modes.get(path, ("100644", "100644"))
                status = cls.statuses.get(path, "M")
                records.append(f":{old_mode} {new_mode} {'a'*40} {'b'*40} {status}\0{path}\0")
            return subprocess.CompletedProcess(argv, 0, "".join(records), "")
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
    GitStub.ancestry = {(JUDGED, HEAD): 0}
    GitStub.diffs = {(MERGE, JUDGED): "same", (BASE, HEAD): "same"}
    GitStub.fail_diff = False
    GitStub.calls = []
    GitStub.modes = {}
    GitStub.statuses = {}
    GitStub.paths = ["tests/a.test.ts"]
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
        ("missing marker", ["docs/app.md"], f"Validator: PASS {HEAD}", False),
        ("stale SHA", ["docs/app.md"], body("e" * 40), False),
        ("lowercase hex", ["docs/app.md"], body(HEAD), True),
        ("uppercase hex", ["docs/app.md"], body().replace(HEAD, HEAD.upper()), False),
        ("valid", ["docs/app.md"], body(), True),
        ("protected without red-team", ["infra/config.toml"], body(), False),
        ("injection-shaped body text", ["docs/app.md"], f"$(injected shell text)\n{body()}", False),
        (
            "obsolete CI validator",
            ["docs/app.md"],
            f"Reviewer: APPROVE {HEAD}\nValidator: CI 123 on {HEAD}",
            False,
        ),
        ("negative verdict", ["docs/app.md"], body() + f"\nValidator: FAIL {HEAD}", False),
        ("conflicting role verdicts", ["docs/app.md"], body() + f"\nReviewer: BLOCK {HEAD}", False),
        ("fork PR", ["docs/app.md"], body(), False),
        (
            "comment rejected",
            ["docs/app.md"],
            f"<!--\n{body()}",
            False,
        ),
        (
            "byte check targets another head",
            ["docs/app.md"],
            f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {'e' * 40}",
            False,
        ),
        (
            "protected byte check missing judged red-team",
            ["infra/config.toml"],
            f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}",
            False,
        ),
        ("marker mid-line", ["docs/app.md"], f"prefix Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("marker trailing text", ["docs/app.md"], body() + " trailing", False),
        ("decorated role", ["docs/app.md"], f"- **Reviewer:** APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("indented role", ["docs/app.md"], f" Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("four space role", ["docs/app.md"], f"    Reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("lowercase role", ["docs/app.md"], f"reviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}", False),
        ("failed token", ["docs/app.md"], body() + f"\nValidator: FAILED {HEAD}", False),
        ("reject token", ["docs/app.md"], body() + f"\nReviewer: REJECT {HEAD}", False),
        ("lgtm token", ["docs/app.md"], body() + f"\nReviewer: LGTM {HEAD}", False),
        ("fence opener", ["docs/app.md"], f"```\n{body()}", False),
        ("unterminated fence", ["docs/app.md"], f"~~~\n{body()}", False),
        ("raw html", ["docs/app.md"], f"{body()}\n<div>text</div>", False),
        ("link reference", ["docs/app.md"], f"{body()}\n[ref]: https://example.com", False),
        ("vertical tab", ["docs/app.md"], f"{body()}\v", False),
        ("form feed", ["docs/app.md"], f"{body()}\f", False),
        ("next line", ["docs/app.md"], f"{body()}\x85", False),
        ("unicode line separator", ["docs/app.md"], f"{body()}\u2028", False),
        ("unicode paragraph separator", ["docs/app.md"], f"{body()}\u2029", False),
        ("tab rejected", ["docs/app.md"], f"\t{body()}", False),
        (
            "wrong role validator approve",
            ["docs/app.md"],
            f"Reviewer: APPROVE {HEAD}\nValidator: APPROVE {HEAD}",
            False,
        ),
        (
            "wrong role reviewer pass",
            ["docs/app.md"],
            f"Reviewer: PASS {HEAD}\nValidator: PASS {HEAD}",
            False,
        ),
    ],
)
def test_verdict_cases(description, paths, text, expected):
    GitStub.paths = paths
    repo = "fork/iammufc-futbol" if description == "fork PR" else REPO
    if description == "uppercase hex":
        result = review_markers._allowed_body(text)
    else:
        result = check(text, head_repo=repo)[0]
    assert result is expected, description


@pytest.mark.parametrize("mode", ["120000", "160000"])
def test_symlink_and_gitlink_modes_require_red_team(mode):
    GitStub.paths = ["worker/src/views/link.ts"]
    GitStub.modes[GitStub.paths[0]] = (mode, mode)
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


@pytest.mark.parametrize(
    ("old_mode", "new_mode", "status"),
    [
        pytest.param("120000", "100644", "M", id="old-symlink"),
        pytest.param("100644", "120000", "M", id="new-symlink"),
        pytest.param("160000", "100644", "T", id="old-gitlink-type-change"),
        pytest.param("160000", "000000", "D", id="old-gitlink-deletion"),
        pytest.param("000000", "160000", "A", id="new-gitlink-addition"),
    ],
)
def test_mode_changes_on_either_side_need_red_team(old_mode, new_mode, status):
    GitStub.paths = ["docs/mode.md"]
    GitStub.modes = {}
    GitStub.statuses = {}
    GitStub.modes[GitStub.paths[0]] = (old_mode, new_mode)
    GitStub.statuses[GitStub.paths[0]] = status
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


def test_deleted_protected_path_needs_red_team():
    path = "docs/deleted.md"
    GitStub.paths = [path]
    GitStub.modes = {}
    GitStub.statuses[path] = "D"
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


def test_rename_from_protected_path_needs_red_team():
    old_path, new_path = "docs/old.md", "docs/new.md"
    GitStub.paths = [old_path, new_path]
    GitStub.modes = {}
    GitStub.statuses[old_path] = "D"
    GitStub.statuses[new_path] = "A"
    assert not check(body())[0]
    assert check(body(red_team=True))[0]


@pytest.mark.parametrize(
    "path",
    [
        "docs/Foo.md",
        "docs/café.md",
        "docs/é.md",
        "docs/cafe\u0301.md",
        "docs/a\u0344.md",
        "docs/x.txt",
        "docs/.gitkeep",
        "worker/src/views/x.js",
    ],
)
def test_normalization_and_extension_paths_need_red_team(path):
    GitStub.paths = [path]
    assert not check(body())[0]
    assert check(body(red_team=True))[0]

def test_nfc_normalization_guard_is_explicit():
    class AsciiPath(str):
        def isascii(self):
            return True

    path = AsciiPath("docs/cafe\u0301.md")
    assert review_markers.needs_red_team(path)


def test_protected_paths_pass_with_red_team():
    GitStub.paths = ["infra/config.toml"]
    assert check(body(red_team=True))[0]


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


@pytest.mark.parametrize(
    ("path", "protected"),
    [
        ("tests/__init__.py", True),
        ("pydantic/__init__.py", True),
        ("tests/pyproject.toml", True),
        ("nested/ruff.toml", True),
        ("new-top-level/file.ts", True),
        ("worker/src/security/x.ts", True),
        ("worker/src/budget/x.ts", True),
        ("worker/src/generated/catalog.json", True),
        ("worker/src/generated/catalog-release.json", True),
        ("worker/src/index.ts", True),
        ("worker/src/other/x.ts", True),
        ("worker/src/core/parser.ts", True),
        ("worker/src/core/question-triage-bridge.ts", True),
        ("worker/src/core/db.ts", True),
        ("worker/src/core/discovery-arrivals.ts", True),
        ("worker/src/core/x.ts", True),
        ("worker/src/views/x.ts", True),
        ("worker/src/core/question-requests.ts", True),
        ("worker/src/core/validate-intent.ts", True),
        ("worker/src/core/feasibility.ts", True),
        ("worker/src/views/layout.ts", True),
        ("worker/src/VIEWS/x.ts", True),
        ("worker/src/viewſ/x.ts", True),
        ("tests/a/b.test.ts", False),
        ("tests/x.test.ts", False),
        ("docs/x.md", False),
        ("worker/x.md", True),
        ("x/README.md", True),
        ("README.md", False),
        ("README.MD", True),
        ("Docs/x", True),
        ("WORKER/SRC/x.ts", True),
    ],
)
def test_rework_8_path_allow_list(path, protected):
    GitStub.paths = [path]
    assert check(body(red_team=protected))[0] is True
    assert check(body())[0] is (not protected)


def test_legitimate_integrator_body_passes():
    text = (
        "Review for REVIEW-MARKER-CHECK-WEB https://example.com/card.\n\n"
        f"{body(red_team=True)}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"
        "https://claude.ai/code/session_abC-123"
    )
    GitStub.paths = ["pipeline/__init__.py"]
    assert check(text)[0]


def test_quoted_phrase_passes():
    assert check(f'A quoted phrase "looks fine" here.\n\n{body()}')[0]


@pytest.mark.parametrize("character", [
    "*", "_", "\\", "]", "&", "|", "!", "{", "}", "`", "~", "<", ">", "[",
    "\u00a0", "\u200b", "\u2011", "：", "é",
])
def test_forbidden_prose_character_is_rejected_alone(character):
    assert not check(f"ordinary{character}prose\n\n{body()}")[0], repr(character)
    assert check(f"ordinaryprose\n\n{body()}")[0], repr(character)


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


def test_stale_canonical_line_next_to_current_line_fails():
    assert not check(body() + f"\nReviewer: APPROVE {'e' * 40}")[0]


def test_verdict_block_must_be_contiguous_and_separated():
    assert not check(f"Reviewer: APPROVE {HEAD}\nordinary prose\nValidator: PASS {HEAD}")[0]
    assert not check(f"ordinary prose\nReviewer: APPROVE {HEAD}\nValidator: PASS {HEAD}")[0]


def test_byte_check_git_argv_is_pinned():
    text = f"{body(JUDGED)}\nLead: BYTE-CHECK {JUDGED} {HEAD}"
    assert check(text)[0]
    assert GitStub.calls == [
        ("diff", "--raw", "-z", "--no-renames", f"{BASE}...{HEAD}"),
        ("merge-base", "--is-ancestor", JUDGED, BASE),
        ("merge-base", "--is-ancestor", JUDGED, HEAD),
        ("merge-base", BASE, JUDGED),
        ("diff", "--no-renames", "--full-index", MERGE, JUDGED),
        ("diff", "--no-renames", "--full-index", BASE, HEAD),
    ]


def test_raw_z_parser_preserves_quoted_tab_and_newline_path(monkeypatch):
    path = 'docs/"quoted"\ttab\nline.md'

    def git(*args):
        if args[:3] == ("diff", "--raw", "-z"):
            record = f":100644 100644 {'a'*40} {'b'*40} M\0{path}\0"
            return record
        raise AssertionError(args)

    monkeypatch.setattr(review_markers, "_git_ok", git)
    assert review_markers.changed_paths(BASE, HEAD) == [path]


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
    assert parsed_ref(workflow) == "main"
    assert "persist-credentials: false" in workflow
    assert "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in workflow
    assert "permissions:" in workflow
    assert (
        "concurrency:" in workflow
        and "review-markers-${{ github.event.pull_request.number }}" in workflow
    )
    assert "HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}" in workflow
    assert "GITHUB_REPOSITORY: ${{ github.repository }}" in workflow
    assert "PR_NUMBER: ${{ github.event.pull_request.number }}" in workflow
    assert "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}" in workflow
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


def parsed_ref(workflow):
    parsed = __import__("yaml").safe_load(workflow)
    return parsed["jobs"]["review-markers"]["steps"][0]["with"]["ref"]


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
    handlers = []

    class Opener:
        def open(self, req, timeout):
            requests.append(req)
            raise review_markers.urllib.error.HTTPError(
                req.full_url, 302, "redirect", {"Location": "https://attacker.invalid/"}, None
            )

    def build_opener(handler):
        handlers.append(handler)
        return Opener()

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", build_opener)
    with pytest.raises(review_markers.urllib.error.HTTPError):
        review_markers._live_pull_request(REPO, "42", "secret-token")
    assert len(requests) == 1
    assert requests[0].get_header("Authorization") == "Bearer secret-token"
    assert "attacker.invalid" not in repr(requests)
    assert len(handlers) == 1
    with pytest.raises(review_markers.urllib.error.HTTPError):
        handlers[0]().redirect_request(
            requests[0], None, 302, "Found", {}, "https://attacker.invalid/"
        )


def test_live_api_rejects_unexpected_response_url(monkeypatch):
    import json

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def geturl(self):
            return "https://attacker.invalid/"

        def read(self):
            return json.dumps({"body": body(), "head": {"sha": HEAD}}).encode()

    class Opener:
        def open(self, req, timeout):
            return Response()

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(RuntimeError, match="redirected"):
        review_markers._live_pull_request(REPO, "42", "token")


def test_main_live_head_mismatch_and_network_error_fail_closed(monkeypatch, capsys):
    import json

    environ = {
        "GITHUB_REPOSITORY": REPO,
        "PR_NUMBER": "42",
        "GITHUB_TOKEN": "never-print-this-token",
        "HEAD_SHA": HEAD,
        "BASE_SHA": BASE,
        "HEAD_REPO": REPO,
    }
    monkeypatch.setattr(review_markers.os, "environ", environ)
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def geturl(self):
            return f"https://api.github.com/repos/{REPO}/pulls/42"

        def read(self):
            return json.dumps({"body": body(), "head": {"sha": "e" * 40}}).encode()

    class Opener:
        def open(self, req, timeout):
            return Response()

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", lambda handler: Opener())
    assert review_markers.main() == 1
    captured = capsys.readouterr()
    assert "live head differs" in captured.out

    class FailingOpener:
        def open(self, req, timeout):
            raise OSError("network unavailable")

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", lambda handler: FailingOpener())
    assert review_markers.main() == 1
    captured = capsys.readouterr()
    assert "network unavailable" in captured.out
    assert "never-print-this-token" not in captured.out + captured.err


def test_main_request_authorization_and_token_not_logged(monkeypatch, capsys):
    import json

    token = "main-test-secret-token"
    monkeypatch.setattr(
        review_markers.os,
        "environ",
        {
            "GITHUB_REPOSITORY": REPO,
            "PR_NUMBER": "42",
            "GITHUB_TOKEN": token,
            "HEAD_SHA": HEAD,
            "BASE_SHA": BASE,
            "HEAD_REPO": REPO,
        },
    )
    requests = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def geturl(self):
            return f"https://api.github.com/repos/{REPO}/pulls/42"

        def read(self):
            return json.dumps({"body": body(), "head": {"sha": HEAD}}).encode()

    class Opener:
        def open(self, req, timeout):
            requests.append(req)
            return Response()

    monkeypatch.setattr(review_markers.urllib.request, "build_opener", lambda handler: Opener())
    assert review_markers.main() == 0
    captured = capsys.readouterr()
    assert requests[0].get_header("Authorization") == f"Bearer {token}"
    assert token not in captured.out + captured.err


def test_workflow_run_inputs_require_red_team_except_secret_free_vitest_tests():
    listing = stdlib_subprocess.Popen(
        ["git", "ls-files", "-z"], cwd=ROOT, stdout=stdlib_subprocess.PIPE, text=True
    )
    stdout, _ = listing.communicate()
    assert listing.returncode == 0
    tracked = stdout.split("\0")
    tracked = {path for path in tracked if path}
    collected = set()
    module_pattern = re.compile(r"^(?:python|python3)\s+-m\s+([A-Za-z_][\w.]*)$")
    for workflow_path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        workflow = __import__("yaml").safe_load(workflow_path.read_text())
        for job in workflow.get("jobs", {}).values():
            secret_free_test_job = job.get("name") == "test"
            for step in job.get("steps", []):
                command_text = step.get("run", "")
                command_text = re.sub(r"\\\n\s*", " ", command_text)
                command_text = "\n".join(
                    line.split("#", 1)[0] for line in command_text.splitlines()
                )
                try:
                    tokens = shlex.split(command_text)
                except ValueError as exc:
                    pytest.fail(f"cannot tokenize {workflow_path}: {command_text!r}: {exc}")
                for index in range(len(tokens)):
                    command = " ".join(tokens[index:index + 3])
                    match = module_pattern.match(command)
                    if match:
                        collected.add(match.group(1).replace(".", "/") + ".py")
                    candidate = tokens[index].strip("\"'(){}[],:;")
                    if candidate in tracked:
                        if candidate.startswith("tests/") and candidate.endswith(".test.ts") and secret_free_test_job:
                            continue
                        collected.add(candidate)
    assert collected
    assert "tools/ci/review_markers.py" in collected
    assert "pipeline/contracts/validate_public_catalog.py" in collected
    for path in collected:
        assert review_markers.needs_red_team(path), path
