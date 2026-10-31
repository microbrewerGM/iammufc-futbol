from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_committed_catalog_release_is_v2_and_matches_catalog_digest():
    release = json.loads((ROOT / "worker/src/generated/catalog-release.json").read_text(encoding="utf-8"))
    catalog = (ROOT / "worker/src/generated/catalog.json").read_bytes()

    assert release["statement_version"] == 2
    assert release["artifact_sha256"] == hashlib.sha256(catalog).hexdigest()
