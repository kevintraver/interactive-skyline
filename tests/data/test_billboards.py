"""Billboards (plan 02, D7.4): merging across the three sources, placement, facing and clearance on a fixture road."""
import json
import math
from pathlib import Path

import numpy as np

from lib.billboards import (BULLETIN, PANEL_CLEAR, POLE_CLEAR, RoadIndex, clark_records, clv_records, dedupe, encode,
                            fnv1a, footprint, osm_records, panels, place)

ROOT = Path(__file__).resolve().parents[2]
ident = lambda lat, lon: (lon, lat)  # noqa: E731  fixtures give map metres as "lon, lat"


def straight_road(rid, x0, y0, heading, length=2000.0, spacing=4.0, half=(7.0, -7.0)):
    n = int(length / spacing) + 1
    s = np.arange(n) * spacing
    return {"id": rid, "spacing": spacing, "count": n, "x": x0 + s * math.cos(heading), "y": y0 + s * math.sin(heading),
            "heading": np.full(n, heading), "h": np.full(n, 600.0), "half": half}


def edges(r, s):
    return np.full(len(s), r["half"][0]), np.full(len(s), r["half"][1])


def fixture_index():
    # a northbound main line along x = 0 (pavement x in [-7, 7]) and a ramp leaving it to the east at y = 1000
    main = straight_road("t.main", 0, -1000, math.pi / 2)
    ramp = straight_road("t.x1.off", 10, 0, math.radians(60), length=300, half=(3.0, -3.0))
    return RoadIndex([main, ramp], edges), RoadIndex([main], edges)


def osm(id_, x, y, **tags):
    return {"type": "node", "id": id_, "lat": y, "lon": x, "tags": {"advertising": "billboard", **tags}}


def test_hash_is_stable():
    assert fnv1a("osm:n1") == fnv1a("osm:n1")
    assert fnv1a("a") == 0xE40C292C  # FNV-1a 32 test vector


def test_readers():
    o = osm_records({"elements": [osm(1, 50, 20, direction="270", sides="2"), osm(2, 0, 0, support="wall_mounted"),
                                  {"type": "way", "id": 9, "tags": {"advertising": "billboard"},
                                   "geometry": [{"lat": 0, "lon": 40}, {"lat": 10, "lon": 40}]}]}, ident)
    assert [r["id"] for r in o] == ["n1", "w9"]  # the wall-mounted one is not a structure
    assert math.isclose(math.cos(o[0]["facing"]), -1)  # a bearing of 270 looks west
    assert o[0]["sides"] == 2
    assert math.isclose(o[1]["along"], math.pi / 2) and (o[1]["x"], o[1]["y"]) == (40, 5)
    c = clv_records({"features": [{"geometry": {"type": "Point", "coordinates": [30, 40]},
                                   "properties": {"OBJECTID": 7, "SIZE_": "14x48", "SIGN_HEIGH": 40, "NOTES": "NEW DIGITAL FACE"}}]}, ident)
    assert math.isclose(c[0]["width"], BULLETIN[0]) and math.isclose(c[0]["height"], BULLETIN[1])
    assert math.isclose(c[0]["overall"], 40 * 0.3048) and c[0]["digital"] is True
    k = clark_records({"features": [{"geometry": {"type": "Point", "coordinates": [1, 2]}, "properties": {"BILLBOARDS": 5, "CATEGORY": "PENDING"}}]}, ident)
    assert k[0]["status"] == "pending"


def test_dedupe_merges_across_sources_and_keeps_the_best():
    recs = osm_records({"elements": [osm(1, 100, 0, direction="180"), osm(2, 500, 0)]}, ident)
    recs += clv_records({"features": [{"geometry": {"type": "Point", "coordinates": [110, 5]},
                                       "properties": {"OBJECTID": 3, "SIZE_": "12x24", "SIGN_HEIGH": 30}}]}, ident)
    recs += clark_records({"features": [{"geometry": {"type": "Point", "coordinates": [95, -8]}, "properties": {"BILLBOARDS": 4, "CATEGORY": "EXISTING"}},
                                        {"geometry": {"type": "Point", "coordinates": [900, 0]}, "properties": {"BILLBOARDS": 6, "CATEGORY": "EXISTING"}}]}, ident)
    boards, groups = dedupe(recs)
    assert len(boards) == 3
    merged = next(b for b in boards if len(b["members"]) == 3)
    assert merged["sources"] == ["clark", "clv", "osm"]
    assert (merged["x"], merged["y"]) == (110, 5)  # the City's position and size win
    assert math.isclose(merged["width"], 24 * 0.3048)
    assert math.isclose(merged["facing"], math.radians(-90))  # OSM's direction is kept
    # single linkage, not transitive beyond the radius: two records 31 m apart stay apart
    b2, _ = dedupe(osm_records({"elements": [osm(1, 0, 0), osm(2, 31, 0)]}, ident))
    assert len(b2) == 2
    # one source twice within the radius: one structure with two faces
    b3, _ = dedupe(clark_records({"features": [{"geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {"BILLBOARDS": 1, "CATEGORY": "EXISTING"}},
                                               {"geometry": {"type": "Point", "coordinates": [6, 0]}, "properties": {"BILLBOARDS": 2, "CATEGORY": "EXISTING"}}]}, ident))
    assert len(b3) == 1 and b3[0]["sides"] == 2


def test_placement_faces_approaching_traffic_and_clears_the_pavement():
    index, routes = fixture_index()
    recs = [{"src": "osm", "id": f"n{i}", "x": x, "y": y, "width": None, "height": None, "overall": None, "digital": None,
             "sides": s, "facing": None, "along": None, "status": "existing"}
            for i, (x, y, s) in enumerate([(40, -500, 1), (-60, -300, 2), (3, -100, 1), (900, 0, 1)])]
    placed, rep = place(recs, index, routes)
    ids = {p["id"]: p for p in placed}
    assert "n3" not in ids and rep["beyond_route_m"] == 1  # 900 m from the road
    east = ids["n0"]
    # northbound traffic comes from the south: the face looks south, turned toward the road (west)
    nx, ny = math.cos(east["facing"]), math.sin(east["facing"])
    assert ny < -0.9 and nx < 0
    assert math.isclose(math.degrees(math.atan2(-nx, -ny)), 15, abs_tol=0.01)
    v = ids["n1"]
    a = [math.cos(v["facing"]), math.sin(v["facing"])]
    b = [math.cos(v["facing2"]), math.sin(v["facing2"])]
    assert a[1] < -0.9 and b[1] > 0.9 and a[0] > 0 and b[0] > 0  # west of the road: both faces turn east, toward it
    # the board standing on the shoulder was pushed off the pavement, to the side it stood on
    moved = ids["n2"]
    assert moved["shift"] > 0 and moved["x"] > 7
    for p in placed:
        assert index.clearance(p["x"], p["y"]) >= POLE_CLEAR
        assert all(index.clearance(x, y) >= PANEL_CLEAR for x, y in footprint(p))
        assert (p["w"], p["h"]) == BULLETIN


def test_v_panels_meet_at_the_road_side_and_centre_on_the_pole():
    # east of a north-south road: the faces look south and north, each turned 20 degrees toward the road (west)
    b = {"x": 50.0, "y": 0.0, "w": 14.63, "sides": 2, "facing": math.radians(-110), "facing2": math.radians(110)}
    (c1x, c1y, a1, l1), (c2x, c2y, a2, l2) = panels(b)
    assert math.isclose((c1x + c2x) / 2, 50, abs_tol=1e-9) and math.isclose((c1y + c2y) / 2, 0, abs_tol=1e-9)
    assert c1y < 0 < c2y  # the south-facing face is on the south side
    for cx, cy, a, al in panels(b):
        assert math.isclose(math.cos(a - al), 0, abs_tol=1e-9)  # each panel lies across its own normal
    xs = [x for x, _ in footprint(b)]
    assert min(xs) < 50 < max(xs)  # the apex is toward the road, the open end away from it
    assert math.isclose(max(xs) - min(xs), 14.63 * math.cos(math.radians(20)), rel_tol=1e-6)


def test_encode_rows_round():
    index, routes = fixture_index()
    recs = [{"src": "clv", "id": "clv1", "x": 60.0, "y": 0.0, "width": None, "height": None, "overall": 40 * 0.3048,
             "digital": True, "sides": 1, "facing": None, "along": None, "status": "existing"}]
    placed, _ = place(recs, index, routes)
    (row,) = encode(placed)
    assert row[7] == 1 and row[8] == 1 and row[3] is None and row[10] == 2
    assert math.isclose(row[6], 40 * 0.3048 - BULLETIN[1], abs_tol=0.01)


def test_product_is_small_and_textless():
    p = ROOT / "public" / "data" / "lv" / "billboards.json"
    if not p.exists():
        return
    doc = json.loads(p.read_text())
    assert p.stat().st_size < 60_000
    assert doc["fields"][:2] == ["x", "y"]
    for row in doc["boards"]:
        assert all(v is None or isinstance(v, (int, float)) for v in row)  # numbers only: nothing to read on a face
