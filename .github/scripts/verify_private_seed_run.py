"""Validate repository_dispatch metadata against the private producer run."""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any


def verify_run(
    run: dict[str, Any],
    *,
    run_id: str,
    attempt: str,
    commit: str,
    workflow_id: str,
    artifact_id: str,
) -> None:
    """Fail closed unless the referenced run is the exact trusted producer run."""
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("invalid producer run identifier")
    if not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise ValueError("invalid producer run attempt")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("invalid producer commit")
    if not re.fullmatch(r"[1-9][0-9]*", workflow_id):
        raise ValueError("invalid producer workflow identifier")
    if not re.fullmatch(r"[1-9][0-9]*", artifact_id):
        raise ValueError("invalid private artifact identifier")

    expected = {
        "id": int(run_id),
        "run_attempt": int(attempt),
        "head_sha": commit,
        "workflow_id": int(workflow_id),
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
    }
    if any(run.get(key) != value for key, value in expected.items()):
        raise ValueError("private producer run does not match the approved publication")


def main() -> int:
    try:
        run = json.load(sys.stdin)
        if not isinstance(run, dict):
            raise ValueError("producer run response is invalid")
        verify_run(
            run,
            run_id=os.environ["PRIVATE_RUN_ID"],
            attempt=os.environ["PRIVATE_RUN_ATTEMPT"],
            commit=os.environ["PRIVATE_COMMIT"],
            workflow_id=os.environ["PRIVATE_WORKFLOW_ID"],
            artifact_id=os.environ["PRIVATE_ARTIFACT_ID"],
        )
    except (KeyError, json.JSONDecodeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("private producer run verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
