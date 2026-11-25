"""make_beam.py (plan 02, D5.1): the headlamp maps meet FMVSS 108 at every test point, the written files match
what the script builds, and the shapes are physically sensible."""
import json
from pathlib import Path

import numpy as np
import pytest

import make_beam as B

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "drive"


@pytest.fixture(scope="module")
def maps():
    low, low_info = B.build(B.low_beam, B.LOW_POINTS, "low")
    high, high_info = B.build(B.high_beam, B.HIGH_POINTS, "high")
    return {"low": (low, low_info), "high": (high, high_info)}


@pytest.mark.parametrize("which", ["low", "high"])
def test_every_test_point_inside_limits(maps, which):
    g, info = maps[which]
    rows = B.check(g.astype(np.float64), B.LOW_POINTS if which == "low" else B.HIGH_POINTS)
    assert rows and all(r["ok"] for r in rows), [r for r in rows if not r["ok"]]
    assert info["failures"] == []


@pytest.mark.parametrize("which", ["low", "high"])
def test_lobes_meet_the_limits_without_clamping(maps, which):
    # the clamp is a guard; the shape itself should already be legal
    assert maps[which][1]["clampedNodes"] == 0


def test_low_beam_shape(maps):
    g = maps["low"][0].astype(np.float64)
    peak = maps["low"][1]["peakAt"]
    assert peak["vDeg"] < 0 and peak["hDeg"] > 0  # hot spot below and right of the axis
    # the cutoff: at least 10x drop from 1 deg below to 1 deg above, at 2R
    assert B.sample(g, 2, -1) > 10 * B.sample(g, 2, 1)
    # kerb side brighter than the oncoming side above the horizon (sign lighting vs glare)
    assert B.sample(g, 3, 0.5) > B.sample(g, -3, 0.5)


def test_high_beam_shape(maps):
    info = maps["high"][1]
    assert info["peakAt"] == {"hDeg": 0.0, "vDeg": 0.0}
    assert 40000 <= info["peakCd"] <= min(75000, B.FLOAT16_MAX)


def test_written_files_match_the_build(maps):
    meta = json.loads((OUT / "beam.json").read_text())
    gr = meta["grid"]
    assert (gr["nh"], gr["nv"]) == (B.NH, B.NV)
    for which in ("low", "high"):
        raw = np.frombuffer((OUT / meta["files"][which]).read_bytes(), dtype="<f2").reshape(gr["nv"], gr["nh"])
        assert np.array_equal(raw, maps[which][0])
        assert meta[which]["peakCd"] == float(raw.max())
    assert "could not be fetched" in meta["sources"]["shape"]


def test_sample_is_bilinear_and_clamped():
    g = np.arange(B.NV * B.NH, dtype=np.float64).reshape(B.NV, B.NH)
    assert B.sample(g, B.H0, B.V0) == 0
    assert B.sample(g, B.H0 + B.DH / 2, B.V0) == 0.5
    assert B.sample(g, B.H0, B.V0 + B.DV / 2) == B.NH / 2
    assert B.sample(g, 1e3, 1e3) == g[-1, -1]
