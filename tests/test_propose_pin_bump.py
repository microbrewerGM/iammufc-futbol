"""Test the actual file-edit regexes against real file content, in a tmp copy.

Never touches the real package.json / pyproject.toml. propose_pin_bump.py's
apply_action() is not covered here -- it hits the network to resolve a tag to
a SHA and is exercised as part of the pin_check.py dry-run instead, which
already proved the surrounding logic against live data.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github" / "scripts"))

from propose_pin_bump import apply_npm, apply_python  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_apply_npm_bumps_only_the_named_package(tmp_path):
    src = REPO_ROOT / "package.json"
    dst = tmp_path / "package.json"
    shutil.copy(src, dst)
    before = json.loads(dst.read_text())

    apply_npm("hono", "9.9.9", path=dst)

    after = json.loads(dst.read_text())
    assert after["dependencies"]["hono"] == "9.9.9"
    # Nothing else in the file moved -- ADR-0004 is "one pin site per PR",
    # which only means anything if the edit is actually surgical.
    for section in ("devDependencies",):
        assert after[section] == before[section]


def test_apply_npm_missing_package_raises_rather_than_silently_noop():
    dst_text = '{"dependencies": {"hono": "1.0.0"}}'
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "package.json"
        p.write_text(dst_text)
        try:
            apply_npm("does-not-exist", "9.9.9", path=p)
            assert False, "expected a RuntimeError"
        except RuntimeError as e:
            assert "does-not-exist" in str(e)


def test_apply_python_bumps_only_the_named_package(tmp_path):
    src = REPO_ROOT / "pyproject.toml"
    dst = tmp_path / "pyproject.toml"
    shutil.copy(src, dst)
    before = dst.read_text()

    apply_python("pydantic", "9.9.9", path=dst)

    after = dst.read_text()
    assert "pydantic==9.9.9" in after
    assert "pydantic==2.12.5" not in after
    # Every other pinned version in the file is untouched.
    before_lines = {line for line in before.splitlines() if "==" in line and "pydantic" not in line}
    after_lines = {line for line in after.splitlines() if "==" in line and "pydantic" not in line}
    assert before_lines == after_lines


def test_apply_python_preserves_extras_syntax(tmp_path):
    dst = tmp_path / "pyproject.toml"
    dst.write_text('dependencies = [\n    "pandera[pandas]==0.31.1",\n]\n')

    apply_python("pandera", "0.32.0", path=dst)

    text = dst.read_text()
    assert 'pandera[pandas]==0.32.0' in text
