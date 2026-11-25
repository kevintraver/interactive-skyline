"""The served lamp product (scripts/pack_lamps.py, plan 02 D5.4): what goes in comes back, sorted into cells."""
import json
import random
import struct

import pytest

import pack_lamps as pl


def _inventory(n=500, seed=4):
    rnd = random.Random(seed)
    lamps = []
    for i in range(n):
        x = rnd.uniform(-3000, 2500)
        y = rnd.uniform(-2000, 2900)
        aim = None if i % 3 else round(rnd.uniform(0, 359.99), 2)
        flags = (0x10 if i % 17 == 0 else 0) | (1 if i % 5 == 0 else 0) | (1 << 1)
        lamps.append((round(x, 3), round(y, 3), round(rnd.uniform(6, 30), 1), rnd.randrange(8), flags, rnd.randrange(9, 14000) * 10, aim))
    return lamps


REGION = (-2800, -1900, 2400, 2800)


def test_round_trip_keeps_every_lamp_in_the_region():
    lamps = _inventory()
    data, meta = pl.pack(lamps, REGION, {"types": []})
    inside = [l for l in lamps if REGION[0] <= l[0] < REGION[2] and REGION[1] <= l[1] < REGION[3]]
    back = pl.decode(data, meta)
    assert meta["count"] == len(inside) == len(back)
    assert meta["enclosed"] == sum(1 for l in inside if l[4] & 0x10)
    key = lambda l: (round(l[0]), round(l[1]))
    want = sorted(inside, key=key)
    got = sorted(back, key=key)
    for a, b in zip(want, got):
        assert abs(a[0] - b[0]) <= 0.5 / pl.Q + 1e-9 and abs(a[1] - b[1]) <= 0.5 / pl.Q + 1e-9
        assert abs(a[2] - b[2]) <= 0.5 / pl.MOUNT_Q + 1e-9
        assert a[3] == b[3] and a[5] == b[5]
        assert bool(b[4] & pl.ENCLOSED) == bool(a[4] & 0x10)
        assert bool(b[4] & pl.RULE) == bool(a[4] & 1)
        if a[6] is None:
            assert b[6] is None
        else:
            d = (a[6] - b[6] + 180) % 360 - 180
            assert abs(d) <= 0.71


def test_cells_are_row_major_and_lamps_sit_in_their_cell():
    data, meta = pl.pack(_inventory(), REGION, {"types": []})
    arrs = {a["name"]: a for a in meta["arrays"]}
    start = struct.unpack_from(f"<{arrs['cellStart']['length']}I", data, arrs["cellStart"]["offset"])
    assert start[0] == 0 and start[-1] == meta["count"]
    assert all(b >= a for a, b in zip(start, start[1:]))
    back = pl.decode(data, meta)
    for c in range(meta["nx"] * meta["ny"]):
        x0 = meta["x0"] + (c % meta["nx"]) * meta["cell"]
        y0 = meta["y0"] + (c // meta["nx"]) * meta["cell"]
        for lamp in back[start[c]:start[c + 1]]:
            assert x0 <= lamp[0] <= x0 + meta["cell"] and y0 <= lamp[1] <= y0 + meta["cell"]
    for a in meta["arrays"]:
        assert a["offset"] % 4 == 0
    assert meta["bytes"] == len(data)


def test_reads_the_inventory_format(tmp_path):
    rec = struct.pack("<iiHBBHH", -1234567, 765432, 91, 1, 0x13, 950, 0xFFFF) + struct.pack("<iiHBBHH", 10, -20, 305, 2, 0, 2700, 9000)
    p = tmp_path / "lamps.bin"
    p.write_bytes(rec)
    a, b = pl.read_inventory(p)
    assert a == (-1234.567, 765.432, 9.1, 1, 0x13, 9500, None)
    assert b == (0.01, -0.02, 30.5, 2, 0, 27000, 90.0)


def test_the_served_product_is_current_and_small():
    meta_path = pl.ROOT / "public" / "data" / "lv" / "lamps-drive.json"
    if not meta_path.exists():
        return
    meta = json.loads(meta_path.read_text())
    data = (pl.ROOT / "public" / "data" / "lv" / "lamps-drive.bin").read_bytes()
    assert meta["version"] == pl.VERSION and meta["bytes"] == len(data)
    assert meta["lampTypes"]["types"], "the lamp types are embedded"
    import gzip
    assert len(gzip.compress(data, 6)) < 1_500_000


# ---------------------------------------------------------------- off the pavement (clear_pavement)

def _road(rid, x0, y0, heading, n=101, lanes=3, bridges=(), h=700.0, cf=0.0, spacing=4.0):
    """A straight road for the tests: stations every `spacing` m from (x0, y0) along `heading`, `lanes` lanes."""
    import math
    import numpy as np
    s = np.arange(n) * spacing
    return {"id": rid, "sections": [{"s0": 0, "s1": float(s[-1]), "lanes": [{} for _ in range(lanes)]}],
            "s": s, "x": x0 + s * math.cos(heading), "y": y0 + s * math.sin(heading),
            "heading": np.full(n, heading), "h": np.full(n, h), "crossfall": np.full(n, cf),
            "spacing": spacing, "bridges": list(bridges)}


def _lamp(x, y, aim=None, mount=12.0, t=1, flags=0):
    return (x, y, mount, t, flags, 20000, aim)


def _edges(road):
    from lib.crosssection import normalise_sections, pavement_edges
    import numpy as np
    left, right = pavement_edges(normalise_sections(road["sections"]), np.array([0.0]))
    return float(left[0]), float(right[0])


def test_a_pole_in_the_carriageway_goes_to_the_nearer_edge_plus_a_metre_and_keeps_its_aim():
    import math
    road = _road("m", 0, 0, 0.0)  # east along y = 0; left (north) positive
    left, right = _edges(road)
    model = pl.pavement_model([road])
    # head at y = left - 1.0 with the arm pointing north: the pole stands 2.4 m south of it, on the pavement, nearer the left edge
    head = (200.0, left - 1.0)
    out, rep = pl.clear_pavement([_lamp(*head, aim=90.0)], model)
    assert rep["moved"] == 1
    x, y, mount, t, flags, lumens, aim, lift = out[0]
    foot = (x - pl.ARM_M * math.cos(math.radians(aim)), y - pl.ARM_M * math.sin(math.radians(aim)))
    assert foot[1] == pytest.approx(left + pl.CLEAR_M, abs=1e-6)
    assert foot[0] == pytest.approx(200.0, abs=1e-6)
    # the arm reaches back toward where the head was: the light stays aimed there
    turn = (math.atan2(head[1] - foot[1], head[0] - foot[0]) - math.radians(aim) + math.pi) % (2 * math.pi) - math.pi
    assert turn == pytest.approx(0, abs=1e-3)
    assert mount == 12.0 and lumens == 20000 and lift == 0.0
    assert not pl.on_pavement(model, *foot)


def test_the_outside_when_it_is_nearer_and_the_other_side_when_the_near_one_is_pavement_too():
    import math
    a = _road("a", 0, 0, 0.0)
    left, right = _edges(a)
    model = pl.pavement_model([a])
    out, _ = pl.clear_pavement([_lamp(150.0, right + 0.5 + pl.ARM_M, aim=90.0)], model)  # pole 0.5 m inside the right edge
    x, y, *_rest = out[0]
    aim = out[0][6]
    assert y - pl.ARM_M * math.sin(math.radians(aim)) == pytest.approx(right - pl.CLEAR_M, abs=1e-6)
    # a second carriageway just beyond the right edge: the near side is pavement, so the pole goes to the left
    b = _road("b", 0, right - 1.5 - left, 0.0)  # its left edge 1.5 m beyond a's right edge
    model2 = pl.pavement_model([a, b])
    out2, rep2 = pl.clear_pavement([_lamp(150.0, right + 0.5 + pl.ARM_M, aim=90.0)], model2)
    x2, y2 = out2[0][0], out2[0][1]
    foot_y = y2 - pl.ARM_M * math.sin(math.radians(out2[0][6]))
    assert not pl.on_pavement(model2, x2 - pl.ARM_M * math.cos(math.radians(out2[0][6])), foot_y)
    assert rep2["moved"] == 1


def test_poles_off_the_pavement_and_enclosed_lamps_stay_as_they_are():
    road = _road("m", 0, 0, 0.0)
    left, _ = _edges(road)
    model = pl.pavement_model([road])
    keep = [None,  # below: a pole 3 m north of the edge, its arm reaching south
            _lamp(100.0, 0.0, flags=0x10),  # enclosed: no pole
            _lamp(5000.0, 5000.0)]  # nowhere near a road
    keep[0] = _lamp(100.0, left + 3.0 - pl.ARM_M, aim=270.0)
    out, rep = pl.clear_pavement(keep, model)
    assert rep["moved"] == 0
    assert out == keep


def test_unknown_aim_puts_the_pole_away_from_the_nearest_road_as_poles_js_does():
    road = _road("m", 0, 0, 0.0)
    left, _ = _edges(road)
    model = pl.pavement_model([road])
    # a head 1 m north of the reference line, aim unknown: the arm points at the nearest station (south), the
    # pole stands north of the head: still on the pavement, so it moves to the left edge
    out, rep = pl.clear_pavement([_lamp(200.0, 1.0)], model)
    assert rep["moved"] == 1
    x, y, *_r = out[0]
    assert out[0][6] is not None  # the moved lamp's aim is now known


def test_a_pole_on_a_crossing_deck_goes_to_the_parapet_and_takes_the_deck_height():
    import math
    deck = _road("x", 0, -200, math.pi / 2, n=101, lanes=2, bridges=[{"s0": 150, "s1": 250, "deck": True}], h=710.0)
    left, right = _edges(deck)
    model = pl.pavement_model([deck])
    # on the deck at s = 200 (y = 0), the pole 0.5 m inside its right edge (the road runs north: lateral = -x),
    # the arm reaching west (aim 180)
    foot0 = (-(right + 0.5), 0.0)
    out, rep = pl.clear_pavement([_lamp(foot0[0] - pl.ARM_M, foot0[1], aim=180.0)], model, ground=lambda x, y: 700.0)
    assert rep["onDecks"] == 1 and rep["moved"] == 1
    x, y, mount, t, flags, lumens, aim, lift = out[0]
    foot = (x - pl.ARM_M * math.cos(math.radians(aim)), y - pl.ARM_M * math.sin(math.radians(aim)))
    assert -foot[0] == pytest.approx(right - pl.PARAPET_M, abs=1e-6)  # lateral offset: x = -lateral for a road running north
    assert lift == pytest.approx(10.0, abs=1e-3)  # deck at 710 m over ground at 700 m
    assert mount == 12.0


def test_lift_round_trips_through_the_pack():
    lamps = [(10.0, 20.0, 12.0, 1, 0, 20000, 90.0, 7.25), (30.0, 40.0, 9.0, 0, 0, 9000, None)]
    data, meta = pl.pack(lamps, (0, 0, 100, 100), {"types": []})
    back = sorted(pl.decode(data, meta), key=lambda l: l[0])
    assert back[0][7] == pytest.approx(7.25, abs=1 / pl.MOUNT_Q)
    assert back[1][7] == 0.0
