"""Guard every workflow job that can receive deployment secrets."""

from pathlib import Path
import re
from typing import Any

import pytest
import yaml


WORKFLOWS = Path(".github/workflows")
APPROVED_CONDITIONS = {
    "github.ref == 'refs/heads/main' && github.event_name != 'repository_dispatch'",
    "github.event_name == 'repository_dispatch' && github.event.action == 'p13-private-seed-ready' && github.ref == 'refs/heads/main'",
    "github.ref == 'refs/heads/main'",
}
EXPECTED_SECRET_JOBS = [
    ".github/workflows/access-smoke.yml:smoke",
    ".github/workflows/deploy.yml:consume-private-seed",
    ".github/workflows/deploy.yml:deploy-dev",
    ".github/workflows/gauntlet-capture.yml:capture",
]

EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
SECRET_REFERENCE = re.compile(
    r"\bsecrets(?=\s*(?:\.|\[|\)|,|$))"
)
GITHUB_TOKEN_REFERENCE = re.compile(r"\bsecrets\s*\.\s*GITHUB_TOKEN\b")


def load_workflow(source: str) -> dict[str, Any]:
    parsed = yaml.load(source, Loader=yaml.BaseLoader)
    assert isinstance(parsed, dict)
    return parsed


def contains_secret_reference(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("secrets") == "inherit":
            return True
        return any(
            contains_secret_reference(key) or contains_secret_reference(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(contains_secret_reference(item) for item in value)
    if isinstance(value, str):
        for expression in EXPRESSION.finditer(value):
            body = expression.group(1)
            references = list(SECRET_REFERENCE.finditer(body))
            if not references:
                continue
            # GITHUB_TOKEN alone is the sole excluded expression reference.
            residual = GITHUB_TOKEN_REFERENCE.sub("", body)
            if SECRET_REFERENCE.search(residual):
                return True
    return False


def secret_bearing_jobs(source: str) -> list[tuple[str, dict[str, Any]]]:
    workflow = load_workflow(source)
    jobs = workflow.get("jobs", {})
    assert isinstance(jobs, dict)
    called_workflow = isinstance(workflow.get("on"), dict) and "workflow_call" in workflow["on"]
    return [
        (str(name), job)
        for name, job in jobs.items()
        if isinstance(job, dict)
        and (
            called_workflow
            or "environment" in job
            or job.get("secrets") == "inherit"
            or "uses" in job
            or contains_secret_reference(job)
        )
    ]


def assert_approved_secret_job_conditions(
    workflows: list[tuple[str, str]],
) -> list[str]:
    found: list[str] = []
    for path, source in workflows:
        for name, job in secret_bearing_jobs(source):
            found.append(f"{path}:{name}")
            condition = re.sub(r"\s+", " ", str(job.get("if", ""))).strip()
            assert condition in APPROVED_CONDITIONS, (
                f"{path}:{name} has unapproved secret-job condition: {condition!r}"
            )
    return sorted(found)


def test_every_secret_bearing_workflow_job_has_an_approved_condition() -> None:
    workflows = [
        (str(path), path.read_text(encoding="utf-8"))
        for path in sorted(WORKFLOWS.glob("*.y*ml"))
    ]
    assert assert_approved_secret_job_conditions(workflows) == EXPECTED_SECRET_JOBS


def test_quoted_job_key_and_flow_style_jobs_are_discovered() -> None:
    quoted = '''jobs:\n  "deploy-dev":\n    if: github.ref == 'refs/heads/main'\n    env:\n      CF_TOKEN: ${{ secrets.CF_TOKEN }}\n'''
    flow = '''jobs: {deploy-dev: {if: github.ref == 'refs/heads/main', env: {CF_TOKEN: "${{ secrets.CF_TOKEN }}"}}}\n'''
    for source in (quoted, flow):
        assert assert_approved_secret_job_conditions([("mutated.yml", source)]) == [
            "mutated.yml:deploy-dev"
        ]


def test_secrets_inherit_marks_a_job_secret_bearing() -> None:
    source = '''jobs:\n  reusable:\n    if: github.ref == 'refs/heads/main'\n    secrets: inherit\n    uses: org/repo/.github/workflows/reusable.yml@main\n'''
    assert assert_approved_secret_job_conditions([("mutated.yml", source)]) == [
        "mutated.yml:reusable"
    ]


def test_multiline_if_block_is_checked_as_a_whole() -> None:
    source = '''jobs:\n  deploy-dev:\n    if: >-\n      always() || github.ref == 'refs/heads/main'\n    env:\n      CF_TOKEN: ${{ secrets.CF_TOKEN }}\n'''
    with pytest.raises(AssertionError):
        assert_approved_secret_job_conditions([("mutated.yml", source)])


def test_commented_condition_does_not_approve_secret_job() -> None:
    source = '''jobs:\n  deploy-dev:\n    # if: github.ref == 'refs/heads/main'\n    env:\n      CF_TOKEN: ${{ secrets.CF_TOKEN }}\n'''
    with pytest.raises(AssertionError):
        assert_approved_secret_job_conditions([("mutated.yml", source)])


@pytest.mark.parametrize(
    "expression",
    [
        "${{ secrets['CF_TOKEN_DEV'] }}",
        "${{ toJSON(secrets) }}",
    ],
)
def test_bracket_and_object_secrets_references_are_discovered(expression: str) -> None:
    source = f'''jobs:\n  deploy-dev:\n    if: github.ref == 'refs/heads/main'\n    env:\n      VALUE: "{expression}"\n'''
    assert assert_approved_secret_job_conditions([("mutated.yml", source)]) == [
        "mutated.yml:deploy-dev"
    ]


def test_environment_without_secret_expression_is_secret_bearing() -> None:
    source = """jobs:\n  deploy-dev:\n    if: github.ref == 'refs/heads/main'\n    environment: dev\n"""
    assert assert_approved_secret_job_conditions([("mutated.yml", source)]) == [
        "mutated.yml:deploy-dev"
    ]


def test_workflow_call_marks_every_job_secret_bearing() -> None:
    source = """on:\n  workflow_call:\njobs:\n  unguarded:\n    runs-on: ubuntu-latest\n"""
    with pytest.raises(AssertionError, match="mutated.yml:unguarded"):
        assert_approved_secret_job_conditions([("mutated.yml", source)])


def test_github_token_only_is_not_secret_bearing() -> None:
    source = """jobs:\n  token-only:\n    runs-on: ubuntu-latest\n    env:\n      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n"""
    assert secret_bearing_jobs(source) == []


def test_secrets_word_in_run_script_outside_expression_is_not_secret_bearing() -> None:
    source = '''jobs:\n  rights:\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - run: echo "Secrets belong in Secrets Store / Environment secrets."\n'''
    assert secret_bearing_jobs(source) == []
