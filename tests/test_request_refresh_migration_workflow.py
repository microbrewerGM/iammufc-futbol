"""Publication installs refresh and NULL checks on the actual replayed chain."""

import json
import shlex
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "infra/migrations"
REFRESH = "0016_question_request_refresh.sql"
NULL_CHECKS = "0017_exploration_null_checks.sql"
LOCK = "question_request_results_refresh_upgrade_lock"
PREFIX = "d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev"
ACTION = "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0"


def workflow():
    return yaml.load((ROOT / ".github/workflows/deploy.yml").read_text(), Loader=yaml.BaseLoader)


def seed_commands():
    script = json.loads((ROOT / "package.json").read_text())["scripts"]["d1:seed"]
    return [shlex.split(part.strip()) for part in script.split("&&")]


def deployed_chain():
    return [Path(command[-1]).name for command in seed_commands()][:-1]


def apply(db, names):
    for name in names:
        db.executescript((MIGRATIONS / name).read_text())


def snapshot(db):
    schema = db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    ).fetchall()
    data = {}
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        data[table] = sorted(db.execute(f'SELECT * FROM "{table}"').fetchall(), key=repr)
    return schema, data


def populate(db):
    """Valid legacy result and exploration rows, with all production triggers on."""
    now, expires, deadline = db.execute(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now'),"
        "strftime('%Y-%m-%dT%H:%M:%SZ','now','+90 days'),"
        "strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day')"
    ).fetchone()
    request_id = "a" * 64
    db.execute(
        "INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,"
        "created_at,updated_at,expires_at) VALUES(?,'test-owner','Show goals','en',?,'received',?,?,?)",
        (request_id, "b" * 64, now, now, expires),
    )
    db.execute(
        "UPDATE question_requests SET status='triaging',attempt=1,lease_id='test-lease',"
        "lease_owner='test-service',claimed_at=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'+900 seconds'),"
        "updated_at=?,revision=revision+1", (now, now, now),
    )
    verdict = json.dumps(dict(version=1, request_id=request_id, relevant=True, junk_reason=None,
                              restated_question="Show goals", tables=[], visuals=[], field_status=[], families=[]))
    db.execute("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,"
               "updated_at=?,revision=revision+1", (verdict, now))
    db.execute("UPDATE question_requests SET status='no_data',updated_at=?,revision=revision+1", (now,))
    db.execute(
        "INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,"
        "response_deadline,expires_at) VALUES(?,4,'clarification_required',?,?,?,?)",
        (request_id, now, now, deadline, expires),
    )
    request = json.dumps(dict(version=1, family="arrival_manager", as_of=now[:10],
                              population="first_team_available", joining_basis="effective_first_team_spell_entry",
                              academy_basis="documented_first_team_promotion", visualization="table"))
    db.execute("INSERT INTO exploration_shared_requests VALUES(?,1,?,?)", (request_id, request, now))
    db.execute("INSERT INTO exploration_request_links VALUES(?,'test-owner',?,?)", (request_id, now, expires))
    db.commit()


class RequestRefreshWorkflowTests(unittest.TestCase):
    def assert_unlocked(self, db):
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name=?", (LOCK,)).fetchone())

    def test_both_jobs_install_once_in_order_with_unchanged_action_contract(self):
        for job_name in ("deploy-dev", "consume-private-seed"):
            with self.subTest(job=job_name):
                steps = workflow()["jobs"][job_name]["steps"]
                commands = [step.get("with", {}).get("command", "") for step in steps]
                previous = commands.index(f"{PREFIX} --remote --file infra/migrations/0015_question_request_notifications.sql")
                for offset, name in enumerate((REFRESH, NULL_CHECKS), 1):
                    expected = f"{PREFIX} --remote --file infra/migrations/{name}"
                    self.assertEqual(sum(name in command for command in commands), 1)
                    self.assertEqual(commands[previous + offset], expected)
                    self.assertEqual(steps[previous + offset], {
                        "name": "Apply question request refresh migration (dev)" if name == REFRESH
                        else "Apply exploration null checks migration (dev)",
                        "uses": ACTION,
                        "with": {"apiToken": "${{ secrets.CF_TOKEN_DEV }}",
                                 "accountId": "${{ secrets.CF_ACCOUNT }}", "command": expected},
                    })
                worker = commands.index("deploy --config infra/wrangler.jsonc --env dev")
                self.assertLess(previous + 2, worker)
                if job_name == "consume-private-seed":
                    seed = commands.index(f"{PREFIX} --remote --file private-seed/0002_seed.sql")
                    self.assertLess(previous + 2, seed)
                    self.assertLess(seed, worker)

    def test_local_and_both_remote_paths_run_the_identical_chain_without_0007(self):
        local = seed_commands()
        prefix = shlex.split(f"wrangler {PREFIX} --local --file")
        for command in local:
            self.assertEqual(command[:-1], prefix)
        self.assertEqual(local[-1][-1], "infra/migrations/0002_seed.sql")
        names = deployed_chain()
        self.assertEqual(names[-4:], ["0015_question_request_notifications.sql", REFRESH, NULL_CHECKS,
                                     "0018_question_request_local_notifications.sql"])
        self.assertEqual(len(names), len(set(names)))
        self.assertNotIn("0007_exploration_requests.sql", names)
        for job in workflow()["jobs"].values():
            remote = [step.get("with", {}).get("command", "") for step in job["steps"]]
            files = [shlex.split(command)[-1] for command in remote if "--file infra/migrations/" in command]
            self.assertEqual(files, [f"infra/migrations/{name}" for name in names])

    def test_full_chain_replays_without_schema_or_data_changes_on_populated_database(self):
        names = deployed_chain()
        with closing(sqlite3.connect(":memory:")) as db:
            db.execute("PRAGMA foreign_keys=ON")
            apply(db, names[:names.index(REFRESH)])
            populate(db)
            legacy_data = snapshot(db)[1]
            apply(db, names[names.index(REFRESH):])
            self.assert_unlocked(db)
            self.assertEqual(db.execute("SELECT refresh_count FROM question_request_refresh_counts").fetchall(), [(0,)])
            for table, rows in legacy_data.items():
                self.assertEqual(snapshot(db)[1][table], rows, table)
            once = snapshot(db)
            apply(db, names)
            self.assert_unlocked(db)
            self.assertEqual(snapshot(db), once)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_0017_guards_are_installed_by_the_actual_chain(self):
        with closing(sqlite3.connect(":memory:")) as db:
            apply(db, deployed_chain())
            targets = dict(db.execute("SELECT name,tbl_name FROM sqlite_master WHERE type='trigger'"))
            for stem, table in (
                ("requests", "exploration_shared_requests"), ("links", "exploration_request_links"),
                ("results", "exploration_shared_results"), ("jobs", "exploration_shared_jobs"),
                ("tombstones", "exploration_shared_job_tombstones"), ("operations", "exploration_bridge_operations"),
            ):
                for operation in ("insert", "update"):
                    self.assertEqual(targets[f"exploration_{stem}_dates_{operation}"], table)
            populate(db)
            with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid exploration request timestamp"):
                db.execute("UPDATE exploration_shared_requests SET created_at='2026-99-03T12:00:00Z'")

    def test_upgrade_lock_blocks_result_updates_until_same_file_completes(self):
        names = deployed_chain()
        sql = (MIGRATIONS / REFRESH).read_text()
        first_statement = sql[:sql.index("END;") + len("END;")]
        with closing(sqlite3.connect(":memory:")) as db:
            apply(db, names[:names.index(REFRESH)])
            populate(db)
            db.executescript(first_statement)
            with self.assertRaisesRegex(sqlite3.IntegrityError, "request refresh migration incomplete"):
                db.execute("UPDATE question_request_results SET state='expired',revision=revision+1")
            db.executescript(sql)
            self.assert_unlocked(db)
            db.executescript(sql)
            self.assert_unlocked(db)


if __name__ == "__main__":
    unittest.main()
