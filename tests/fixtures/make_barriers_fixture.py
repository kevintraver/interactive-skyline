"""Writes tests/fixtures/barriers.json from barriers-input.json with the Python writer.

    uv run --with numpy python tests/fixtures/make_barriers_fixture.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
from lib.roadside_barrier_format import encode_barriers  # noqa: E402

(HERE / "barriers.json").write_text(encode_barriers(json.loads((HERE / "barriers-input.json").read_text())))
