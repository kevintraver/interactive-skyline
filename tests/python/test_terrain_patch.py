"""The dam patch and US-93 over it: the carve (scripts/lib/carve.py) and the road build's numbers in Black Canyon."""
import json
from pathlib import Path

import numpy as np
import pytest
from scipy.spatial import cKDTree

from lib.carve import DROP, GRADE, bench_width, carve, design_profile
from lib.heights import load_heights
from lib.roadnet import decode_roadnet

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "public" / "data" / "lv"


def test_design_profile_cuts_a_ridge_within_the_grade():
    s = np.arange(0, 2000, 4.0)
    g = 500 + 40 * np.exp(-(((s - 1000) / 120) ** 2))  # a 40 m ridge across flat ground
    z = design_profile(g, np.ones_like(g), 4.0)
    assert np.abs(np.diff(z)).max() <= GRADE * 4 + 1e-6
    assert z[250] < g[250] - 10  # through the ridge in a cut
    assert np.abs(z[:50] - 500).max() < 0.01 and np.abs(z[-50:] - 500).max() < 0.01  # on the flat ground either side


def test_design_profile_follows_a_reference():
    s = np.arange(0, 1000, 4.0)
    g = 500 + 0.03 * s
    ref = g + 3.0
    z = design_profile(g, np.ones_like(g), 4.0, ref=ref, ref_weight=np.full_like(g, 8.0))
    assert np.abs(z - ref).max() < 0.01  # filling 3 m costs less than leaving the other carriageway


def test_carve_lowers_the_ground_under_the_road_only():
    step = 20
    nx, ny = 101, 61
    gx, gy = np.meshgrid(np.arange(nx) * step, np.arange(ny) * step)
    h = 500 + 40 * np.exp(-(((gx - 1000) / 150) ** 2))  # a ridge running north-south
    s = np.arange(0, 2000, 4.0)
    road = {"id": "r", "s": s, "x": s, "y": np.full_like(s, 600.0), "heading": np.zeros_like(s),
            "left": np.full_like(s, 8.0), "right": np.full_like(s, -8.0), "bridge": np.zeros(len(s), bool), "spacing": 4.0}
    out, rep = carve(h, {"x0": 0, "y0": 0, "step": step, "nx": nx, "ny": ny}, [road])
    assert rep["r"]["posts_lowered"] > 0
    assert np.all(out <= h)
    j = 30  # the road's row
    assert out[j, 50] < h[j, 50] - 10  # the ridge is cut where the road crosses it
    far = np.abs(gy - 600) > 8 + bench_width(step) + 60 / 1.5 + step
    assert np.array_equal(out[far], h[far])  # nothing beyond the cut faces moves
    # the bench is at the design line less DROP
    z = design_profile(500 + 40 * np.exp(-(((s - 1000) / 150) ** 2)), np.ones_like(s), 4.0)
    assert out[j, 50] == pytest.approx(z[250] - DROP, abs=0.5)


@pytest.fixture(scope="module")
def us93():
    doc = json.loads((DATA / "roadnet-us93.json").read_text())
    return {r["id"]: r for r in decode_roadnet(doc, (DATA / "roadnet-us93.bin").read_bytes())}


def test_us93_rides_the_canyon_not_a_causeway(us93):
    hs = load_heights("lv")
    r = us93["us93.main"]
    s = np.arange(r["count"]) * r["spacing"]
    deck = np.zeros(r["count"], bool)
    for b in r["bridges"]:
        if b.get("deck"):
            deck |= (s >= b["s0"]) & (s <= b["s1"])
    m = (s <= 8000) & ~deck
    lift = (r["h"] - hs.height_at(r["x"], r["y"]))[m]
    # before the patch: mean 33.8 m, 95th percentile 74 m, 77 % of it more than 10 m up
    assert lift.mean() < 8
    assert np.percentile(lift, 95) < 25
    assert (lift > 10).mean() < 0.25
    # the start is on the bypass bridge's deck, high over the river
    k = s < 100
    assert (r["h"][k] - hs.height_at(r["x"][k], r["y"][k])).max() > 200


def test_us93_carriageways_stay_level_with_each_other(us93):
    m, o = us93["us93.main"], us93["us93s.opp"]
    k = slice(0, 2000)
    _, nn = cKDTree(np.column_stack([o["x"], o["y"]])).query(np.column_stack([m["x"][k], m["y"][k]]))
    dh = np.abs(m["h"][k] - o["h"][nn])
    assert np.median(dh) < 1.5 and dh.max() < 6
