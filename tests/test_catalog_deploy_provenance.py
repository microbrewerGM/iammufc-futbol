from pathlib import Path
from typing import Any

import yaml

DEPLOY = Path(".github/workflows/deploy.yml")


def workflow(source: str) -> dict[str, Any]:
    return yaml.load(source, Loader=yaml.BaseLoader)


def is_worker_deploy(step: dict[str, Any]) -> bool:
    command = step.get("with", {}).get("command", "")
    return "deploy" in command.split() or "wrangler deploy" in step.get("run", "")


def assert_worker_deploys_have_prior_catalog_verification(source: str) -> None:
    jobs = workflow(source)["jobs"]
    for job_name, job in jobs.items():
        steps = job.get("steps", [])
        deploys = [index for index, step in enumerate(steps) if is_worker_deploy(step)]
        for deploy_index in deploys:
            assert any(
                step.get("uses") == "./.github/actions/verify-public-catalog-producer"
                for step in steps[:deploy_index]
            ), f"{job_name} deploy lacks prior catalog artifact verification"


def test_every_worker_deploy_has_prior_catalog_artifact_verification() -> None:
    assert_worker_deploys_have_prior_catalog_verification(DEPLOY.read_text(encoding="utf-8"))


def test_shape_guard_rejects_deploy_without_catalog_artifact_verification() -> None:
    unsafe = """jobs:\n  unsafe:\n    steps:\n      - uses: cloudflare/wrangler-action@pinned\n        with:\n          command: deploy --env dev\n"""
    try:
        assert_worker_deploys_have_prior_catalog_verification(unsafe)
    except AssertionError as error:
        assert "unsafe deploy lacks" in str(error)
    else:
        raise AssertionError("shape guard accepted a deploy without catalog verification")
