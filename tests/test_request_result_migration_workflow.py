"""Every publication path installs the result lifecycle before serving it."""

import json
import shlex
from pathlib import Path

import pytest
import yaml


MIGRATIONS = (
    "0013_question_request_results.sql",
    "0014_question_request_clarifications.sql",
    "0015_question_request_notifications.sql",
)
WRANGLER = "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0"
PREFIX = "d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev"


def workflow():
    return yaml.load(Path(".github/workflows/deploy.yml").read_text(), Loader=yaml.BaseLoader)


@pytest.mark.parametrize("job_name", ("deploy-dev", "consume-private-seed"))
def test_result_migrations_run_once_in_order_before_publication(job_name):
    steps = workflow()["jobs"][job_name]["steps"]
    commands = [step.get("with", {}).get("command", "") for step in steps]
    previous = commands.index(f"{PREFIX} --remote --file infra/migrations/0012_cl_season_stage.sql")
    for offset, name in enumerate(MIGRATIONS, 1):
        expected = f"{PREFIX} --remote --file infra/migrations/{name}"
        assert commands.count(expected) == 1
        assert sum(name in command for command in commands) == 1
        assert commands[previous + offset] == expected
        step = steps[previous + offset]
        assert set(step) == {"name", "uses", "with"}
        assert step["uses"] == WRANGLER
        assert step["with"] == {
            "apiToken": "${{ secrets.CF_TOKEN_DEV }}",
            "accountId": "${{ secrets.CF_ACCOUNT }}",
            "command": expected,
        }
        assert (Path("infra/migrations") / name).is_file()
    worker = commands.index("deploy --config infra/wrangler.jsonc --env dev")
    assert previous + len(MIGRATIONS) < worker
    if job_name == "consume-private-seed":
        seed = commands.index(f"{PREFIX} --remote --file private-seed/0002_seed.sql")
        assert previous + len(MIGRATIONS) < seed < worker


def test_local_seed_has_the_same_order_without_remote_execution():
    script = json.loads(Path("package.json").read_text())["scripts"]["d1:seed"]
    commands = [shlex.split(part.strip()) for part in script.split("&&")]
    assert all("--remote" not in command for command in commands)
    prefix = shlex.split(f"wrangler {PREFIX} --local --file")
    previous = commands.index(prefix + ["infra/migrations/0012_cl_season_stage.sql"])
    for offset, name in enumerate(MIGRATIONS, 1):
        expected = prefix + [f"infra/migrations/{name}"]
        assert commands.count(expected) == 1
        assert sum(any(name in arg for arg in command) for command in commands) == 1
        assert commands[previous + offset] == expected
    assert previous + len(MIGRATIONS) < commands.index(prefix + ["infra/migrations/0002_seed.sql"])


def test_publication_authority_stays_on_main_and_dev():
    deploy = workflow()
    assert deploy["on"] == {
        "push": {"branches": ["main"]},
        "workflow_dispatch": "",
        "repository_dispatch": {"types": ["p13-private-seed-ready"]},
    }
    assert deploy["permissions"] == {"contents": "read"}
    assert deploy["concurrency"] == {
        "group": "iammufc-dev-publication", "cancel-in-progress": "false", "queue": "max"
    }
    jobs = deploy["jobs"]
    assert set(jobs) == {"deploy-dev", "consume-private-seed"}
    assert jobs["deploy-dev"]["if"] == "github.ref == 'refs/heads/main' && github.event_name != 'repository_dispatch'"
    assert jobs["consume-private-seed"]["if"] == "github.event_name == 'repository_dispatch' && github.event.action == 'p13-private-seed-ready' && github.ref == 'refs/heads/main'"
    for job in jobs.values():
        assert job["environment"] == "dev"
        assert job["permissions"] == {"contents": "read"}
