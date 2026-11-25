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
        if g.get("encoding") == "delta-gzip":
            continue  # the flight's nested grids (plan 03); lib.heights serves the raw ones only
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


# ---- the drive's patches (build_terrain.py "patches", the dam's around US-93 in Black Canyon)

def test_the_dam_patch_is_listed_and_loaded(lv):
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())["lv"]["terrain"]["patches"]
    assert list(lv.patches) == [p["id"] for p in cfg] == ["dam"]
    dam = lv.grid("dam")
    c = cfg[0]
    assert dam.extents == (c["x0"], c["y0"], c["x1"], c["y1"]) and dam.step == c["step"]
    wide = lv.grid("wide")
    assert (dam.x0 - wide.x0) % wide.step == 0 and (dam.y1 - wide.y0) % wide.step == 0
    assert [g.name for g in lv.layers] == ["near", "dam", "far", "wide"]
    assert "dam" not in lv.meta["grids"]  # the map reads grids only


def test_height_at_takes_the_finest_covering_grid(lv):
    dam, wide = lv.grid("dam"), lv.grid("wide")
    rng = np.random.default_rng(8)
    x = rng.uniform(dam.x0 - 1500, dam.x1 + 3000, 4000)  # the far grid ends 1.5 km west of the patch
    y = rng.uniform(dam.y0 - 3000, dam.y1 + 3000, 4000)
    inside = dam.contains(x, y)
    got = lv.height_at(x, y)
    assert np.array_equal(got[inside], dam.sample(x[inside], y[inside]))
    assert np.array_equal(got[~inside], wide.sample(x[~inside], y[~inside]))
    plain = load_heights("lv", patches=False)
    assert np.array_equal(plain.height_at(x[~inside], y[~inside]), got[~inside])
    assert not plain.patches and plain.grid("dam") is None


def test_continuous_at_the_patch_edge(lv):
    dam = lv.grid("dam")
    f = np.linspace(0.003, 0.997, 600)
    xs, ys = dam.x0 + f * (dam.x1 - dam.x0), dam.y0 + f * (dam.y1 - dam.y0)
    e = 0.01
    pairs = [((dam.x0 - e, ys), (dam.x0 + e, ys)), ((dam.x1 + e, ys), (dam.x1 - e, ys)),
             ((xs, dam.y0 - e), (xs, dam.y0 + e)), ((xs, dam.y1 + e), (xs, dam.y1 - e))]
    worst = max(float(np.abs(lv.height_at(*a) - lv.height_at(*b)).max()) for a, b in pairs)
    assert worst < 0.1  # decimetre rounding of the eased edge posts; the skirt hangs 6 m


def test_the_patch_shows_the_canyon(lv):
    # across Black Canyon under the bypass bridge: a flat river floor about 220 m up between walls that rise
    # over 200 m within 300 m of it, where the wide grid's posts give a shallow vee
    dam, wide = lv.grid("dam"), lv.grid("wide")
    xs = np.arange(38300.0, 39400.0, 20.0)
    ys = np.full_like(xs, -11300.0)
    d, w = dam.sample(xs, ys), wide.sample(xs, ys)
    k = int(np.argmin(d))
    assert d.min() < 222
    assert float(np.mean(w[k - 7:k + 8] - d[k - 7:k + 8])) > 30  # the 300 m about the river: the wide vee stands well above
    assert d[max(k - 15, 0)] - d.min() > 200 and d[min(k + 15, len(d) - 1)] - d.min() > 200
    floor = np.sum(d < d.min() + 3) * 20.0
    assert floor >= 60  # the river is a floor, not a vee


def test_drawn_surface_cuts_the_wide_grid_under_the_patch(lv):
    from lib.ground import _DrawnGrid, cut_cells, drawn_surface

    dam, wide = lv.grid("dam"), lv.grid("wide")
    cut = cut_cells(wide, dam)
    assert cut.sum() == ((dam.x1 - dam.x0) // wide.step) * ((dam.y1 - dam.y0) // wide.step)
    top = drawn_surface(lv)
    rng = np.random.default_rng(9)
    x = rng.uniform(dam.x0 + 1, dam.x1 - 1, 3000)
    y = rng.uniform(dam.y0 + 1, dam.y1 - 1, 3000)
    patch_tris = _DrawnGrid(dam, None).sample(x, y)
    assert np.array_equal(top(x, y), patch_tris)  # inside the patch only the patch is drawn
    # outside it, the same as without the patch
    plain = drawn_surface(load_heights("lv", patches=False))
    x = rng.uniform(dam.x0 - 4000, dam.x0 - 1, 1000)
    y = rng.uniform(dam.y0, dam.y1, 1000)
    assert np.array_equal(top(x, y), plain(x, y))


def test_patch_water(lv):
    meta = lv.meta["patches"]["dam"]
    doc = json.loads((ROOT / "public" / "data" / "lv" / meta["water"]).read_text())
    by = {b["name"]: b for b in doc["bodies"]}
    assert 330 < by["Lake Mead"]["level"] < 380 and 185 < by["Lake Mohave"]["level"] < 210
    dam = lv.grid("dam")
    for b in doc["bodies"]:
        pts = np.array([p for r in b["rings"] for p in r])
        assert (pts[:, 0] >= dam.x0 - 0.1).all() and (pts[:, 0] <= dam.x1 + 0.1).all()
        assert (pts[:, 1] >= dam.y0 - 0.1).all() and (pts[:, 1] <= dam.y1 + 0.1).all()
