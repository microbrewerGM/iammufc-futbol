from __future__ import annotations

import hashlib
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / ".github" / "scripts"
SPEC = spec_from_file_location("verify_public_catalog_producer", SCRIPTS / "verify_public_catalog_producer.py")
assert SPEC is not None and SPEC.loader is not None
VERIFY = module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class PublicCatalogProducerTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "PRODUCER_RUN_ID": "1234",
            "PRODUCER_RUN_ATTEMPT": "2",
            "PRODUCER_ARTIFACT_ID": "7624",
            "PRODUCER_WORKFLOW_ID": "987",
            "PRODUCER_SOURCE_REVISION": "a" * 40,
            "PRODUCER_WORKFLOW": ".github/workflows/publish-public-catalog.yml",
        }
        self.run = {
            "id": 1234,
            "run_attempt": 2,
            "head_sha": "a" * 40,
            "workflow_id": 987,
            "path": ".github/workflows/publish-public-catalog.yml@refs/heads/main",
            "head_branch": "main",
            "event": "push",
            "status": "completed",
            "conclusion": "success",
        }
        self.catalog = b'{"coverage":[{}],"metrics":[{}],"version":1}'
        self.statement = {
            "statement_version": 2,
            "catalog_contract_version": 1,
            "source_revision": "a" * 40,
            "builder": "iammufc-private-public-catalog",
            "builder_version": 2,
            "artifact_sha256": hashlib.sha256(self.catalog).hexdigest(),
            "metric_count": 1,
            "coverage_count": 1,
            "validation_passed": True,
            "producer_run_id": 1234,
            "producer_run_attempt": 2,
            "producer_artifact_id": 7624,
        }
        self.artifact = {
            "id": 7624,
            "name": "iammufc-public-catalog-1234-2",
            "expired": False,
            "workflow_run": {"id": 1234, "head_branch": "main", "head_sha": "a" * 40},
        }

    def test_outputs_accepts_exact_v2_and_rejects_legacy_v1_statements(self):
        self.assertEqual(VERIFY.parse_statement_outputs(self.statement)["version"], "2")
        legacy = {
            key: value for key, value in self.statement.items()
            if key not in {"producer_run_id", "producer_run_attempt", "producer_artifact_id"}
        }
        legacy["statement_version"] = legacy["builder_version"] = 1
        with self.assertRaises(ValueError):
            VERIFY.parse_statement_outputs(legacy)

    def test_outputs_rejects_unknown_or_injectable_values(self):
        for mutation in (
            {"statement_version": 3},
            {"source_revision": "a" * 40 + "\nversion=1"},
            {"producer_run_id": "1234\nversion=1"},
            {"private_field": "unexpected"},
        ):
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    VERIFY.parse_statement_outputs({**self.statement, **mutation})

    def test_accepts_successful_fixed_main_workflow(self):
        VERIFY.verify_run(self.run, self.env)

    def test_rejects_run_identity_or_trust_boundary_mismatch(self):
        for key, value in (
            ("id", 8),
            ("run_attempt", 1),
            ("head_sha", "b" * 40),
            ("workflow_id", 8),
            ("path", ".github/workflows/other.yml@refs/heads/main"),
            ("head_branch", "pull/42/merge"),
            ("event", "pull_request"),
            ("status", "in_progress"),
            ("conclusion", "failure"),
        ):
            with self.subTest(key=key):
                run = {**self.run, key: value}
                with self.assertRaises(ValueError):
                    VERIFY.verify_run(run, self.env)

    def test_accepts_exact_artifact_bound_to_current_run_attempt(self):
        VERIFY.verify_artifact_metadata(self.artifact, self.env)

    def test_rejects_artifact_from_another_run_attempt_or_commit(self):
        for key, value in (
            ("id", 8),
            ("name", "iammufc-public-catalog-1234-1"),
            ("expired", True),
            ("workflow_run", {"id": 8, "head_branch": "main", "head_sha": "a" * 40}),
            ("workflow_run", {"id": 1234, "head_branch": "feature", "head_sha": "a" * 40}),
            ("workflow_run", {"id": 1234, "head_branch": "main", "head_sha": "b" * 40}),
        ):
            with self.subTest(key=key, value=value):
                artifact = {**self.artifact, key: value}
                with self.assertRaises(ValueError):
                    VERIFY.verify_artifact_metadata(artifact, self.env)

    def test_accepts_exact_catalog_and_statement(self):
        VERIFY.verify_catalog(self.statement, self.catalog, self.catalog, "7624")

    def test_rejects_changed_bytes_digest_counts_and_artifact_identity(self):
        mutations = (
            (self.statement, self.catalog + b" ", "7624"),
            ({**self.statement, "artifact_sha256": "0" * 64}, self.catalog, "7624"),
            ({**self.statement, "coverage_count": 2}, self.catalog, "7624"),
            (self.statement, self.catalog, "9"),
            ({**self.statement, "private_field": "forbidden"}, self.catalog, "7624"),
        )
        for statement, actual, artifact_id in mutations:
            with self.subTest(statement=statement, artifact_id=artifact_id):
                with self.assertRaises(ValueError):
                    VERIFY.verify_catalog(statement, actual, self.catalog, artifact_id)


if __name__ == "__main__":
    unittest.main()
