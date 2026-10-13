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


def test_private_seed_consumer_applies_schema_and_migration_before_private_seed() -> None:
    deploy = load("deploy.yml")
    steps = deploy["jobs"]["consume-private-seed"]["steps"]
    commands = [step.get("with", {}).get("command", "") for step in steps]
    schema = next(i for i, command in enumerate(commands) if "0001_schema.sql" in command)
    migration = next(i for i, command in enumerate(commands) if "0003_p16_dot_plot.sql" in command)
    seed = next(i for i, command in enumerate(commands) if "private-seed/0002_seed.sql" in command)
    assert schema < migration < seed

    deploy_commands = [
        step.get("with", {}).get("command", "")
        for step in deploy["jobs"]["deploy-dev"]["steps"]
    ]
    assert not any("0002_seed.sql" in command for command in deploy_commands)
