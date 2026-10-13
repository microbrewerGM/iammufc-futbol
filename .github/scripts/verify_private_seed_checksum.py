"""Check the private seed sidecar without logging SQL or digest contents."""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path


def verify_checksum(seed: bytes, sidecar: bytes) -> None:
    if not seed:
        raise ValueError("private seed is empty")
    try:
        sidecar_text = sidecar.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValueError("private seed checksum sidecar is invalid") from exc
    match = re.fullmatch(r"([0-9a-f]{64})  0002_seed\.sql\n", sidecar_text)
    if match is None or hashlib.sha256(seed).hexdigest() != match.group(1):
        raise ValueError("private seed checksum verification failed")


def main() -> int:
    try:
        seed = Path("private-seed/0002_seed.sql").read_bytes()
        sidecar = Path("private-seed/0002_seed.sql.sha256").read_bytes()
        verify_checksum(seed, sidecar)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("private seed checksum verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
