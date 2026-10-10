from __future__ import annotations

import hashlib
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / ".github" / "scripts"


def load_script(name):
    spec = spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load_script("verify_private_seed_run")
CHECKSUM = load_script("verify_private_seed_checksum")


class PrivateSeedRunTests(unittest.TestCase):
    def setUp(self):
        self.run = {
            "id": 1234,
            "run_attempt": 2,
            "head_sha": "a" * 40,
            "workflow_id": 987,
            "status": "completed",
            "conclusion": "success",
            "head_branch": "main",
        }
        self.expected = {
            "run_id": "1234",
            "attempt": "2",
            "commit": "a" * 40,
            "workflow_id": "987",
            "artifact_id": "7624",
        }

    def test_accepts_exact_successful_main_producer_run(self):
        VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_failed_run(self):
        self.run["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "does not match"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_non_main_run(self):
        self.run["head_branch"] = "pull/42/merge"
        with self.assertRaisesRegex(ValueError, "does not match"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_attempt_mismatch(self):
        self.run["run_attempt"] = 1
        with self.assertRaisesRegex(ValueError, "does not match"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_commit_mismatch(self):
        self.run["head_sha"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "does not match"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_other_workflow(self):
        self.run["workflow_id"] = 444
        with self.assertRaisesRegex(ValueError, "does not match"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_rejects_invalid_artifact_id(self):
        self.expected["artifact_id"] = "7624/other"
        with self.assertRaisesRegex(ValueError, "invalid private artifact"):
            VERIFY.verify_run(self.run, **self.expected)

    def test_accepts_matching_seed_checksum(self):
        seed = b"synthetic seed contents"
        sidecar = f"{hashlib.sha256(seed).hexdigest()}  0002_seed.sql\n".encode()
        CHECKSUM.verify_checksum(seed, sidecar)

    def test_rejects_seed_checksum_mismatch(self):
        seed = b"changed synthetic seed contents"
        sidecar = f"{'a' * 64}  0002_seed.sql\n".encode()
        with self.assertRaisesRegex(ValueError, "checksum verification failed"):
            CHECKSUM.verify_checksum(seed, sidecar)

    def test_rejects_sidecar_path_injection(self):
        seed = b"synthetic seed contents"
        digest = hashlib.sha256(seed).hexdigest()
        sidecar = f"{digest}  ../../public.sql\n".encode()
        with self.assertRaisesRegex(ValueError, "checksum verification failed"):
            CHECKSUM.verify_checksum(seed, sidecar)


if __name__ == "__main__":
    unittest.main()
