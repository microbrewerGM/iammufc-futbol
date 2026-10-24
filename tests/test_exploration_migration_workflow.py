"""Exploration storage migration stays ordered in deploy and local publication paths."""

import json
import sqlite3
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

    deploy_0008 = next(i for i, command in enumerate(deploy_commands) if "0008_exploration_request_links.sql" in command)
    deploy_0009 = next(i for i, command in enumerate(deploy_commands) if "0009_manager_era_records.sql" in command)
    consumer_0008 = next(i for i, command in enumerate(consumer_commands) if "0008_exploration_request_links.sql" in command)
    consumer_0009 = next(i for i, command in enumerate(consumer_commands) if "0009_manager_era_records.sql" in command)
    assert deploy_0006 + 1 == deploy_0008 < worker
    assert deploy_0008 + 1 == deploy_0009 < worker
    assert consumer_0006 + 1 == consumer_0008
    assert consumer_0008 + 1 == consumer_0009 < seed
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
    # 0008 supersedes 0007 (it drops the legacy tables), so neither deploy job nor
    # the local seed may re-apply 0007 on top of it.
    assert not any("0007_exploration_requests.sql" in command for command in deploy_commands + consumer_commands)

    local_seed = json.loads(Path("package.json").read_text(encoding="utf-8"))["scripts"]["d1:seed"]
    assert "--remote" not in local_seed
    assert local_seed.index("0005_account_question_history.sql") < local_seed.index("0006_season_splits.sql") < local_seed.index("0002_seed.sql")
    assert local_seed.index("0006_season_splits.sql") < local_seed.index("0008_exploration_request_links.sql") < local_seed.index("0002_seed.sql")
    assert "0007_exploration_requests.sql" not in local_seed

    assert deploy["permissions"] == {"contents": "read"}
    assert all(job["permissions"] == {"contents": "read"} for job in deploy["jobs"].values())


def test_exploration_links_migration_is_idempotent_and_replaces_legacy_tables() -> None:
    migrations = Path("infra/migrations")
    base = [
        "0001_schema.sql",
        "0003_p16_dot_plot.sql",
        "0004_cache_slots.sql",
        "0005_account_question_history.sql",
        "0006_season_splits.sql",
    ]
    link = (migrations / "0008_exploration_request_links.sql").read_text(encoding="utf-8")

    # The redesign ruling accepts removing 0007 only because the checked-in
    # bridge has no writer for those tables at the reviewed HEAD.
    assert "confirmed in the repository at redesign HEAD da4d6d4" in link
    assert "no code path writes them yet" in link
    assert "exploration_shared_jobs_orphan_collect" in link
    assert "exploration_request_links_orphan_collect" in link
    assert "exploration_shared_job_tombstones_immutable" in link
    assert "exploration_shared_job_tombstones_retention_monotonic" in link
    assert "NEW.revision != OLD.revision + 1" in link
    assert "service TEXT NOT NULL" in link
    assert "PRIMARY KEY (service, operation_type, operation_id)" in link

    def schema(db: sqlite3.Connection) -> list[tuple]:
        return db.execute(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()

    for with_legacy in (False, True):
        db = sqlite3.connect(":memory:")
        try:
            for name in base + (["0007_exploration_requests.sql"] if with_legacy else []):
                db.executescript((migrations / name).read_text(encoding="utf-8"))
            db.executescript(link)
            once = schema(db)
            tables = {name for kind, name, _ in once if kind == "table"}
            assert "exploration_shared_requests" in tables
            assert "exploration_request_links" in tables
            assert not tables & {
                "exploration_requests",
                "exploration_results",
                "exploration_jobs",
                "exploration_request_accounts",
                "exploration_job_idempotency",
            }
            db.executescript(link)
            assert schema(db) == once
        finally:
            db.close()
