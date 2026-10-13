"""Publication workflows must serialize every dev D1 mutation."""

from pathlib import Path

import yaml


def load(name: str) -> dict:
    return yaml.load(
        Path(f".github/workflows/{name}").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )


def test_deploy_and_refresh_share_a_queued_workflow_lock() -> None:
    deploy = load("deploy.yml")
    refresh = load("nightly-refresh.yml")
    expected = {
        "group": "iammufc-dev-publication",
        "cancel-in-progress": "false",
        "queue": "max",
    }
    assert deploy["concurrency"] == expected
    assert refresh["concurrency"] == expected
    assert "concurrency" not in deploy["jobs"]["build-data"]
    assert "concurrency" not in deploy["jobs"]["deploy-dev"]


def test_manual_publication_is_main_only() -> None:
    deploy = load("deploy.yml")
    refresh = load("nightly-refresh.yml")
    assert deploy["jobs"]["build-data"]["if"] == (
        "github.ref == 'refs/heads/main' && github.event_name != 'repository_dispatch'"
    )
    assert deploy["jobs"]["deploy-dev"]["if"] == "github.event_name != 'repository_dispatch'"
    assert deploy["jobs"]["consume-private-seed"]["if"] == (
        "github.event_name == 'repository_dispatch' && "
        "github.event.action == 'p13-private-seed-ready' && "
        "github.ref == 'refs/heads/main'"
    )
    assert refresh["jobs"]["refresh-dev"]["if"] == "github.ref == 'refs/heads/main'"


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


def test_dot_plot_constraint_migration_precedes_seed_in_both_workflows() -> None:
    for name in ("deploy.yml", "nightly-refresh.yml"):
        workflow = load(name)
        job = "deploy-dev" if name == "deploy.yml" else "refresh-dev"
        commands = [
            step.get("with", {}).get("command", "")
            for step in workflow["jobs"][job]["steps"]
        ]
        schema = next(i for i, command in enumerate(commands) if "0001_schema.sql" in command)
        migration = next(i for i, command in enumerate(commands) if "0003_p16_dot_plot.sql" in command)
        seed = next(i for i, command in enumerate(commands) if "0002_seed.sql" in command)
        assert schema < migration < seed
