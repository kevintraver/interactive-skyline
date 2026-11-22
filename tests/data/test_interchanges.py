"""Interchanges (plan 02, D3.4): the plan-overlap rule over the whole network, each kind of gore
on a synthetic interchange, a ramp that climbs to an overpass, and the writer's parity on the new
records. The synthetic fixtures are OSM documents built here in the Las Vegas frame over flat
ground, so every height comes from the rules alone."""
import base64
import json
from pathlib import Path

import numpy as np
import pytest

from lib.frame import create_frame
from lib.interchanges import CLEAR_MIN, DECK, GORE_GAP, GORE_SL, MARK_HALF, build_interchanges
from lib.osm import load_osm
from lib.roadframe import RoadFrame
from lib.roadnet import decode_roadnet, encode_roadnet
from lib.structures import plan_overlaps

ROOT = Path(__file__).resolve().parents[2]
CITY = json.loads((ROOT / "data" / "cities.json").read_text())["lv"]
FRAME = create_frame(CITY)
MAIN_H, GROUND_H = 700.0, 690.0


def ground(x, y):
    return np.full(np.shape(x), GROUND_H)


def main_road():
    """A straight carriageway going east along y = 0 from x = -1500 to 1500, three lanes."""
    x = np.arange(-1500.0, 1500.0 + 1e-9, 4.0)
    n = len(x)
    return {"id": "t.main", "spacing": 4.0, "x": x, "y": np.zeros(n), "h": np.full(n, MAIN_H),
            "heading": np.zeros(n), "curvature": np.zeros(n), "crossfall": np.full(n, 0.02),
            "sections": [{"s0": 0, "s1": 3000, "lanes": [{}, {}, {}]}], "bridges": [], "links": []}


class Doc:
    """An Overpass-like document built from map coordinates."""

    def __init__(self):
        self.elements = []
        self.next_id = 10_000

    def node(self, x, y, nid=None, tags=None):
        nid = nid or self.next_id
        self.next_id += 1
        lat, lon = FRAME.to_geodetic(np.array([x]), np.array([y]))
        self.elements.append({"type": "node", "id": nid, "lat": float(lat[0]), "lon": float(lon[0]), **({"tags": tags} if tags else {})})
        return nid

    def way(self, wid, nodes, **tags):
        self.elements.append({"type": "way", "id": wid, "nodes": nodes, "tags": tags})

    def osm(self):
        return load_osm({"elements": self.elements})


def with_main(doc, junctions=()):
    """The main line's OSM way (nodes every 50 m, ids 1..61 at x = -1500 + 50 (id - 1))."""
    ids = []
    for k in range(61):
        nid = k + 1
        ids.append(doc.node(-1500 + 50 * k, 0.0, nid, {"highway": "motorway_junction"} if nid in junctions else None))
    doc.way(1, ids, highway="motorway", oneway="yes", ref="I 15", lanes="3")
    return ids


def link(doc, wid, start, pts, end=None):
    nodes = ([start] if start else []) + [doc.node(x, y) for x, y in pts] + ([end] if end else [])
    doc.way(wid, nodes, highway="motorway_link", oneway="yes", lanes="1")
    return nodes


def build(doc, ids):
    F = RoadFrame(main_road())
    cws = [{"frame": F, "ids": ids, "ways": {1}, "prefix": "t", "links": []}]
    ic = build_interchanges(doc.osm(), cws, FRAME.to_local, ground, log=lambda *a: None)
    return ic, F


@pytest.fixture(scope="module")
def gores():
    """Four ramps on the straight carriageway: an exit and an entrance on each side."""
    doc = Doc()
    ids = with_main(doc, junctions={31, 11})
    link(doc, 100, 31, [(60, -4), (120, -12), (180, -26), (240, -46), (300, -72), (360, -104), (420, -142)])
    link(doc, 200, None, [(540, -150), (600, -112), (660, -80), (720, -52), (780, -30), (840, -12)], end=49)
    link(doc, 300, 11, [(-940, 4), (-880, 12), (-820, 26), (-760, 46), (-700, 72), (-640, 104), (-580, 142)])
    link(doc, 400, None, [(-460, 150), (-400, 112), (-340, 80), (-280, 52), (-220, 30), (-160, 12)], end=29)
    return build(doc, ids)


def ramp_of(ic, kind, side):
    js = [j for j in ic["junctions"] if j["kind"] == kind and j["side"] == side]
    assert len(js) == 1, f"one {kind} on the {side}"
    j = js[0]
    road = next(r for r in ic["roads"] if r["id"] == j["b"]["road"])
    return j, road


@pytest.mark.parametrize("kind,side", [("diverge", "right"), ("merge", "right"), ("diverge", "left"), ("merge", "left")])
def test_each_kind_of_gore_meets_the_main_line_without_gap_or_overlap(gores, kind, side):
    ic, F = gores
    j, road = ramp_of(ic, kind, side)
    R = RoadFrame(road)
    g = j["gore"]
    assert len(g["a"]) >= 2 and np.all(np.diff(g["a"]) > 0) and np.all(np.diff(g["b"]) > 0)
    # where the ramp runs beside the main line, its pavement edge facing the main line is just beyond
    # the main line's gore edge (the outer edge of the edge line's marking strip): the gore strip between
    # them is a few centimetres wide, never negative (no overlap) and never more (no gap)
    rs = np.array(g["b"])
    ms = np.array(g["a"])
    near = rs <= rs[0] + 60 if kind == "diverge" else rs >= rs[-1] - 60
    le, ri = R.edges(rs[near])
    d_edge = le if side == "right" else ri
    p = R.line.at(rs[near])
    ex = p["x"] - d_edge * np.sin(p["heading"])
    ey = p["y"] + d_edge * np.cos(p["heading"])
    s_m, d_m, _ = F.sd(ex, ey)
    lane_l, lane_r = F.lane_edges(s_m)
    gore_edge = lane_r - MARK_HALF if side == "right" else lane_l + MARK_HALF
    gap = (gore_edge - d_m) if side == "right" else (d_m - gore_edge)
    assert gap.min() > -0.02 and gap.max() < GORE_GAP - MARK_HALF - GORE_SL + 0.1
    # and in the main line's plane, so the two pavements meet in height too
    z_ramp = R.surface(rs[near], d_edge)
    z_main = F.surface(s_m, d_m)
    assert np.abs(z_ramp - z_main).max() < 0.02
    # the hidden shoulder covers the gore's stretch of the main line
    assert j["a"]["road"] == F.id and j["a"]["s0"] <= ms[0] + 1e-6 and j["a"]["s1"] >= ms[-1] - 1e-6
    # the lane opens (or closes) over a taper at the main line
    secs = road["sections"]
    if kind == "diverge":
        assert secs[0]["lanes"][0]["w"] < 0.1 and secs[1]["taper"]["kind"] == "opening"
    else:
        assert secs[-1]["lanes"][0]["w"] < 0.1 and secs[-1]["taper"]["kind"] == "closing"


def test_gores_keep_the_overlap_rule_and_the_ramps_reach_the_ground(gores):
    ic, F = gores
    assert len([r for r in ic["roads"] if r["role"] == "ramp"]) == 4
    ov = plan_overlaps(ic["frames"], ic["junctions"])
    assert ov["violations"] == []
    assert ov["pairs"] >= 4  # each ramp overlaps the main line's hidden shoulder, inside its junction
    for r in ic["roads"]:
        h = np.asarray(r["h"])
        assert h.min() > GROUND_H and np.abs(np.diff(h)).max() / 4.0 <= 0.08 + 1e-6
        # away from the main line the ramp comes down onto the ground
        assert h.min() < GROUND_H + 1.0


@pytest.fixture(scope="module")
def overpass():
    """A two-way street crossing over the main line at x = 600 on a bridge, and an exit ramp that
    climbs to meet the street where its bridge begins."""
    doc = Doc()
    ids = with_main(doc, junctions={31})
    south = [doc.node(600, y) for y in range(-400, -60, 40)]
    b0, b1 = doc.node(600, -60), doc.node(600, 60)
    north = [doc.node(600, y) for y in range(100, 401, 40)]
    doc.way(500, south + [b0], highway="secondary", name="Test Street", lanes="4")
    doc.way(501, [b0, b1], highway="secondary", name="Test Street", lanes="4", bridge="yes", layer="1")
    doc.way(502, [b1] + north, highway="secondary", name="Test Street", lanes="4")
    link(doc, 100, 31, [(100, -8), (200, -26), (300, -48), (400, -64), (480, -68), (540, -66)], end=b0)
    return build(doc, ids)


def test_a_ramp_climbs_to_meet_an_overpass(overpass):
    ic, F = overpass
    cross = next(r for r in ic["roads"] if r["role"] == "crossing")
    ramp = next(r for r in ic["roads"] if r["role"] == "ramp")
    X, R = RoadFrame(cross), RoadFrame(ramp)
    # the street clears the main line by more than 4.9 m under its deck, and is on a deck there
    pts = X.pavement_points(step=2.0, across=1.0)
    m, sb, db = F.inside(pts["x"], pts["y"])
    assert m.any()
    clearance = (pts["z"][m] - DECK) - F.surface(sb[m], db[m])
    assert clearance.min() >= CLEAR_MIN
    assert any(b["deck"] for b in cross["bridges"])
    # the ramp leaves at the main line's height and ends on the street's surface, well above it
    assert abs(ramp["h"][0] - (MAIN_H + 0.02 * F.sd(ramp["x"][0], ramp["y"][0])[1][0])) < 0.02
    s_x, d_x, _ = X.sd(ramp["x"][-1], ramp["y"][-1])
    assert abs(ramp["h"][-1] - X.surface(s_x, d_x)[0]) < 0.05
    assert ramp["h"][-1] > MAIN_H + 2.0
    assert np.abs(np.diff(ramp["h"])).max() / 4.0 <= 0.08 + 1e-6
    conn = [j for j in ic["junctions"] if j["kind"] == "connect" and j["b"]["road"] == ramp["id"]]
    assert conn and conn[0]["a"]["road"] == cross["id"]
    # piers stand clear of the main line's pavement, abutments close the deck
    piers = [s for s in ic["structures"] if s["kind"] == "pier"]
    assert piers and {s["kind"] for s in ic["structures"]} >= {"pier", "abutment"}
    for s in piers:
        x, y = X.xy(np.array([s["s"]]), np.array([s["d"]]))
        assert not F.inside(x, y, grow=0.5)[0].any()
        assert s["h1"] > s["h0"]
    assert plan_overlaps(ic["frames"], ic["junctions"])["violations"] == []


def test_the_whole_network_keeps_the_plan_overlap_rule():
    """Wherever two road surfaces in public/data/lv overlap in plan they are more than 4.9 m apart,
    or a junction between them covers the overlap."""
    doc = json.loads((ROOT / "public" / "data" / "lv" / "roadnet.json").read_text())
    roads = decode_roadnet(doc, (ROOT / "public" / "data" / "lv" / "roadnet.bin").read_bytes())
    frames = [RoadFrame(r) for r in roads]
    ov = plan_overlaps(frames, doc.get("junctions", []))
    assert ov["violations"] == []
    if doc.get("junctions"):
        assert ov["min_separation_m"] is None or ov["min_separation_m"] > 4.9


def test_python_writer_matches_the_interchange_parity_fixture():
    fx = json.loads((ROOT / "tests" / "unit" / "roadnet" / "interchange-parity.json").read_text())
    doc, blob = encode_roadnet(json.loads(json.dumps(fx["input"])))
    assert base64.b64encode(blob).decode() == fx["bin"]
    assert json.loads(json.dumps(doc)) == fx["json"]
