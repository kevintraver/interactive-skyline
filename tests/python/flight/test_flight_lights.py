"""The region's town lights for the flight (plan 03, F6.4; scripts/lib/flight_lights.py, scripts/build_flight_lights.py).

The library's pure parts on small synthetic inputs, then the built files when they exist: the pack decodes in the
drive's layout, no town lamp stands where the valley's inventory already lights the ground, the towns the plan names
are present, and the file is inside its budget (section 9.2)."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from lib import flight_lights as F

ROOT = Path(__file__).resolve().parents[3]
PUB = ROOT / "public" / "data" / "lv"


# ---------------------------------------------------------------- the grid and the picture
def test_grid_spec_is_centred_and_square():
    g = F.grid_spec(10_000, 500)
    assert g["nx"] == g["ny"] == 40
    assert g["x0"] == g["y0"] == -10_000
    assert F.cell_index(g, [-9_999, 9_999, 10_001], [-9_999, 9_999, 0]).tolist() == [0, 40 * 40 - 1, -1]


def test_sample_picture_is_north_up():
    rgb = np.zeros((2, 2, 3), np.uint8)
    rgb[0, 1] = 255  # north-east pixel
    bbox = (-1.0, -1.0, 1.0, 1.0)
    out = F.sample_picture(rgb, bbox, np.array([0.5, -0.5, 5.0]), np.array([0.5, 0.5, 0.0]))
    assert out[:, 0].tolist() == [255, 0, 0]


def test_light_level_runs_from_background_to_saturation():
    lv = F.light_level(np.array([[F.BACKGROUND_RED, 0, 0], [255, 255, 255], [10, 10, 40]]))
    assert lv.tolist() == [0.0, 1.0, 0.0]


# ---------------------------------------------------------------- where
def test_covered_mask_marks_cells_near_inventory_lamps():
    g = F.grid_spec(2_000, 500)
    m = F.covered_mask(g, np.array([[-1_750.0, -1_750.0]]), 400)
    assert m[0, 0] and m.sum() == 1


def test_clusters_are_eight_connected_and_largest_first():
    m = np.zeros((6, 6), bool)
    m[0, 0] = m[1, 1] = True          # diagonal neighbours: one cluster of two
    m[4, 3:6] = True                  # three in a row
    out = F.clusters(m)
    assert [len(c["cells"]) for c in out] == [3, 2]
    assert out[0]["bbox"] == (4, 3, 4, 5)
    assert [len(c["cells"]) for c in F.clusters(m, min_cells=3)] == [3]


def test_lit_mask_agreement():
    a = F.lit_mask_agreement(np.array([True, True, False, False]), np.array([True, False, True, False]))
    assert a == {"recall": 0.5, "precision": 0.5}


# ---------------------------------------------------------------- how much
def test_lumens_per_person():
    assert F.lumens_per_person(2.0e9, 2.0e6) == 1000
    with pytest.raises(ValueError):
        F.lumens_per_person(1.0, 0)


def test_place_people_counts_places_near_the_cluster_only():
    places = [{"x": 0, "y": 0, "population": 100}, {"x": 5_000, "y": 0, "population": 50}]
    total, taken = F.place_people(places, np.array([[100.0, 0.0]]), 2_000)
    assert total == 100 and len(taken) == 1


def test_fit_to_target_thins_in_a_fixed_order_and_keeps_light_within_target():
    lm = np.full(100, 10_000.0)
    ids = list(range(100))
    keep, scale = F.fit_to_target(lm, 305_000, ids, seed=7)
    assert scale == 1.0 and keep.sum() == 30 and lm[keep].sum() <= 305_000
    keep2, _ = F.fit_to_target(lm, 305_000, ids, seed=7)
    assert (keep == keep2).all()  # deterministic
    keep3, _ = F.fit_to_target(lm, 505_000, ids, seed=7)
    assert (keep3 | ~keep).all()  # a larger target keeps a superset: no lamp swaps places as the target grows


def test_fit_to_target_brightens_too_few_lamps_up_to_a_limit():
    keep, scale = F.fit_to_target(np.full(10, 1000.0), 20_000, list(range(10)), seed=1)
    assert keep.all() and scale == 2.0
    _, capped = F.fit_to_target(np.full(10, 1000.0), 1e9, list(range(10)), seed=1)
    assert capped == 3.0


def test_cell_points_keep_the_target_and_follow_the_brightness():
    cxy = np.array([[250.0, 250.0], [750.0, 250.0], [5250.0, 250.0]])
    level = np.array([1.0, 1.0, 0.5])
    xy, lm = F.cell_points(cxy, level, 500.0, 100_000.0, seed="s", block=2, lumens_each=8000.0, max_per_block=4)
    assert math.isclose(lm.sum(), 100_000.0, rel_tol=1e-9)
    # the first two cells share a 1 km block (weight 2), the third is alone (weight 0.5): 80 % and 20 % of the light
    left = xy[:, 0] < 1000
    assert math.isclose(lm[left].sum(), 80_000.0, rel_tol=1e-9)
    assert left.sum() == 4 and (~left).sum() == 3  # capped at 4 a block; 20,000 lm is 2.5 points, rounded to 3
    # every point lies in one of its block's lit cells
    for p in xy:
        assert np.min(np.max(np.abs(cxy - p), axis=1)) <= 250.0
    xy2, lm2 = F.cell_points(cxy, level, 500.0, 100_000.0, seed="s", block=2, lumens_each=8000.0, max_per_block=4)
    assert (xy2 == xy).all() and (lm2 == lm).all()


# ---------------------------------------------------------------- the file
def test_pack_round_trip_in_the_drive_layout():
    rng = np.random.default_rng(3)
    n = 500
    x = rng.uniform(-20_000, 20_000, n)
    y = rng.uniform(-20_000, 20_000, n)
    mount = np.full(n, 9.14)
    t = rng.integers(0, 3, n)
    lm = rng.uniform(3_000, 30_000, n)
    data, meta, idx = F.encode_pack(x, y, mount, t, np.ones(n, bool), lm, (-20_480, -20_480, 20_480, 20_480), cell=4096, q=16)
    assert meta["bytes"] == len(data) and meta["count"] == n
    for d in meta["arrays"]:
        assert d["offset"] % 4 == 0
    dec = F.decode_pack(meta, data)
    assert np.allclose(dec["x"], x[idx], atol=1 / 16) and np.allclose(dec["y"], y[idx], atol=1 / 16)
    assert np.allclose(dec["lumens"], lm[idx], atol=5.01)
    assert (dec["type"] == t[idx]).all() and dec["rule"].all()
    # every lamp lies inside the cell that lists it
    for c, i0, k in F.pack_cell_runs(meta, data):
        cx, cy = c % meta["nx"], c // meta["nx"]
        xs, ys = dec["x"][i0:i0 + k], dec["y"][i0:i0 + k]
        assert (xs >= meta["x0"] + cx * 4096).all() and (xs < meta["x0"] + (cx + 1) * 4096).all()
        assert (ys >= meta["y0"] + cy * 4096).all() and (ys < meta["y0"] + (cy + 1) * 4096).all()


def test_pack_orders_a_cell_by_hash_not_by_position():
    # the flight draws a thinned cell's first lamps: a cell sorted by position would thin to one corner
    x = np.linspace(10, 4000, 200)
    data, meta, idx = F.encode_pack(x, np.full(200, 10.0), np.full(200, 9.0), np.zeros(200, int), np.ones(200, bool),
                                    np.full(200, 5000.0), (0, 0, 4096, 4096), cell=4096, q=16)
    dec = F.decode_pack(meta, data)
    first = dec["x"][:20]
    assert first.max() - first.min() > 2000


def test_pack_rejects_a_quantum_that_does_not_fit():
    with pytest.raises(ValueError):
        F.encode_pack([0], [0], [9], [0], [True], [1000], (0, 0, 8192, 8192), cell=8192, q=16)


# ---------------------------------------------------------------- the built files
built = pytest.mark.skipif(not (PUB / "lights-region.json").exists(), reason="lights-region not built")


@built
def test_built_region_pack_decodes_and_is_inside_its_budget():
    meta = json.loads((PUB / "lights-region.json").read_text())
    data = (PUB / meta["file"]).read_bytes()
    dec = F.decode_pack(meta, data)
    assert meta["count"] == len(dec["x"]) > 1000
    assert len(data) < 1.6e6  # section 9.2: lamps-air.bin, 1.6 MB, of which the valley's are the drive's own file
    assert meta["sources"] and all(s.get("licence") and s.get("retrieved") for s in meta["sources"])


@built
def test_built_towns_named_by_the_plan_are_present_and_outside_the_inventory():
    meta = json.loads((PUB / "lights-region.json").read_text())
    data = (PUB / meta["file"]).read_bytes()
    dec = F.decode_pack(meta, data)
    frame = meta["frame"]
    towns = {t["name"]: t for t in meta["towns"]}
    for name in ("Mesquite", "Pahrump", "St. George"):
        t = next((v for k, v in towns.items() if k.startswith(name)), None)
        assert t is not None, f"{name} missing"
        assert t["lamps"] > 100, name
        # its lamps are where the town is: within 15 km of its place node
        d = np.hypot(dec["x"] - t["x"], dec["y"] - t["y"])
        assert (d < 15_000).sum() >= 0.8 * t["lamps"], name
    # no town lamp within the radius of the inventory's own lamps
    inv = json.loads((PUB / "lamps-drive.json").read_text())
    assert frame == "public/data/lv/terrain.json"
    from scipy.spatial import cKDTree
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    from build_flight_lights import inventory_xy  # noqa: E402
    xy = inventory_xy(inv, (PUB / inv["file"]).read_bytes())
    d, _ = cKDTree(xy).query(np.column_stack([dec["x"], dec["y"]]), k=1)
    assert (d > meta["coverRadiusM"] * 0.5).all()


@built
def test_built_town_light_follows_the_valley_calibration():
    meta = json.loads((PUB / "lights-region.json").read_text())
    k = meta["calibration"]["lumensPerPerson"]
    assert 200 < k < 5000  # the valley's: about 1,100 lm a person (2.5e9 lm over about 2.3 million people)
    for t in meta["towns"]:
        if t["people"] > 0:
            # the rule's lamps thinned to the town's people (whole lamps: short of it by less than one lamp's lumens,
            # 40,000 at most), or brightened at most 3x
            assert t["lumens"] <= k * t["people"] * 1.0001 + 1
            assert t["lumens"] >= min(k * t["people"], t["ruleLumens"] * 3) - 40_000
