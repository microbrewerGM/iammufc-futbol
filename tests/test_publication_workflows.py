"""The website consumes private data and deploys code without rebuilding data."""

from pathlib import Path

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
    assert deploy["jobs"]["deploy-dev"]["if"] == "github.event_name != 'repository_dispatch'"
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
    downloads = [
        step
        for job in deploy["jobs"].values()
        for step in job.get("steps", [])
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
