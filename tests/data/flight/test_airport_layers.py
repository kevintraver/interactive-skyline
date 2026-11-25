"""The FAA airport-mapping layers and OpenStreetMap's aeroways in the app frame (plan 03, F4.1), offline against the
committed extracts in fixtures/faa_las and fixtures/osm_las (see their SOURCE.txt)."""
import json
import math
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import LineString, Point, Polygon

from lib import airport_layers as al

FX = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def faa():
    return {p.stem.removeprefix("faa-"): json.loads(p.read_text()) for p in (FX / "faa_las").glob("faa-*.json")}


@pytest.fixture(scope="module")
def osm_doc():
    return json.loads((FX / "osm_las" / "osm-aeroways.json").read_text())


@pytest.fixture(scope="module")
def pavement(faa, lv_frame):
    return al.faa_pavement(faa, lv_frame)


@pytest.fixture(scope="module")
def osm(osm_doc, lv_frame):
    return al.osm_aeroways(osm_doc, lv_frame)


def poly(item):
    return al.to_polygon(item)


# ------------------------------------------------------------------ the frame and the compact form
def test_a_flat_ring_is_rounded_counter_clockwise_and_open():
    cw = Polygon([(0, 0), (0, 10.04), (10.06, 10), (10, 0)])
    out = al.flat_polygon(cw)
    assert out["ring"][:2] == [0.0, 0.0]
    assert len(out["ring"]) == 8  # four corners, the closing point not repeated
    assert all(round(v, 1) == v for v in out["ring"])
    assert al.signed_area(out["ring"]) > 0
    assert "holes" not in out


def test_holes_are_kept_and_wound_clockwise():
    p = Polygon([(0, 0), (20, 0), (20, 20), (0, 20)], [[(5, 5), (15, 5), (15, 15), (5, 15)]])
    out = al.flat_polygon(p)
    assert al.signed_area(out["ring"]) > 0
    assert len(out["holes"]) == 1 and al.signed_area(out["holes"][0]) < 0
    assert al.to_polygon(out).area == pytest.approx(300)


def test_grid_bearing_is_true_bearing_less_the_convergence(lv_frame):
    # east of the origin, grid north is turned clockwise from true north: a true bearing reads smaller on the grid
    lat, lon = lv_frame.to_geodetic(np.array(4000.0), np.array(-4000.0))
    g = al.grid_bearing(lv_frame, float(lat), float(lon), 205.0)
    assert 204.9 < g < 205.0
    assert al.grid_bearing(lv_frame, lv_frame.origin["lat"], lv_frame.origin["lon"], 90.0) == pytest.approx(90.0, abs=1e-6)


# ------------------------------------------------------------------ FAA pavement
def test_the_four_runway_polygons_contain_their_nasr_centre_lines(pavement, lv_airport):
    rw = {r["id"]: r for r in pavement["runway"]}
    assert sorted(rw) == ["01L/19R", "01R/19L", "08L/26R", "08R/26L"]
    for r in lv_airport["runways"]:
        a, b = (lv_airport["ends"][e]["end"][:2] for e in r["ends"])
        p = poly(rw[r["id"]])
        # two surveys (FAA mapping of 2025, NASR's of 2024): they agree to 1.4 m at the ends and 1.5 m across
        assert p.buffer(2.0).contains(LineString([a, b])), r["id"]
        # the polygon is the runway's published width, not the shoulders
        assert p.area / r["surveyedLength"] == pytest.approx(r["width"], rel=0.05), r["id"]


def test_taxiways_and_aprons_with_their_designators(pavement):
    assert len(pavement["taxiway"]) == 94
    assert len(pavement["apron"]) == 10
    names = {t["name"] for t in pavement["taxiway"]}
    assert {"A", "B", "C"} <= names
    assert any(a["name"] == "AIR CARGO" for a in pavement["apron"])
    assert all(a["name"] != "UNK" for a in pavement["apron"])  # "unknown" is no name


def test_every_polygon_is_valid_and_counter_clockwise(pavement):
    for kind, items in pavement.items():
        for it in items:
            assert al.signed_area(it["ring"]) > 0, kind
            assert al.to_polygon(it).is_valid, kind


# ------------------------------------------------------------------ OpenStreetMap
def test_centre_lines_with_their_names(osm):
    lines = osm["taxiways"]
    assert len(lines) == 119
    assert {t["kind"] for t in lines} == {"taxiway", "taxilane"} or {t["kind"] for t in lines} == {"taxiway"}
    named = [t for t in lines if t["ref"]]
    assert named and all(len(t["line"]) >= 4 and len(t["line"]) % 2 == 0 for t in lines)


def test_lights_by_kind(osm):
    by = {}
    for g in osm["lights"]:
        by[g["kind"]] = by.get(g["kind"], 0) + len(g["xy"]) // 2
    assert by == {"txe": 186, "rwe": 123, "als": 45, "rwt": 24, "txc": 5, "papi": 2}


def test_the_approach_lights_point_down_the_approach(osm, lv_airport):
    als = [g for g in osm["lights"] if g["kind"] == "als"]
    assert [g["colour"] for g in als] == ["white"]
    # tagged 205 true; 1L is landed on at 025, so they shine back along the approach
    assert abs(als[0]["dir"] - (lv_airport["ends"]["1L"]["gridHeading"] + 180)) < 1.0
    # and they lie on the extended centre line before the 1L threshold, out to 1,400 ft
    thr = np.array(lv_airport["ends"]["1L"]["threshold"][:2])
    u = np.array(lv_airport["runways"][0]["direction"])  # 01L/19R, from 1L toward 19R
    xy = np.array(als[0]["xy"]).reshape(-1, 2) - thr
    along, across = xy @ u, xy @ np.array([u[1], -u[0]])
    assert along.max() < 5 and along.min() > -1400 * 0.3048 - 30
    assert np.abs(across).max() < 25


def test_runway_edge_lights_sit_at_the_runway_edges(osm, pavement):
    rw = [poly(r) for r in pavement["runway"]]
    xy = np.concatenate([np.array(g["xy"]).reshape(-1, 2) for g in osm["lights"] if g["kind"] == "rwe"])
    d = np.array([min(p.exterior.distance(Point(q)) for p in rw) for q in xy])
    assert np.percentile(d, 95) < 5.0
    assert d.max() < 10.0


def test_stands_stop_at_their_gates_and_face_in(osm):
    stands = osm["stands"]
    assert len(stands) == 123
    gates = {g["ref"]: g for g in osm["gates"]}
    with_gate = [s for s in stands if s["ref"] in gates]
    assert len(with_gate) > 30
    for s in with_gate:
        g = gates[s["ref"]]
        lead = np.array(s["lead"]).reshape(-1, 2)
        stop, start = np.array([s["x"], s["y"]]), lead[0]
        assert np.allclose(stop, lead[-1])  # the lead-in line runs to the stop
        assert np.hypot(*(stop - [g["x"], g["y"]])) <= np.hypot(*(start - [g["x"], g["y"]])) + 1e-6, s["ref"]
        # the heading is that of the lead-in's last leg, toward the stop
        dx, dy = stop - lead[-2]
        assert s["heading"] == pytest.approx(math.degrees(math.atan2(dx, dy)) % 360, abs=0.1)


def test_every_stand_has_a_heading_and_a_way_of_telling_its_stop(osm):
    for s in osm["stands"]:
        assert 0 <= s["heading"] < 360
        assert s["stopBy"] in ("gate", "building", "taxiway", "drawn")


def test_holding_positions_take_the_direction_of_their_taxiway(osm):
    hp = osm["holdingPositions"]
    assert len(hp) == 38
    on = [h for h in hp if h["dir"] is not None]
    assert len(on) >= 30
    assert all(0 <= h["dir"] < 180 for h in on)  # a bar's direction is an axis, folded to [0, 180)
    assert any(h["type"] == "runway" for h in hp)


def test_gates_jet_bridges_and_osm_buildings(osm):
    assert len(osm["gates"]) == 58
    assert len(osm["jetBridges"]) == 62
    assert all(len(j["line"]) >= 4 for j in osm["jetBridges"])
    kinds = {b["aeroway"] for b in osm["buildings"]}
    assert kinds <= {"terminal", "hangar"} and "terminal" in kinds


# ------------------------------------------------------------------ buildings, tower and beacon
def test_faa_and_osm_buildings_are_merged(faa, osm, lv_frame):
    blds = al.merge_buildings(al.faa_buildings(faa["AM_Building"], lv_frame), osm["buildings"])
    named = {b["name"] for b in blds}
    assert '"D" GATE' in named
    d = next(b for b in blds if b["name"] == '"D" GATE')
    assert d["kind"] == "terminal" and d["source"] == "faa"
    assert d["osmName"] == "Concourse D"
    tower = [b for b in blds if b["kind"] == "tower"]
    assert len(tower) == 1
    assert len([b for b in blds if b["source"] == "faa"]) == 10


def test_the_tower_from_the_obstacle_file(faa, lv_frame):
    blds = al.faa_buildings(faa["AM_Building"], lv_frame)
    tw = al.tower(faa["Digital_Obstacle_File"], blds, lv_frame)
    assert tw["heightAgl"] == pytest.approx(370 * 0.3048, abs=0.05)
    assert tw["topAmsl"] == pytest.approx(2433 * 0.3048, abs=0.05)
    tb = next(b for b in blds if b["kind"] == "tower")
    assert al.to_polygon(tb).buffer(15).contains(Point(tw["x"], tw["y"]))
    assert tw["source"].startswith("FAA Digital Obstacle File 32-022333")


def test_the_beacon_stands_on_the_tower(faa, lv_frame):
    blds = al.faa_buildings(faa["AM_Building"], lv_frame)
    tw = al.tower(faa["Digital_Obstacle_File"], blds, lv_frame)
    b = al.beacon(faa["AM_Beacon"], tw, lv_frame)
    assert math.hypot(b["x"] - tw["x"], b["y"] - tw["y"]) < 15
    assert b["z"] == tw["topAmsl"] and b["onTower"] is True


# ------------------------------------------------------------------ against the city's buildings
def test_cover_by_the_city_buildings():
    sq = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    city = [Polygon([(0, 0), (60, 0), (60, 100), (0, 100)]), Polygon([(500, 500), (510, 500), (510, 510)])]
    assert al.city_cover(sq, city) == pytest.approx(0.6)
    assert al.city_cover(Polygon([(1000, 0), (1010, 0), (1010, 10)]), city) == 0.0


def test_a_gate_far_from_its_stand_does_not_decide_the_stop():
    """A stand whose gate of the same ref is mapped far away (C19 to C21 at Las Vegas, 130 to 200 m) is told by the
    nearest building instead."""
    xy = np.array([[0.0, 0.0], [0.0, 40.0]])  # drawn from the terminal outwards
    terminal = {"ring": [-30.0, -20.0, 30.0, -20.0, 30.0, -5.0, -30.0, -5.0]}
    gates = [{"ref": "X1", "x": 0.0, "y": 300.0}]  # far beyond the outer end
    st = al._stands([({"ref": "X1"}, xy, "w1")], gates, [terminal], [], [])
    assert st[0]["stopBy"] == "building"
    assert (st[0]["x"], st[0]["y"]) == (0.0, 0.0) and st[0]["heading"] == 180.0
