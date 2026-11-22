import json
from pathlib import Path

import numpy as np
import pytest

from lib.heights import load_heights

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "heights-lv.json").read_text())


@pytest.fixture(scope="module")
def lv():
    return load_heights("lv")


def ref_sample(g, x, y):
    """heightField().sample in main.js, one point at a time in plain Python floats."""
    fx = max(0, min(g["nx"] - 1.001, (x - g["x0"]) / g["step"]))
    fy = max(0, min(g["ny"] - 1.001, (y - g["y0"]) / g["step"]))
    i, j = int(np.floor(fx)), int(np.floor(fy))
    ax, ay = fx - i, fy - j
    raw = g["raw"]
    at = lambda i, j: int(raw[j * g["nx"] + i]) * g["scale"]  # noqa: E731
    lerp = lambda a, b, t: (1 - t) * a + t * b  # noqa: E731
    return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay)


def test_grids_and_extents(lv):
    assert list(lv.grids) == ["near", "far", "wide"]
    assert lv.extents["far"] == (-48000, -34000, 30000, 38000)
    assert lv.extents["wide"] == (-56000, -64000, 48000, 48000)
    assert lv.base == 620


def test_sample_is_main_js_arithmetic(lv):
    rng = np.random.default_rng(3)
    folder = ROOT / "public" / "data" / "lv"
    for name, g in lv.meta["grids"].items():
        ref = dict(g, raw=np.fromfile(folder / g["file"], dtype="<u2"))
        grid = lv.grid(name)
        x = rng.uniform(grid.x0 - 300, grid.x1 + 300, 300)
        y = rng.uniform(grid.y0 - 300, grid.y1 + 300, 300)
        got = grid.sample(x, y)
        assert all(got[k] == ref_sample(ref, float(x[k]), float(y[k])) for k in range(len(x)))


def test_falls_through_near_far_wide(lv):
    near, far, wide = lv.grid("near"), lv.grid("far"), lv.grid("wide")
    pts = {"near": (100.0, 200.0), "far": (-20000.0, 10000.0), "wide": (-19534.0, -55912.0)}
    for name, (x, y) in pts.items():
        assert lv.height_at(x, y) == lv.grid(name).sample(x, y)
    assert near.contains(*pts["near"]) and not near.contains(*pts["far"])
    assert far.contains(*pts["far"]) and not far.contains(*pts["wide"])
    assert lv.height_at(-20000, -80000) == wide.sample(-20000, -80000)  # clamped edge beyond every grid
    xs, ys = zip(*pts.values())
    assert np.array_equal(lv.height_at(np.array(xs), np.array(ys)), [lv.height_at(x, y) for x, y in pts.values()])


def test_ground_y(lv):
    x, y = -19534.0, -55912.0
    assert lv.ground_y(x, y) == lv.height_at(x, y) - 620 - (x * x + y * y) / (2 * 6371000 * (7 / 6))


def test_matches_the_fixture(lv):
    # the fixture is written by this module, so this only catches a change to the data or the code
    x = np.array([p["x"] for p in FIXTURE["points"]])
    y = np.array([p["y"] for p in FIXTURE["points"]])
    assert np.array_equal(lv.height_at(x, y), [p["height"] for p in FIXTURE["points"]])
    assert np.array_equal(lv.ground_y(x, y), [p["groundY"] for p in FIXTURE["points"]])


def test_wide_agrees_with_far_where_they_overlap(lv):
    # same source tiles, coarser posts: tens of metres at most on steep ground, a few on the valley floor
    rng = np.random.default_rng(5)
    x = rng.uniform(-47000, 29000, 2000)
    y = rng.uniform(-33000, 37000, 2000)
    d = np.abs(lv.grid("wide").sample(x, y) - lv.grid("far").sample(x, y))
    assert np.median(d) < 3
    assert np.percentile(d, 99) < 60


def test_slc_has_no_wide_grid():
    slc = load_heights("slc")
    assert list(slc.grids) == ["near", "far"]
    x, y = 0.0, -60000.0
    assert slc.height_at(x, y) == slc.grid("far").sample(x, y)
