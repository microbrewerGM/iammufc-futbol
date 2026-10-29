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
    return isinstance(value, str) and bool(
        re.search(r"secrets\.(?:CF_|CLOUDFLARE)", value, re.IGNORECASE)
    )


def secret_bearing_jobs(source: str) -> list[tuple[str, dict[str, Any]]]:
    jobs = load_workflow(source).get("jobs", {})
    assert isinstance(jobs, dict)
    return [
        (str(name), job)
        for name, job in jobs.items()
        if isinstance(job, dict)
        and (contains_secret_reference(job) or "uses" in job)
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
