#!/usr/bin/env python3
"""Verify the private Actions run and exact catalog artifact for statement v2."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def positive_int(value: str, name: str) -> int:
    require(bool(re.fullmatch(r"[1-9][0-9]*", value)), f"invalid {name}")
    return int(value)


def parse_statement_outputs(statement: Any) -> dict[str, str]:
    v1_fields = {
        "statement_version", "catalog_contract_version", "source_revision", "builder",
        "builder_version", "artifact_sha256", "metric_count", "coverage_count", "validation_passed",
    }
    v2_fields = v1_fields | {"producer_run_id", "producer_run_attempt", "producer_artifact_id"}
    require(type(statement) is dict, "release statement must be an object")
    version = statement.get("statement_version")
    require(type(version) is int and version in {1, 2}, "unsupported release statement version")
    fields = v1_fields if version == 1 else v2_fields
    require(set(statement) == fields, "release statement fields are invalid")
    require(statement["catalog_contract_version"] == 1 and type(statement["catalog_contract_version"]) is int, "unsupported catalog contract")
    require(statement["builder"] == "iammufc-private-public-catalog", "unknown producer")
    require(statement["builder_version"] == version and type(statement["builder_version"]) is int, "builder version mismatch")
    require(statement["validation_passed"] is True, "producer validation did not pass")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", statement["source_revision"])), "invalid source revision")
    require(bool(re.fullmatch(r"[0-9a-f]{64}", statement["artifact_sha256"])), "invalid artifact digest")
    for name in ("metric_count", "coverage_count"):
        require(type(statement[name]) is int and statement[name] > 0, f"invalid {name}")
    outputs = {"version": str(version)}
    if version == 2:
        for field, output in (
            ("producer_run_id", "run_id"),
            ("producer_run_attempt", "run_attempt"),
            ("producer_artifact_id", "artifact_id"),
        ):
            require(type(statement[field]) is int and statement[field] > 0, f"invalid {field}")
            outputs[output] = str(statement[field])
        outputs["source_revision"] = statement["source_revision"]
    return outputs


def verify_run(run: dict[str, Any], env: dict[str, str]) -> None:
    run_id = positive_int(env["PRODUCER_RUN_ID"], "run id")
    attempt = positive_int(env["PRODUCER_RUN_ATTEMPT"], "run attempt")
    artifact_id = positive_int(env["PRODUCER_ARTIFACT_ID"], "artifact id")
    workflow_id = positive_int(env["PRODUCER_WORKFLOW_ID"], "workflow id")
    source_revision = env["PRODUCER_SOURCE_REVISION"]
    expected_path = env["PRODUCER_WORKFLOW"]
    require(bool(re.fullmatch(r"[0-9a-f]{40}", source_revision)), "invalid source revision")
    require(run.get("id") == run_id, "producer run id mismatch")
    require(run.get("run_attempt") == attempt, "producer run attempt mismatch")
    require(run.get("head_sha") == source_revision, "producer source revision mismatch")
    require(run.get("workflow_id") == workflow_id, "producer workflow id mismatch")
    require(run.get("path", "").split("@", 1)[0] == expected_path, "producer workflow path mismatch")
    require(run.get("head_branch") == "main", "producer branch is not main")
    require(run.get("event") in {"push", "workflow_dispatch"}, "producer event is not trusted")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "producer run did not succeed")
    require(artifact_id > 0, "invalid artifact id")


def verify_artifact_metadata(artifact: dict[str, Any], env: dict[str, str]) -> None:
    run_id = positive_int(env["PRODUCER_RUN_ID"], "run id")
    attempt = positive_int(env["PRODUCER_RUN_ATTEMPT"], "run attempt")
    artifact_id = positive_int(env["PRODUCER_ARTIFACT_ID"], "artifact id")
    source_revision = env["PRODUCER_SOURCE_REVISION"]
    run = artifact.get("workflow_run")
    require(artifact.get("id") == artifact_id, "producer artifact id mismatch")
    require(artifact.get("name") == f"iammufc-public-catalog-{run_id}-{attempt}", "producer artifact attempt/name mismatch")
    require(artifact.get("expired") is False, "producer artifact is expired")
    require(type(run) is dict and run.get("id") == run_id, "artifact belongs to a different producer run")
    require(run.get("head_branch") == "main", "artifact producer branch is not main")
    require(run.get("head_sha") == source_revision, "artifact producer revision mismatch")


def verify_catalog(statement: Any, actual: bytes, expected: bytes, artifact_id: str) -> None:
    required = {
        "statement_version", "catalog_contract_version", "source_revision", "builder",
        "builder_version", "artifact_sha256", "metric_count", "coverage_count",
        "validation_passed", "producer_run_id", "producer_run_attempt", "producer_artifact_id",
    }
    require(type(statement) is dict and set(statement) == required, "release statement fields are invalid")
    require(statement["statement_version"] == 2 and statement["builder_version"] == 2, "unsupported statement version")
    require(statement["builder"] == "iammufc-private-public-catalog", "unknown producer")
    require(statement["validation_passed"] is True, "producer validation did not pass")
    for name in ("catalog_contract_version", "metric_count", "coverage_count", "producer_run_id", "producer_run_attempt", "producer_artifact_id"):
        require(type(statement[name]) is int and statement[name] > 0, f"invalid {name}")
    require(statement["producer_artifact_id"] == positive_int(artifact_id, "artifact id"), "artifact id mismatch")
    require(actual == expected, "producer artifact differs from the published catalog")
    catalog = json.loads(actual.decode("utf-8"))
    require(type(catalog) is dict and catalog.get("version") == statement["catalog_contract_version"], "catalog contract version mismatch")
    require(type(catalog.get("metrics")) is list and len(catalog["metrics"]) == statement["metric_count"], "catalog metric count mismatch")
    require(type(catalog.get("coverage")) is list and len(catalog["coverage"]) == statement["coverage_count"], "catalog coverage count mismatch")
    digest = hashlib.sha256(actual).hexdigest()
    require(statement["artifact_sha256"] == digest, "release statement digest mismatch")


def verify_artifact(root: Path, env: dict[str, str]) -> None:
    statement = json.loads(Path("worker/src/generated/catalog-release.json").read_text(encoding="utf-8"))
    expected = Path("worker/src/generated/catalog.json").read_bytes()
    candidates = list(root.rglob("catalog.json"))
    require(len(candidates) == 1, "producer artifact must contain one catalog.json")
    verify_catalog(statement, candidates[0].read_bytes(), expected, env["PRODUCER_ARTIFACT_ID"])

def main() -> None:
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {"outputs", "run", "artifact-metadata", "artifact"}:
            raise ValueError("expected outputs, run, artifact-metadata, or artifact mode")
        if sys.argv[1] == "outputs":
            statement = json.loads(Path("worker/src/generated/catalog-release.json").read_text(encoding="utf-8"))
            for key, value in parse_statement_outputs(statement).items():
                print(f"{key}={value}")
        elif sys.argv[1] == "run":
            run = json.load(sys.stdin)
            verify_run(run, os.environ)
        elif sys.argv[1] == "artifact-metadata":
            artifact = json.load(sys.stdin)
            verify_artifact_metadata(artifact, os.environ)
        else:
            verify_artifact(Path("verified-public-catalog"), os.environ)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"private catalog provenance verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    if sys.argv[1] != "outputs":
        print(f"private catalog {sys.argv[1]} verification passed")


if __name__ == "__main__":
    main()
