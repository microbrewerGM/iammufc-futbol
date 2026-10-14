"""Check the private seed sidecar without logging SQL or digest contents."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path


_SHA256 = re.compile(r"[0-9a-f]{64}")


def _closed_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("private seed manifest is invalid")
        result[key] = value
    return result


def parse_manifest(manifest: bytes) -> tuple[str, str]:
    """Return the snapshot and seed digests from the exact v1 manifest shape."""
    try:
        value = json.loads(manifest.decode("utf-8"), object_pairs_hook=_closed_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("private seed manifest is invalid") from exc
    if (not isinstance(value, dict) or set(value) != {"schema_version", "snapshot_id", "seed_sha256"} or
            type(value["schema_version"]) is not int or value["schema_version"] != 1 or
            not isinstance(value["snapshot_id"], str) or not _SHA256.fullmatch(value["snapshot_id"]) or
            not isinstance(value["seed_sha256"], str) or not _SHA256.fullmatch(value["seed_sha256"])):
        raise ValueError("private seed manifest is invalid")
    return value["snapshot_id"], value["seed_sha256"]


def verify_checksum(seed: bytes, sidecar: bytes, manifest: bytes) -> str:
    if not seed:
        raise ValueError("private seed is empty")
    try:
        sidecar_text = sidecar.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValueError("private seed checksum sidecar is invalid") from exc
    match = re.fullmatch(r"([0-9a-f]{64})  0002_seed\.sql\n", sidecar_text)
    snapshot_id, manifest_digest = parse_manifest(manifest)
    actual_digest = hashlib.sha256(seed).hexdigest()
    if match is None or actual_digest != match.group(1) or actual_digest != manifest_digest:
        raise ValueError("private seed checksum verification failed")
    return snapshot_id


def main() -> int:
    try:
        seed = Path("private-seed/0002_seed.sql").read_bytes()
        sidecar = Path("private-seed/0002_seed.sql.sha256").read_bytes()
        manifest = Path("private-seed/0002_seed.manifest.json").read_bytes()
        snapshot_id = verify_checksum(seed, sidecar, manifest)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        # The ID is needed only by later steps in this job. Register it with the
        # runner's masking facility before making it an internal step output.
        print(f"::add-mask::{snapshot_id}")
        with Path(output_path).open("a", encoding="utf-8") as output:
            output.write(f"snapshot_id={snapshot_id}\n")
    print("private seed checksum verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
