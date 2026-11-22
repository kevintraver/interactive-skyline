"""The road pipeline: stitching, the spline fit and stations, sections, the from-above profile,
the RoadNet writer and the refline twin. Fixtures: tests/fixtures/osm-fixture.json and
roads-parity.json, written by tests/fixtures/roads_make_fixtures.py."""
import base64
import json
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import build_roads
from lib.alignment import densify, fit_line, stations
from lib.frame import create_frame
from lib.ground import drawn_surface
from lib.heights import load_heights
from lib.osm import load_osm, mph, route_relations, stitch
from lib.profile import envelope, smooth_from_above
from lib.refline import Refline
from lib.roadnet import RoadNetError, decode_roadnet, encode_roadnet, round_away, wrap_angle

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
OSM_DOC = json.loads((FIX / "osm-fixture.json").read_text())
FIXTURE = OSM_DOC["fixture"]
CITY = json.loads((ROOT / "data" / "cities.json").read_text())["lv"]
FRAME = create_frame(CITY)


def xy(p):
    return tuple(float(v) for v in FRAME.to_local(p["lat"], p["lon"]))


@pytest.fixture(scope="module")
def osm():
    return load_osm(OSM_DOC)


@pytest.fixture(scope="module")
def chain(osm):
    return stitch(osm, route_relations(osm, "I 15", "north"), xy(FIXTURE["start"]), FRAME.to_local)


# ------------------------------------------------------------------ OSM and stitching

def test_relations_are_chosen_by_tags(osm):
    assert route_relations(osm, "I 15", "north") == [101]
    assert route_relations(osm, "I 15", "south") == [102]


def test_stitch_orders_ways_follows_oneway_and_reverses_where_needed(osm, chain):
    assert chain.ways == [11, 12, 13, 14]  # listed 11, 13, 12, 14 in the relation
    assert chain.reversed_ways == [13]  # stored backwards, no oneway tag: turned round
    assert chain.against_oneway == []  # way 12 is oneway=-1, so its stored order is backwards anyway
    lat, lon = osm.latlon(chain.node_ids)
    x, y = FRAME.to_local(lat, lon)
    # strictly onward: every segment heads north-ish to north-east, never back
    hd = np.degrees(np.arctan2(np.diff(x), np.diff(y)))  # bearing from north
    assert hd.min() > -1 and hd.max() < 31


def test_stitch_bridges_a_gap_and_records_it(chain):
    assert len(chain.gaps) == 1
    g = chain.gaps[0]
    assert (g["after_way"], g["way"]) == (13, 14)
    assert g["metres"] == pytest.approx(FIXTURE["gap_m"], abs=0.05)


def test_stitch_refuses_a_gap_beyond_the_limit(osm):
    c = stitch(osm, [101], xy(FIXTURE["start"]), FRAME.to_local, max_gap=10)
    assert c.ways == [11, 12, 13] and not c.gaps


def test_maxspeed_units():
    assert mph("70 mph") == 70 and mph("65mph") == 65
    assert mph("100") == 62  # km/h by default
    assert mph(None) is None and mph("fast") is None


# ------------------------------------------------------------------ fit and stations

@pytest.fixture(scope="module")
def fitted(osm, chain):
    lat, lon = osm.latlon(chain.node_ids)
    P = np.column_stack(FRAME.to_local(lat, lon))
    return P, fit_line(P, tol=0.5)


def test_spline_stays_within_half_a_metre_of_the_nodes(fitted):
    _, fit = fitted
    assert fit.node_distance.max() <= 0.5


def test_densify_keeps_long_straights_straight():
    # a 3 km straight between a short curved stretch at each end: the filled points stay on it
    pts = np.array([[0, -40], [0, 0], [0, 3000], [20, 3040], [60, 3075]], dtype=float)
    dense, idx = densify(pts, 10)
    straight = dense[idx[1]:idx[2] + 1]
    assert np.abs(straight[:, 0]).max() < 0.5


def test_densify_follows_a_sparse_curve_not_its_chords():
    R = 4500.0
    a = np.radians(np.arange(0, 31, 5.1))  # nodes 400 m apart on one arc: each chord sags 4.4 m
    pts = np.column_stack([R * np.sin(a), R - R * np.cos(a)])
    dense, _ = densify(pts, 10)
    r = np.hypot(dense[:, 0], dense[:, 1] - R)
    assert np.abs(r - R).max() < 0.3


def test_stations_are_uniform_and_end_on_a_multiple_of_16(fitted):
    _, fit = fitted
    st = stations(fit, 0.0, fit.arc[-1], 4.0)
    n = len(st["s"])
    assert (n - 1) % 16 == 0
    assert fit.arc[-1] - st["s"][-1] < 64
    np.testing.assert_array_equal(st["s"], np.arange(n) * 4.0)
    chord = np.hypot(np.diff(st["x"]), np.diff(st["y"]))
    assert np.abs(chord - 4).max() < 0.005 * 4
    # heading is the tangent: it agrees with the chord direction between neighbours
    mid = np.arctan2(np.diff(st["y"]), np.diff(st["x"]))
    avg = np.angle(np.exp(1j * st["heading"][:-1]) + np.exp(1j * st["heading"][1:]))
    assert np.abs(np.angle(np.exp(1j * (mid - avg)))).max() < 1e-3


def test_curvature_on_the_arc_is_the_radius_and_negative_for_a_right_turn(fitted):
    _, fit = fitted
    st = stations(fit, 0.0, fit.arc[-1], 4.0)
    a0, a1 = FIXTURE["arc_s"]
    m = (st["s"] > a0 + 80) & (st["s"] < a1 - 80)
    k = st["curvature"][m]
    assert np.all(k < 0)
    assert np.median(-1 / k) == pytest.approx(FIXTURE["radius"], rel=0.05)


# ------------------------------------------------------------------ a whole road on flat ground

class FlatHeights(SimpleNamespace):
    def height_at(self, x, y):
        return 600.0 + 0.002 * np.asarray(x, float) + 0 * np.asarray(y, float)


@pytest.fixture(scope="module")
def road(osm):
    hs = FlatHeights()
    return build_roads.build_road(osm, FRAME, hs, hs.height_at, "t.main", "I 15", "north",
                                  FIXTURE["start"], FIXTURE["end"])


def test_sections_follow_runs_of_equal_lanes_and_placement(road):
    r, info = road
    secs = r["sections"]
    assert [len(s["lanes"]) for s in secs] == [3, 4, 3, 3]
    assert secs[-1].get("placement") == "right_of:2"
    assert all(s.get("placement", "centre") == "centre" for s in secs[:-1])
    assert all(lane["w"] == 3.66 for s in secs for lane in s["lanes"])
    assert secs[0]["s0"] == 0 and secs[-1]["s1"] == info["length"]
    for a, b in zip(secs, secs[1:]):
        assert a["s1"] == b["s0"]
    # the four-lane way is the first half of the curve
    assert secs[1]["s0"] == pytest.approx(FIXTURE["arc_s"][0], abs=1)


def test_speed_zones_bridges_and_exits(road):
    r, _ = road
    assert [z["mph"] for z in r["speed"]] == [70, 65]
    assert r["bridges"] and r["bridges"][0]["kind"] == "bridge"
    assert len(r["links"]) == 1
    e = r["links"][0]
    assert (e["ref"], e["side"], e["label"]) == ("7", "right", "Test Road / Other Road")
    assert e["s"] == pytest.approx(500, abs=1)


def test_crossfall_falls_right_on_tangents(road):
    r, _ = road
    s = np.arange(len(r["x"])) * 4.0
    straight = s < 800
    np.testing.assert_allclose(r["crossfall"][straight], 0.02)
    assert np.all(r["crossfall"] > 0)  # the curve turns right: banked, left edge higher


def test_road_is_above_the_ground_everywhere(road):
    r, _ = road
    doc, blob = encode_roadnet({"roads": [r]})
    dec = decode_roadnet(doc, blob)[0]
    hs = FlatHeights()
    clear = build_roads.check_clearance(dec, hs, hs.height_at)
    assert clear["query"]["min_m"] >= 0.29  # 0.3 m less the writer's millimetre rounding


# ------------------------------------------------------------------ the profile from above

def test_smoothing_from_above_never_dips_below_and_keeps_the_grade():
    rng = np.random.default_rng(3)
    s = np.arange(0, 8000, 4.0)
    env = 800 + 30 * np.sin(s / 700) + 4 * np.sin(s / 37) + rng.normal(0, 0.8, len(s))
    env[1000:1003] += 12  # a spike: the road must climb over it within the limits
    z = smooth_from_above(env, 4.0, grade=0.06, radius=3000)
    assert np.all(z >= env - 1e-9)
    assert np.abs(np.diff(z) / 4).max() <= 0.06 + 1e-6
    assert np.abs(np.diff(z, 2) / 16).max() <= 1 / 3000 + 1e-6
    lid = (env.max() - env).mean()
    assert (z - env).mean() < 0.2 * lid  # the lowest such profile, not a lid over everything


def test_envelope_takes_the_highest_ground_across_with_crossfall():
    st = {"x": np.array([0.0]), "y": np.array([0.0]), "heading": np.array([np.pi / 2]), "crossfall": np.array([0.02])}

    def ground(x, y):  # heading north: left is west (-x). A 1 m ridge 5 m to the right.
        return np.where(np.abs(np.asarray(x) - 5) < 0.6, 101.0, 100.0)

    need = envelope(st, np.array([8.0]), np.array([-8.0]), ground, clearance=0.3, margin=2.0, across=1.0)
    # at d = -5 the pavement is 0.1 m below the reference line, so the line must be 101.4
    assert need[0] == pytest.approx(101.0 + 0.02 * 5 + 0.3)


def test_drawn_surface_is_the_terrain_at_the_posts():
    hs = load_heights("lv")
    top = drawn_surface(hs)
    g = hs.grids["near"]
    i, j = np.arange(5, g.nx - 5, 97), np.arange(5, g.ny - 5, 131)
    ii, jj = np.meshgrid(i, j)
    x, y = g.x0 + ii * g.step, g.y0 + jj * g.step
    np.testing.assert_allclose(top(x, y), g.raw[jj, ii] * g.scale, atol=1e-9)
    # off the posts it is at least the bilinear height on one of the two triangles' sides
    assert np.all(np.isfinite(top(x + 3.3, y + 7.1)))


# ------------------------------------------------------------------ writer and refline

def test_round_half_away_and_wrap():
    assert round_away(2.5) == 3 and round_away(-2.5) == -3 and round_away(-2.4999) == -2
    assert wrap_angle(-math.pi) == math.pi
    assert wrap_angle(3 * math.pi / 2) == pytest.approx(-math.pi / 2)


def test_writer_matches_the_parity_fixture():
    fx = json.loads((FIX / "roads-parity.json").read_text())["encode"]
    doc, blob = encode_roadnet(fx["input"])
    assert blob == base64.b64decode(fx["bin"])
    assert json.loads(json.dumps(doc)) == fx["json"]


def test_writer_round_trip_and_checks():
    s = np.arange(33) * 4.0
    road = {"id": "r", "sections": [{"s0": 0, "s1": 128, "lanes": [{}]}], "x": s * 0.6, "y": s * 0.8,
            "h": 600 + s * 0.01, "heading": np.full(33, math.atan2(0.8, 0.6)), "curvature": np.zeros(33),
            "crossfall": np.full(33, 0.02)}
    doc, blob = encode_roadnet({"roads": [road]})
    assert len(blob) == 33 * 28
    dec = decode_roadnet(doc, blob)[0]
    np.testing.assert_allclose(dec["x"], road["x"], atol=5e-4)
    bad = bytearray(blob)
    bad[28:32] = (5).to_bytes(4, "little", signed=True)
    with pytest.raises(RoadNetError):
        decode_roadnet(doc, bytes(bad))


def test_real_roadnet_decodes_and_the_refline_matches_the_fixture():
    doc = json.loads((ROOT / "public" / "data" / "lv" / "roadnet.json").read_text())
    blob = (ROOT / "public" / "data" / "lv" / "roadnet.bin").read_bytes()
    roads = {r["id"]: r for r in decode_roadnet(doc, blob)}
    assert "i15n.main" in roads
    assert encode_roadnet({**doc, "roads": [{**r} for r in decode_roadnet(doc, blob)]})[1] == blob
    fx = json.loads((FIX / "roads-parity.json").read_text())["refline"]
    line = Refline(roads[fx["road"]])
    s = np.array([p["s"] for p in fx["samples"]])
    got = line.at(s)
    for k in ("x", "y", "h"):
        np.testing.assert_allclose(got[k], [p[k] for p in fx["samples"]], atol=1e-6)


def test_routes_json_keeps_the_shared_schema():
    doc = json.loads((ROOT / "public" / "data" / "lv" / "routes.json").read_text())
    assert doc["version"] == 1 and "osm" in doc["source"]
    r = next(r for r in doc["routes"] if r["id"] == "i15n")
    for k in ("label", "from", "to", "road", "s0", "s1", "length", "lane", "postedSeconds", "reveal", "starts", "markers"):
        assert k in r
    assert r["length"] == r["s1"] - r["s0"]
    assert set(r["starts"]) >= {"reveal", "start", "city"}
    assert set(r["reveal"]) >= {"s", "target", "label"}
    ss = [m["s"] for m in r["markers"]]
    assert ss == sorted(ss)
    assert {m["kind"] for m in r["markers"]} == {"exit", "place", "reveal"}
    assert {"Jean", "Sloan", "I-215", "Spaghetti Bowl"} <= {m["label"] for m in r["markers"] if m["kind"] == "place"}
