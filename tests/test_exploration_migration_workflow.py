"""Exploration storage migration stays ordered in deploy and local publication paths."""

import json
from pathlib import Path

import yaml


def load_deploy() -> dict:
    return yaml.load(
        Path(".github/workflows/deploy.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )


def command_steps(job: dict) -> list[str]:
    return [step.get("with", {}).get("command", "") for step in job["steps"]]


def test_season_migration_is_ordered_before_worker_and_private_seed() -> None:
    deploy = load_deploy()
    deploy_commands = command_steps(deploy["jobs"]["deploy-dev"])
    consumer_commands = command_steps(deploy["jobs"]["consume-private-seed"])
    deploy_0005 = next(i for i, command in enumerate(deploy_commands) if "0005_account_question_history.sql" in command)
    deploy_0006 = next(i for i, command in enumerate(deploy_commands) if "0006_season_splits.sql" in command)
    worker = next(i for i, command in enumerate(deploy_commands) if command.startswith("deploy "))
    consumer_0005 = next(i for i, command in enumerate(consumer_commands) if "0005_account_question_history.sql" in command)
    consumer_0006 = next(i for i, command in enumerate(consumer_commands) if "0006_season_splits.sql" in command)
    seed = next(i for i, command in enumerate(consumer_commands) if "private-seed/0002_seed.sql" in command)
    assert deploy_0005 < deploy_0006 < worker
    assert consumer_0005 < consumer_0006 < seed

    migration_steps = [
        step
        for job in deploy["jobs"].values()
        for step in job.get("steps", [])
        if "0006_season_splits.sql" in step.get("with", {}).get("command", "")
    ]
    assert len(migration_steps) == 2
    assert all(step["uses"] == "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0" for step in migration_steps)
    assert all("--remote" in step["with"]["command"] for step in migration_steps)
    assert all(set(step["with"]) == {"apiToken", "accountId", "command"} for step in migration_steps)

    deploy_0007 = next(i for i, command in enumerate(deploy_commands) if "0007_exploration_requests.sql" in command)
    deploy_0008 = next(i for i, command in enumerate(deploy_commands) if "0008_exploration_request_links.sql" in command)
    consumer_0007 = next(i for i, command in enumerate(consumer_commands) if "0007_exploration_requests.sql" in command)
    consumer_0008 = next(i for i, command in enumerate(consumer_commands) if "0008_exploration_request_links.sql" in command)
    assert deploy_0006 + 1 == deploy_0007 < worker
    assert consumer_0006 + 1 == consumer_0007 < seed
    assert deploy_0007 + 1 == deploy_0008 < worker
    assert consumer_0007 + 1 == consumer_0008 < seed
    request_steps = [
        step
        for job in deploy["jobs"].values()
        for step in job.get("steps", [])
        if "0007_exploration_requests.sql" in step.get("with", {}).get("command", "")
    ]
    assert len(request_steps) == 2
    assert request_steps[0] == request_steps[1]
    assert all(step["uses"] == "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0" for step in request_steps)
    assert all("--remote" in step["with"]["command"] for step in request_steps)
    assert all(set(step["with"]) == {"apiToken", "accountId", "command"} for step in request_steps)

    link_steps = [
        step
        for job in deploy["jobs"].values()
        for step in job.get("steps", [])
        if "0008_exploration_request_links.sql" in step.get("with", {}).get("command", "")
    ]
    assert len(link_steps) == 2
    assert link_steps[0] == link_steps[1]
    assert all(step["uses"] == "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0" for step in link_steps)
    assert all("--remote" in step["with"]["command"] for step in link_steps)
    assert all(set(step["with"]) == {"apiToken", "accountId", "command"} for step in link_steps)

    local_seed = json.loads(Path("package.json").read_text(encoding="utf-8"))["scripts"]["d1:seed"]
    assert "--remote" not in local_seed
    assert local_seed.index("0005_account_question_history.sql") < local_seed.index("0006_season_splits.sql") < local_seed.index("0002_seed.sql")
    assert local_seed.index("0006_season_splits.sql") < local_seed.index("0007_exploration_requests.sql") < local_seed.index("0002_seed.sql")

    assert deploy["permissions"] == {"contents": "read"}
    assert all(job["permissions"] == {"contents": "read"} for job in deploy["jobs"].values())
