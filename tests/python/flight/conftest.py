"""Fixtures for the flight pipeline's tests (plan 03, F0.3). Everything here runs offline: the NASR rows
are a committed extract, traces are synthesised by fixtures/synth.py in readsb's trace_full layout."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE / "fixtures"))

import synth  # noqa: E402
from lib.frame import create_frame  # noqa: E402


@pytest.fixture(scope="session")
def lv_city():
    return json.loads((ROOT / "data" / "cities.json").read_text())["lv"]


@pytest.fixture(scope="session")
def lv_frame(lv_city):
    return create_frame(lv_city)


@pytest.fixture(scope="session")
def nasr_rows():
    """The LAS rows of the NASR airport CSV bundle (cycle of 2026-10-29), as {file: [row dicts]}."""
    from lib import nasr
    return nasr.read_dir(HERE / "fixtures" / "nasr_las")


@pytest.fixture(scope="session")
def lv_airport(nasr_rows, lv_frame):
    """airport.json's runway part, built from the fixture rows."""
    from build_airport import build_runways
    return build_runways(nasr_rows, "LAS", lv_frame)


@pytest.fixture
def synthetic():
    return synth
