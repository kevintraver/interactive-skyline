# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: uv run tests/fixtures/roads_make_fixtures.py

Write the road pipeline's test fixtures:

  tests/fixtures/osm-fixture.json   a small hand-made Overpass answer: a directional I 15 relation
      of four ways listed out of order, one stored backwards with oneway=-1, one stored
      backwards with no oneway tag, a 30 m gap before the last, lane counts 3 / 4 / 3, a speed
      change, a placement tag, a bridge, and a junction node with its exit link; plus a
      southbound relation and an unrelated one that must not be picked.
  tests/fixtures/roads-parity.json  what the JavaScript side must reproduce: the Python writer's
      bytes and JSON for a small input full of rounding and wrapping edge cases, and the Python
      refline at 200 chainages along the real i15n.main in public/data/lv/roadnet.*.
      Regenerate after every build_roads.py run.
"""
import base64
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.frame import create_frame  # noqa: E402
from lib.refline import Refline  # noqa: E402
from lib.roadnet import decode_roadnet, encode_roadnet  # noqa: E402

OUT = Path(__file__).resolve().parent


def osm_fixture():
    frame = create_frame(json.loads((ROOT / "data" / "cities.json").read_text())["lv"])
    # the line, in map metres: 1000 m north, a 30 degree right curve of radius 1000 m, 600 m on
    x0, y0, R = -20000.0, -50000.0, 1000.0
    pts = [(x0, y0 + d) for d in (0, 300, 500, 1000)]  # W1; the junction is at 500 m
    arc = [(x0 + R - R * np.cos(a), y0 + 1000 + R * np.sin(a)) for a in np.radians(np.arange(0, 30.01, 3))]
    ex, ey = arc[-1]
    hx, hy = np.sin(np.radians(30)), np.cos(np.radians(30))
    tail = [(ex + hx * d, ey + hy * d) for d in (30, 330, 630)]  # W4 starts 30 m on: the gap
    nid = iter(range(1001, 2000))
    nodes, ways = [], []

    def node(p, tags=None):
        lat, lon = frame.to_geodetic(p[0], p[1])
        n = {"type": "node", "id": next(nid), "lat": round(float(lat), 7), "lon": round(float(lon), 7)}
        if tags:
            n["tags"] = tags
        nodes.append(n)
        return n["id"]

    w1 = [node(p) for p in pts]
    nodes[2]["tags"] = {"highway": "motorway_junction", "ref": "7"}
    a = [w1[-1]] + [node(p) for p in arc[1:]]
    half = len(a) // 2
    w2, w3 = a[: half + 1], a[half:]
    w4 = [node(p) for p in tail]
    link = [w1[2], node((x0 + 15, y0 + 650)), node((x0 + 40, y0 + 800))]
    base = {"highway": "motorway", "ref": "I 15", "oneway": "yes", "maxspeed": "70 mph", "lanes": "3"}
    plain = {k: v for k, v in base.items() if k != "oneway"}
    exit_tags = {"highway": "motorway_link", "oneway": "yes", "destination": "Test Road;Other Road", "junction:ref": "7"}
    w4_tags = {**base, "maxspeed": "65 mph", "placement": "right_of:2", "bridge": "yes", "layer": "1"}
    ways = [
        {"type": "way", "id": 11, "nodes": w1, "tags": dict(base)},
        {"type": "way", "id": 12, "nodes": w2[::-1], "tags": {**base, "oneway": "-1", "lanes": "4"}},
        {"type": "way", "id": 13, "nodes": w3[::-1], "tags": {**plain, "maxspeed": "65 mph"}},
        {"type": "way", "id": 14, "nodes": w4, "tags": w4_tags},
        {"type": "way", "id": 21, "nodes": link, "tags": exit_tags},
        {"type": "way", "id": 31, "nodes": w4[::-1], "tags": {**base}},
    ]
    rel = lambda rid, direction, members, ref="15": {  # noqa: E731
        "type": "relation", "id": rid,
        "members": [{"type": "way", "ref": m, "role": ""} for m in members],
        "tags": {"type": "route", "route": "road", "network": "US:I", "ref": ref, "direction": direction}}
    rels = [rel(101, "north", [11, 13, 12, 14]), rel(102, "south", [31]), rel(103, "north", [31], ref="515")]
    start = frame.to_geodetic(*pts[0])
    end = frame.to_geodetic(*tail[-1])
    return {
        "version": 0.6, "osm3s": {"timestamp_osm_base": "2026-01-01T00:00:00Z"},
        "elements": rels + ways + nodes,
        "fixture": {
            "start": {"lat": float(start[0]), "lon": float(start[1])},
            "end": {"lat": float(end[0]), "lon": float(end[1])},
            "radius": R, "arc_s": [1000.0, 1000.0 + R * np.radians(30)], "gap_m": 30.0,
            "junction": nodes[2]["id"],
        },
    }


def parity_fixture():
    rng = np.random.default_rng(7)
    n = 40
    # the edge cases: exact half units both signs, headings to wrap, tiny and large values
    x = np.r_[0.0025, -0.0025, 0.0015, -0.0015, 1234567.8905, -2146999.9995, rng.uniform(-60000, 60000, n - 6)]
    y = np.r_[-0.0005, 0.0005, 0.5e-3, -1.5e-3, 47999.9995, -63999.0005, rng.uniform(-60000, 60000, n - 6)]
    h = np.r_[620.0005, -0.0005, 958.4995, 0.0, 1e-9, -1e-9, rng.uniform(500, 1200, n - 6)]
    heading = np.r_[np.pi, -np.pi, 3.5, -4.0, 7.0, 2.5e-6, rng.uniform(-10, 10, n - 6)]
    curvature = np.r_[2.5e-9, -2.5e-9, 1 / 600, -1 / 600, 0.0, 5e-10, rng.uniform(-0.003, 0.003, n - 6)]
    crossfall = np.r_[0.02, -0.0000005, 0.0000005, -0.08, 0.0000015, -0.0000025, rng.uniform(-0.08, 0.08, n - 6)]
    road = lambda rid, sl: {  # noqa: E731
        "id": rid, "ref": "I 15", "dir": "north", "extra": {"kept": True},
        "sections": [{"s0": 0, "s1": (sl.stop - sl.start - 1) * 4, "lanes": [{"w": 3.66}, {}], "placement": "centre"}],
        "links": [{"s": 1.5, "side": "right", "kind": "exit", "ref": "1"}],
        "x": x[sl].tolist(), "y": y[sl].tolist(), "h": h[sl].tolist(), "heading": heading[sl].tolist(),
        "curvature": curvature[sl].tolist(), "crossfall": crossfall[sl].tolist(),
    }
    inp = {"version": 1, "source": {"osm": "fixture"}, "roads": [road("a", slice(0, 25)), road("b", slice(25, 40))]}
    inp["roads"][1]["stations"] = {"spacing": 4, "note": "kept"}
    doc, blob = encode_roadnet(inp)

    real_doc = json.loads((ROOT / "public" / "data" / "lv" / "roadnet.json").read_text())
    real_bin = (ROOT / "public" / "data" / "lv" / "roadnet.bin").read_bytes()
    road = next(r for r in decode_roadnet(real_doc, real_bin) if r["id"] == "i15n.main")
    line = Refline(road)
    s = np.r_[0.0, line.length, rng.uniform(0, line.length, 198)]
    p = line.at(s)
    keys = ("x", "y", "h", "heading", "grade", "curvature", "crossfall")
    return {
        "encode": {"input": inp, "json": doc, "bin": base64.b64encode(blob).decode()},
        "refline": {"road": "i15n.main", "count": road["count"], "samples": [
            {"s": float(s[i]), **{k: float(p[k][i]) for k in keys}} for i in range(len(s))]},
    }


def main():
    (OUT / "osm-fixture.json").write_text(json.dumps(osm_fixture(), indent=1) + "\n")
    (OUT / "roads-parity.json").write_text(json.dumps(parity_fixture()) + "\n")
    print("wrote tests/fixtures/osm-fixture.json and tests/fixtures/roads-parity.json")


if __name__ == "__main__":
    main()
