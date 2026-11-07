"""Install the live-reference repair before publication; replay preserves rows."""

import sqlite3
from contextlib import closing

from .test_request_refresh_migration_workflow import (
    ACTION, PREFIX, apply, deployed_chain, populate, seed_commands, snapshot, workflow,
)
from .test_request_result_migration_workflow import (
    test_publication_authority_stays_on_main_and_dev as assert_publication_authority,
)
from . import test_request_result_migration_workflow as authority_helpers

LOCAL = "0018_question_request_local_notifications.sql"
LIVE_REFS = "0019_exploration_live_question_refs.sql"


def test_both_jobs_install_live_refs_once_after_0018_before_publication(monkeypatch):
    monkeypatch.setattr(authority_helpers, "workflow", workflow)
    assert_publication_authority()
    for job_name in ("deploy-dev", "consume-private-seed"):
        steps = workflow()["jobs"][job_name]["steps"]
        commands = [step.get("with", {}).get("command", "") for step in steps]
        previous = commands.index(f"{PREFIX} --remote --file infra/migrations/{LOCAL}")
        assert sum(LIVE_REFS in command for command in commands) == 1
        assert steps[previous + 1] == {
            "name": "Apply exploration live question references migration (dev)",
            "uses": ACTION,
            "with": {"apiToken": "${{ secrets.CF_TOKEN_DEV }}",
                     "accountId": "${{ secrets.CF_ACCOUNT }}",
                     "command": f"{PREFIX} --remote --file infra/migrations/{LIVE_REFS}"},
        }
        worker = commands.index("deploy --config infra/wrangler.jsonc --env dev")
        assert previous + 1 < worker
        if job_name == "consume-private-seed":
            seed = commands.index(f"{PREFIX} --remote --file private-seed/0002_seed.sql")
            assert previous + 1 < seed < worker
        files = [command.split()[-1] for command in commands
                 if "--file infra/migrations/" in command and "/once/" not in command]
        assert files == [f"infra/migrations/{name}" for name in deployed_chain()]


def test_local_seed_installs_live_refs_once_after_0018_before_seed():
    commands = seed_commands()
    names = deployed_chain()
    assert names[-2:] == [LOCAL, LIVE_REFS]
    assert names.count(LIVE_REFS) == 1
    assert commands[-1][-1] == "infra/migrations/0002_seed.sql"
    for command in commands:
        assert command[:-1] == ["wrangler", "d1", "execute", "iammufc-dev", "--config",
                               "infra/wrangler.jsonc", "--env", "dev", "--local", "--file"]


def test_populated_chain_through_0019_replays_without_schema_or_data_change():
    names = deployed_chain()
    assert names[-1] == LIVE_REFS
    with closing(sqlite3.connect(":memory:")) as db:
        db.execute("PRAGMA foreign_keys=ON")
        apply(db, names[:-1])
        populate(db)
        legacy = snapshot(db)[1]
        apply(db, [LIVE_REFS])
        assert snapshot(db)[1] == legacy
        once = snapshot(db)
        apply(db, [LIVE_REFS])
        assert snapshot(db) == once
        apply(db, names)
        assert snapshot(db) == once
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
