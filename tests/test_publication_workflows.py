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
    assert deploy["jobs"]["build-data"]["if"] == "github.ref == 'refs/heads/main'"
    assert refresh["jobs"]["refresh-dev"]["if"] == "github.ref == 'refs/heads/main'"

