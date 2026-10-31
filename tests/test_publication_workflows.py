"""The website consumes private data and deploys code without rebuilding data."""

from pathlib import Path
import re

import yaml


def load(name: str) -> dict:
    return yaml.load(
        Path(f".github/workflows/{name}").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )


def test_website_deployment_is_serialized_and_does_not_build_a_public_seed() -> None:
    deploy = load("deploy.yml")
    expected = {
        "group": "iammufc-dev-publication",
        "cancel-in-progress": "false",
        "queue": "max",
    }
    assert deploy["concurrency"] == expected
    assert "build-data" not in deploy["jobs"]
    assert "concurrency" not in deploy["jobs"]["deploy-dev"]
    assert not Path(".github/workflows/nightly-refresh.yml").exists()


def test_manual_publication_is_main_only() -> None:
    deploy = load("deploy.yml")
    assert deploy["jobs"]["deploy-dev"]["if"] == (
        "github.ref == 'refs/heads/main' && github.event_name != 'repository_dispatch'"
    )
    assert deploy["jobs"]["consume-private-seed"]["if"] == (
        "github.event_name == 'repository_dispatch' && "
        "github.event.action == 'p13-private-seed-ready' && "
        "github.ref == 'refs/heads/main'"
    )


def test_private_artifact_reader_uses_separate_read_only_app() -> None:
    deploy = load("deploy.yml")
    consumer = deploy["jobs"]["consume-private-seed"]
    token_step = next(
        step for step in consumer["steps"] if step.get("id") == "private-read"
    )
    token = token_step["with"]

    assert consumer["environment"] == "dev"
    assert token["client-id"] == "${{ vars.IAMMUFC_PRIVATE_ARTIFACT_APP_CLIENT_ID }}"
    assert token["private-key"] == "${{ secrets.IAMMUFC_PRIVATE_ARTIFACT_APP_PRIVATE_KEY }}"
    assert token["repositories"] == "iammufc-platform"
    assert token["permission-actions"] == "read"
    assert "permission-contents" not in token
    assert "permission-pull-requests" not in token


def test_artifact_downloads_are_pinned_and_private_seed_is_verified() -> None:
    deploy = load("deploy.yml")
    download_action = (
        "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131"
    )
    actions = list(Path(".github/actions").glob("**/action.yml"))
    workflow_files = list(Path(".github/workflows").glob("*.yml"))
    downloads = [
        step
        for path in [*actions, *workflow_files]
        for step in _steps(yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader))
        if step.get("uses", "").startswith("actions/download-artifact@")
    ]

    assert len(downloads) == 2
    assert all(step["uses"] == download_action for step in downloads)

    consumer_steps = deploy["jobs"]["consume-private-seed"]["steps"]
    private_download_index = next(
        index
        for index, step in enumerate(consumer_steps)
        if step.get("name") == "Download only the referenced private artifact"
    )
    private_download = consumer_steps[private_download_index]
    assert private_download["with"]["github-token"] == (
        "${{ steps.private-read.outputs.token }}"
    )
    assert private_download["with"]["repository"] == (
        "microbrewerGM/iammufc-platform"
    )
    assert private_download["with"]["run-id"] == (
        "${{ github.event.client_payload.private_run_id }}"
    )
    assert private_download["with"]["artifact-ids"] == (
        "${{ github.event.client_payload.private_artifact_id }}"
    )
    assert private_download["with"]["path"] == "private-seed"

    checksum_step = consumer_steps[private_download_index + 1]
    assert checksum_step.get("name") == (
        "Verify the seed checksum and snapshot manifest"
    )
    assert checksum_step.get("run") == (
        "python3 .github/scripts/verify_private_seed_checksum.py"
    )


def _steps(document: dict) -> list[dict]:
    if "jobs" in document:
        return [step for job in document["jobs"].values() for step in job.get("steps", [])]
    return document.get("runs", {}).get("steps", [])


def _verify_after_download(steps: list[dict]) -> bool:
    download = next(
        (i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/download-artifact@")),
        None,
    )
    if download is None:
        return False
    for index, step in enumerate(steps[download + 1 :], start=download + 1):
        run = step.get("run", "")
        if ".github/scripts/verify_public_catalog_producer.py artifact" in run:
            if "if" in step or "continue-on-error" in step:
                return False
            return not any(
                item.get("uses", "").startswith("cloudflare/wrangler-action")
                or re.search(r"\bwrangler\s+(?:deploy|versions)\b", _step_text(item), re.I)
                for item in steps[download + 1 : index]
            )
    return False


def _step_text(step: dict) -> str:
    with_block = step.get("with", {})
    return " ".join([
        step.get("run", ""),
        with_block.get("command", ""),
        with_block.get("preCommands", ""),
        with_block.get("postCommands", ""),
    ])


def test_catalog_provenance_action_verifies_download_before_any_workflow_deploy() -> None:
    action_path = Path(".github/actions/verify-public-catalog-producer/action.yml")
    action = yaml.load(action_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    action_steps = action["runs"]["steps"]
    assert _verify_after_download(action_steps)

    def has_deploy(step: dict) -> bool:
        if step.get("uses", "").startswith("cloudflare/wrangler-action"):
            return True
        return bool(re.search(r"\bwrangler\s+(?:deploy|versions)\b", _step_text(step), re.I))

    def workflow_is_safe(workflow: dict) -> bool:
        jobs = workflow.get("jobs", {})
        deploy_job_indices = []
        for job_index, (job_id, job) in enumerate(jobs.items()):
            steps = job.get("steps", [])
            verify_indices = [
                i for i, step in enumerate(steps)
                if step.get("uses") == "./.github/actions/verify-public-catalog-producer"
            ]
            if any(
                "if" in steps[index] or "continue-on-error" in steps[index]
                for index in verify_indices
            ):
                return False
            deploy_indices = [i for i, step in enumerate(steps) if has_deploy(step)]
            if deploy_indices:
                deploy_job_indices.append(job_index)
                if not verify_indices or any(
                    has_deploy(step) and not any(verify_index < i for verify_index in verify_indices)
                    for i, step in enumerate(steps)
                ):
                    return False
                if any(
                    re.search(r"\b(?:always|failure|cancelled)\s*\(\s*\)", str(steps[i].get("if", "")), re.I)
                    for i in deploy_indices
                ):
                    return False
        for deploy_job_index in deploy_job_indices:
            for job_index, job in enumerate(jobs.values()):
                if job_index > deploy_job_index and re.search(
                    r"\b(?:always|failure|cancelled)\s*\(\s*\)",
                    str(job.get("if", "")),
                    re.I,
                ):
                    return False
        return True

    for workflow_path in Path(".github/workflows").glob("*.yml"):
        workflow = yaml.load(workflow_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
        assert workflow_is_safe(workflow), workflow_path

    negative = {
        "jobs": {
            "unsafe": {"steps": [
                {"uses": "cloudflare/wrangler-action@sha"},
                {"uses": "./.github/actions/verify-public-catalog-producer"},
            ]}
        }
    }
    assert not workflow_is_safe(negative)

    for key, value in (("if", "false"), ("continue-on-error", "${{ true }}")):
        unsafe_call = {
            "jobs": {
                "unsafe": {"steps": [
                    {"uses": "./.github/actions/verify-public-catalog-producer", key: value},
                    {"uses": "cloudflare/wrangler-action@sha"},
                ]}
            }
        }
        assert not workflow_is_safe(unsafe_call)
        safe_call = {
            "jobs": {
                "unsafe": {"steps": [
                    {"uses": "./.github/actions/verify-public-catalog-producer"},
                    {"uses": "cloudflare/wrangler-action@sha"},
                ]}
            }
        }
        assert workflow_is_safe(safe_call)

    for condition in ("always()", "failure()", "cancelled()"):
        conditional_deploy = {
            "jobs": {
                "unsafe": {"steps": [
                    {"uses": "./.github/actions/verify-public-catalog-producer"},
                    {"uses": "cloudflare/wrangler-action@sha", "if": condition},
                ]}
            }
        }
        assert not workflow_is_safe(conditional_deploy)
        conditional_later_job = {
            "jobs": {
                "verified": {"steps": [
                    {"uses": "./.github/actions/verify-public-catalog-producer"},
                    {"uses": "cloudflare/wrangler-action@sha"},
                ]},
                "later": {"if": condition, "steps": []},
            }
        }
        assert not workflow_is_safe(conditional_later_job)

    action_negative = [
        {"uses": "actions/download-artifact@sha"},
        {"run": "wrangler deploy"},
        {"run": "python3 .github/scripts/verify_public_catalog_producer.py artifact"},
    ]
    assert not _verify_after_download(action_negative)

    for key, value in (("if", "false"), ("continue-on-error", "${{ true }}")):
        action_with_unsafe_verify = [
            {"uses": "actions/download-artifact@sha"},
            {
                "run": "python3 .github/scripts/verify_public_catalog_producer.py artifact",
                key: value,
            },
        ]
        assert not _verify_after_download(action_with_unsafe_verify)


def test_private_seed_consumer_applies_schema_and_migration_before_private_seed() -> None:
    deploy = load("deploy.yml")
    steps = deploy["jobs"]["consume-private-seed"]["steps"]
    commands = [step.get("with", {}).get("command", "") for step in steps]
    schema = next(i for i, command in enumerate(commands) if "0001_schema.sql" in command)
    migration = next(i for i, command in enumerate(commands) if "0003_p16_dot_plot.sql" in command)
    cache_migration = next(i for i, command in enumerate(commands) if "0004_cache_slots.sql" in command)
    history_migration = next(
        i for i, command in enumerate(commands) if "0005_account_question_history.sql" in command
    )
    seed = next(i for i, command in enumerate(commands) if "private-seed/0002_seed.sql" in command)
    assert schema < migration < cache_migration < history_migration < seed

    deploy_commands = [
        step.get("with", {}).get("command", "")
        for step in deploy["jobs"]["deploy-dev"]["steps"]
    ]
    deploy_schema = next(i for i, command in enumerate(deploy_commands) if "0001_schema.sql" in command)
    deploy_migration = next(i for i, command in enumerate(deploy_commands) if "0003_p16_dot_plot.sql" in command)
    deploy_cache_migration = next(
        i for i, command in enumerate(deploy_commands) if "0004_cache_slots.sql" in command
    )
    deploy_history_migration = next(
        i for i, command in enumerate(deploy_commands) if "0005_account_question_history.sql" in command
    )
    deploy_worker = next(i for i, command in enumerate(deploy_commands) if command.startswith("deploy "))
    assert deploy_schema < deploy_migration < deploy_cache_migration < deploy_history_migration < deploy_worker
    assert not any("0002_seed.sql" in command for command in deploy_commands)
