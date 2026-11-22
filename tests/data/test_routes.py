"""The three routes (plan 02, D9.1, D9.2): one RoadNet per route, routes.json naming every route's
files, i15n's files untouched, each route's acceptance in its report; and the pipeline rules the
other two routes needed (a bridge's deck over a canyon, a mistagged relation role, comfortable
tapers on the driven carriageway, a carriageway on a shared deck is not a crossing)."""
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

import build_roads
from lib.lanes import place_tapers
from lib.osm import load_osm, stitch
from lib.roadnet import decode_roadnet

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "public" / "data" / "lv"
DERIVED = ROOT / "data" / "derived" / "lv"
ROUTES = json.loads((DATA / "routes.json").read_text())
CITY = json.loads((ROOT / "data" / "cities.json").read_text())["lv"]
NEW = ["i15s", "us93"]


def route(rid):
    return next(r for r in ROUTES["routes"] if r["id"] == rid)


def report(rid):
    name = "roads_report.json" if rid == "i15n" else f"roads_report-{rid}.json"
    return json.loads((DERIVED / name).read_text())


def committed(path):
    try:
        return subprocess.run(["git", "show", f"HEAD:{path}"], cwd=ROOT, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None


# ------------------------------------------------------------------ files

def test_routes_json_lists_every_route_of_cities_json_with_its_files():
    assert [r["id"] for r in ROUTES["routes"]] == [r["id"] for r in CITY["routes"]] == ["i15n", "i15s", "us93"]
    for r in ROUTES["routes"]:
        f = r["files"]
        first = r["id"] == "i15n"
        assert f["roadnet"] == ("roadnet.json" if first else f"roadnet-{r['id']}.json")
        assert f["signs"] == ("signs.json" if first else f"signs-{r['id']}.json")
        assert f["traffic"] == f"traffic/{r['id']}.json"
        assert (DATA / f["roadnet"]).exists() and (DATA / f["roadnet"].replace(".json", ".bin")).exists()
        assert (DATA / f["traffic"]).exists()


def test_i15n_is_byte_for_byte_as_committed():
    for name in ("roadnet.json", "roadnet.bin"):
        ref = committed(f"public/data/lv/{name}")
        if ref is None:
            pytest.skip("no committed RoadNet")
        assert (DATA / name).read_bytes() == ref
    ref = committed("public/data/lv/routes.json")
    was = next(r for r in json.loads(ref)["routes"] if r["id"] == "i15n")
    now = {k: v for k, v in route("i15n").items() if k != "files"}
    assert now == was


@pytest.mark.parametrize("rid", NEW)
def test_each_route_has_a_roadnet_of_its_own(rid):
    r = route(rid)
    doc = json.loads((DATA / r["files"]["roadnet"]).read_text())
    roads = {x["id"]: x for x in decode_roadnet(doc, (DATA / r["files"]["roadnet"].replace(".json", ".bin")).read_bytes())}
    assert r["road"] == f"{rid}.main" and r["road"] in roads and r["opposite"] in roads
    assert "i15n.main" not in roads
    assert abs(roads[r["road"]]["length"] - r["s1"]) < 1e-3
    ramps = [k for k in roads if ".x" in k]
    crossings = [k for k in roads if k.startswith("x.")]
    assert len(ramps) > 40 and len(crossings) >= 8
    assert doc.get("junctions") and doc.get("structures")
    size = (DATA / r["files"]["roadnet"]).stat().st_size + (DATA / r["files"]["roadnet"].replace(".json", ".bin")).stat().st_size
    assert size < build_roads.MAX_BYTES


# ------------------------------------------------------------------ acceptance

@pytest.mark.parametrize("rid", ["i15n"] + NEW)
def test_every_acceptance_check_passes(rid):
    rep = report(rid)
    acc = rep["routes"][rid]["acceptance"]
    missed = [k for k, a in acc.items() if not a["ok"]]
    assert not missed, missed
    assert rep["files"]["ok"]
    for key in ("length", "grade", "exits", "reveal", "lane_plan", "no_overlap", "main_lane_counts", "main_edge_rate",
                "interchanges_exit_ramps", "interchanges_overpasses", "interchanges_no_ramp_through_main",
                "interchanges_plan_overlap_rule"):
        assert key in acc, key


@pytest.mark.parametrize("rid", NEW)
def test_route_numbers(rid):
    rr = report(rid)["routes"][rid]
    acc = rr["acceptance"]
    exp_len, (exp_rev, tol) = build_roads.EXPECT_LENGTH[rid], build_roads.EXPECT_REVEAL[rid]
    assert abs(acc["length"]["measured_m"] - exp_len) <= 0.005 * exp_len
    assert abs(acc["reveal"]["measured_s"] - exp_rev) <= tol
    assert acc["grade"]["max"] <= 0.06
    assert acc["interchanges_overpasses"]["min_clearance_m"] >= 4.9
    assert rr["main"]["stitch"]["gaps"] == [] and rr["main"]["stitch"]["against_oneway"] == []
    r = route(rid)
    assert r["starts"]["start"] == 0 and 0 < r["starts"]["reveal"] < r["reveal"]["s"] < r["starts"]["city"] < r["s1"]


def test_us93_starts_on_the_bridge_at_55_mph():
    rr = report("us93")["routes"]["us93"]
    assert rr["main"]["speed"][0] == {"s0": 0, "mph": 55}
    assert 55 in [z["mph"] for z in rr["main"]["speed"][1:]]  # the 55 mph zones at the start come back
    doc = json.loads((DATA / "roadnet-us93.json").read_text())
    main = next(x for x in doc["roads"] if x["id"] == "us93.main")
    assert main["bridges"][0]["s0"] == 0 and main["bridges"][0]["s1"] > 300
    # the deck is held up over the canyon, not dropped into it
    road = next(x for x in decode_roadnet(doc, (DATA / "roadnet-us93.bin").read_bytes()) if x["id"] == "us93.main")
    k = int(main["bridges"][0]["s1"] / road["spacing"])
    assert np.ptp(road["h"][:k]) < 20


# ------------------------------------------------------------------ the rules

def test_hold_decks_lifts_a_canyon_and_leaves_a_street_underpass():
    s = np.arange(0, 400, 4.0)
    env = np.full(len(s), 500.0)
    canyon = (s > 100) & (s < 300)
    env[canyon] = 300.0
    runs = [(96.0, 304.0, "yes")]
    out = build_roads.hold_decks(env, s, runs)
    assert out[canyon].min() == pytest.approx(500.0)
    shallow = env.copy()
    shallow[canyon] = 495.0  # 5 m: a street under a bridge, left to the profile's own rules
    np.testing.assert_array_equal(build_roads.hold_decks(shallow, s, runs), shallow)
    # a bridge running past the road's start is held level at its abutment inside the road
    out = build_roads.hold_decks(np.r_[np.full(50, 250.0), np.full(50, 460.0)], s, [(0.0, 200.0, "viaduct")])
    assert out[:50].min() == pytest.approx(460.0)


def test_a_member_with_a_wrong_role_is_not_against_oneway():
    nodes = [{"type": "node", "id": i, "lat": 36.0 + i * 1e-3, "lon": -115.0} for i in range(1, 6)]
    ways = [{"type": "way", "id": 10, "nodes": [1, 2, 3], "tags": {"oneway": "yes"}},
            {"type": "way", "id": 11, "nodes": [3, 4, 5], "tags": {"oneway": "yes"}}]
    rel = {"type": "relation", "id": 1, "tags": {}, "members": [{"type": "way", "ref": 10, "role": ""},
                                                               {"type": "way", "ref": 11, "role": "backward"}]}
    osm = load_osm({"elements": nodes + ways + [rel]})
    to_local = lambda lat, lon: (np.asarray(lon) * 1e5, np.asarray(lat) * 1e5)  # noqa: E731
    ch = stitch(osm, [1], (-115.0 * 1e5, 36.001 * 1e5), to_local)
    assert ch.node_ids == [1, 2, 3, 4, 5]
    assert ch.reversed_ways == [11] and ch.against_oneway == []


def test_comfort_lengthens_a_taper_that_moves_the_driven_lanes():
    def secs():
        lanes = [{"w": 3.66, "kind": "drive", "id": i} for i in (1, 2, 3)]
        # the road ends 40 m past the shift, so the taper is squeezed below its MUTCD length
        return [{"s0": 0, "s1": 1000, "lanes": [dict(x) for x in lanes]},
                {"s0": 1000, "s1": 1040, "lanes": [dict(x) for x in lanes], "placement": "right_of:2"}]
    plain, comfy = secs(), secs()
    place_tapers(plain, lambda s: 65, 1040)
    place_tapers(comfy, lambda s: 65, 1040, comfort=True)
    lp = plain[1]["taper"]["s1"] - plain[1]["taper"]["s0"]
    lc = comfy[1]["taper"]["s1"] - comfy[1]["taper"]["s0"]
    v = 65 * 0.44704
    assert lc > lp
    # (the taper ends are rounded to 0.1 m)
    assert v * v * 1.83 * (10 / np.sqrt(3)) / lc ** 2 <= 0.95 * 1.01  # peak lateral acceleration
    assert v ** 3 * 1.83 * 60 / lc ** 3 <= 2.4 * 1.01  # peak lateral jerk
