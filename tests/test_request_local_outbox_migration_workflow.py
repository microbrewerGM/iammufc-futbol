"""Publication installs the local outbox without changing deployment authority."""

import sqlite3
from contextlib import closing

from .test_request_refresh_migration_workflow import (
    ACTION, NULL_CHECKS, PREFIX, apply, deployed_chain, populate, seed_commands,
    snapshot, workflow,
)
from .test_request_result_migration_workflow import (
    test_publication_authority_stays_on_main_and_dev as assert_publication_authority,
)


LOCAL = "0018_question_request_local_notifications.sql"


def test_both_jobs_install_local_outbox_once_after_0017_before_publication():
    assert_publication_authority()
    for job_name in ("deploy-dev", "consume-private-seed"):
        steps = workflow()["jobs"][job_name]["steps"]
        commands = [step.get("with", {}).get("command", "") for step in steps]
        previous = commands.index(f"{PREFIX} --remote --file infra/migrations/{NULL_CHECKS}")
        expected = f"{PREFIX} --remote --file infra/migrations/{LOCAL}"
        assert sum(LOCAL in command for command in commands) == 1
        assert steps[previous + 1] == {
            "name": "Apply question request local notifications migration (dev)",
            "uses": ACTION,
            "with": {"apiToken": "${{ secrets.CF_TOKEN_DEV }}",
                     "accountId": "${{ secrets.CF_ACCOUNT }}", "command": expected},
        }
        worker = commands.index("deploy --config infra/wrangler.jsonc --env dev")
        assert previous + 1 < worker
        if job_name == "consume-private-seed":
            seed = commands.index(f"{PREFIX} --remote --file private-seed/0002_seed.sql")
            assert previous + 1 < seed < worker


def test_local_seed_installs_outbox_once_after_0017_before_seed():
    commands = seed_commands()
    names = deployed_chain()
    assert names[-2:] == [NULL_CHECKS, LOCAL]
    assert names.count(LOCAL) == 1
    assert commands[-1][-1] == "infra/migrations/0002_seed.sql"
    for command in commands:
        assert command[:-1] == ["wrangler", "d1", "execute", "iammufc-dev", "--config",
                               "infra/wrangler.jsonc", "--env", "dev", "--local", "--file"]


def test_populated_chain_through_0018_replays_without_schema_or_data_change():
    names = deployed_chain()
    assert names[-1] == LOCAL
    with closing(sqlite3.connect(":memory:")) as db:
        db.execute("PRAGMA foreign_keys=ON")
        apply(db, names[:-1])
        populate(db)
        db.execute(
            "INSERT INTO question_request_notifications(request_id,desired_status,created_at,updated_at,expires_at) "
            "SELECT request_id,'clarification_required',strftime('%Y-%m-%dT%H:%M:%SZ','now'),"
            "strftime('%Y-%m-%dT%H:%M:%SZ','now'),expires_at FROM question_requests"
        )
        legacy = snapshot(db)[1]
        apply(db, [LOCAL])
        for table, rows in legacy.items():
            assert snapshot(db)[1][table] == rows, table
        db.execute(
            "INSERT INTO question_request_local_notifications(request_id,payload_revision,status,result_path) "
            "SELECT request_id,desired_revision,desired_status,desired_result_path "
            "FROM question_request_notifications"
        )
        assert db.execute("SELECT count(*) FROM question_request_local_notifications").fetchone()[0] > 0
        db.commit()
        once = snapshot(db)
        apply(db, names)
        assert snapshot(db) == once
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
