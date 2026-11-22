"""The corridor build's rules and format (scripts/lib/corridor*.py, plan 02 D7.6).

The format's fixture is shared with tests/unit/corridor/format.test.js: both sides encode
tests/unit/corridor/fixtures/cell.json and must give the committed .bin files byte for byte.
Set CORRIDOR_FIXTURE_UPDATE=1 to rewrite them (then check that the JS test still passes).
"""
import json
import math
import os
from pathlib import Path

import pytest

from lib.corridor import RULES, building_type, guess_height, height_of, keep, overture_plausible, tidy
from lib.corridor_format import RUNG, TYPE, CorridorFormatError, decode_cell, encode_cell

FIX = Path(__file__).resolve().parents[1] / "unit" / "corridor" / "fixtures"


def spec():
    doc = json.loads((FIX / "cell.json").read_text())
    return {k: {**v, "buildings": [{**b, "rings": [[tuple(p) for p in r] for r in b["rings"]]} for b in v["buildings"]]}
            for k, v in doc.items() if not k.startswith("_")}


@pytest.mark.parametrize("name", ["cell", "tall"])
def test_fixture_bytes(name):
    blob = encode_cell(spec()[name])
    path = FIX / f"{name}.bin"
    if os.environ.get("CORRIDOR_FIXTURE_UPDATE"):
        path.write_bytes(blob)
    assert blob == path.read_bytes()


@pytest.mark.parametrize("name", ["cell", "tall"])
def test_round_trip(name):
    s = spec()[name]
    unit = 0.01 if s["wide"] else 0.1
    d = decode_cell((FIX / f"{name}.bin").read_bytes())
    assert d["origin"] == tuple(s["origin"]) and d["wide"] == s["wide"]
    assert len(d["buildings"]) == len(s["buildings"])
    for a, b in zip(d["buildings"], s["buildings"]):
        assert (a["type"], a["rung"]) == (b["type"], b["rung"])
        assert a["height"] == pytest.approx(b["height"], abs=0.05 + 1e-9)
        assert [len(r) for r in a["rings"]] == [len(r) for r in b["rings"]]
        for ra, rb in zip(a["rings"], b["rings"]):
            for pa, pb in zip(ra, rb):
                assert pa == pytest.approx(pb, abs=unit / 2 + 1e-9)


def test_rounding_half_away():
    d = decode_cell((FIX / "cell.bin").read_bytes())
    canopy = d["buildings"][2]
    assert canopy["rings"][0][0] == pytest.approx((2899.7, -54900.2))  # -100.25 m -> -1003 dm; 99.75 m -> 998 dm
    assert canopy["rings"][0][1] == pytest.approx((2930.2, -54900.2))  # -69.75 m -> -698 dm
    assert d["buildings"][1]["height"] == pytest.approx(12.3)  # 122.5 dm -> 123


def test_format_limits():
    far = {"origin": (0, 0), "buildings": [{"rings": [[(0, 0), (4000, 0), (0, 10)]], "height": 3, "type": 0, "rung": 3}]}
    with pytest.raises(CorridorFormatError):
        encode_cell(far)  # 4 km is past int16 decimetres
    encode_cell({**far, "wide": True})
    with pytest.raises(CorridorFormatError):
        decode_cell(b"XXXX" + bytes(28))
    with pytest.raises(CorridorFormatError):
        decode_cell((FIX / "cell.bin").read_bytes()[:60])


def test_ladder_order():
    sq = 400.0
    assert height_of({"building": "yes", "height": "30 m", "building:levels": "3"}, sq, 9.0) == (30.0, RUNG["osm-height"])
    assert height_of({"building": "yes", "height": "100 ft"}, sq)[0] == pytest.approx(30.48)
    assert height_of({"building": "yes", "building:levels": "3", "roof:levels": "1"}, sq, 9.0) == (pytest.approx(12.8), RUNG["osm-levels"])
    assert height_of({"building": "yes"}, sq, 9.0) == (9.0, RUNG["overture"])
    h, rung = height_of({"building": "house"}, 200.0, None)
    assert rung == RUNG["guess"] and h == guess_height(TYPE["house"], 200.0) == 4.5
    assert height_of({"building": "yes"}, sq, float("nan"))[1] == RUNG["guess"]
    # Overture's 25 m on an 80 m2 footprint is a tree or a pole: the guess instead
    assert height_of({"building": "yes"}, 80.0, 25.0) == (guess_height(TYPE["other"], 80.0), RUNG["guess"])
    assert height_of({"building": "yes"}, 900.0, 25.0) == (25.0, RUNG["overture"])


def test_types_and_guesses():
    assert building_type({"building": "detached"}) == TYPE["house"]
    assert building_type({"building": "roof", "amenity": "fuel"}) == TYPE["canopy"]
    assert building_type({"building": "yes", "tourism": "hotel"}) == TYPE["hotel"]
    assert building_type({"building": "yes", "shop": "supermarket"}) == TYPE["retail"]
    assert building_type({"building": "warehouse"}) == TYPE["warehouse"]
    assert building_type({"building": "yes"}) == TYPE["other"]
    # a big box is taller than a corner shop; a distribution centre taller than a workshop; no guess reaches 20 m
    assert guess_height(TYPE["retail"], 9000) > guess_height(TYPE["retail"], 300)
    assert guess_height(TYPE["warehouse"], 30000) > guess_height(TYPE["warehouse"], 500)
    assert max(guess_height(t, a) for t in range(10) for a in (50, 500, 5000, 50000)) < RULES["tall"]


# the keep rule on a fixture: (distance m, area m2, height m) -> kept?
KEEP = [
    (0, 30, 3, True), (399, 29, 3, False), (400, 30, 3, True),
    (401, 59, 4, False), (401, 60, 4, True), (1499, 40, 8, True), (1500, 40, 7.9, False),
    (1501, 5000, 15, False), (1501, 50, 20, True), (math.inf, 10, 25, True), (10, 10, 19.9, False),
]


@pytest.mark.parametrize("d,a,h,want", KEEP)
def test_keep_rule(d, a, h, want):
    assert keep(d, a, h) is want


def test_tidy():
    Polygon = pytest.importorskip("shapely.geometry").Polygon
    # a 40 m square with a 0.3 m wobble on one side, a courtyard and a sliver of a hole
    outer = [(0, 0), (20, 0.3), (40, 0), (40, 40), (0, 40)]
    yard = [(10, 10), (10, 20), (20, 20), (20, 10)]
    sliver = [(30, 30), (31, 30), (31, 31.5), (30, 31.5)]
    rings = tidy(Polygon(outer, [yard, sliver]))
    assert len(rings) == 2
    assert len(rings[0]) == 4  # the wobble is under the 1 m tolerance
    area = lambda r: 0.5 * sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(r, r[1:] + r[:1]))  # noqa: E731
    assert area(rings[0]) > 0 > area(rings[1])  # outer counter-clockwise, hole clockwise
    assert rings[0][0] != rings[0][-1]  # open rings


def test_overture_plausible():
    assert overture_plausible(9.0, 100.0)
    assert not overture_plausible(None, 100.0)
    assert not overture_plausible(0.5, 100.0)
    assert not overture_plausible(20.0, 399.0)
    assert overture_plausible(20.0, 400.0)
