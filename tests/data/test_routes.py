"""The three routes (plan 02, D9.1, D9.2): one RoadNet per route, routes.json naming every route's
files, the plan view of every road as committed, each route's acceptance in its report; and the pipeline rules the
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


PLAN = (0, 1, 2, 4, 5, 6)  # roadnet.bin's s, x, y, heading, curvature and crossfall: everything but h (field 3)
# what may follow the ground when the ground under a road is redefined: the heights, which bridges hold a deck (a
# deck is where the ground falls away under the road), the embankments' reach and the reveal's chainage
HEIGHT_KEYS = {"bridges", "embankment"}
ROUTE_HEIGHT_KEYS = {"reveal", "starts"}


@pytest.mark.parametrize("rid", ["i15n", *NEW])
def test_the_plan_view_is_as_committed(rid):
    # The RoadNets were pinned byte for byte until the drive's ground was redefined as the ground as drawn (the meshes'
    # triangles, lib.heights drawn_at, not the bilinear query): the profiles were then set again over it, so the
    # heights moved. The plan must not: every station's s, x, y, heading, curvature and crossfall of every road that
    # was there stays byte for byte, and the roads' JSON stays the same but for what follows the heights.
    name = route(rid)["files"]["roadnet"]
    ref_doc, ref_bin = committed(f"public/data/lv/{name}"), committed(f"public/data/lv/{name.replace('.json', '.bin')}")
    if ref_doc is None or ref_bin is None:
        pytest.skip("no committed RoadNet")
    was_doc, now_doc = json.loads(ref_doc), json.loads((DATA / name).read_text())
    was_ints = np.frombuffer(ref_bin, dtype="<i4").reshape(-1, 7)
    now_ints = np.frombuffer((DATA / name.replace(".json", ".bin")).read_bytes(), dtype="<i4").reshape(-1, 7)
    was = {r["id"]: r for r in was_doc["roads"]}
    now = {r["id"]: r for r in now_doc["roads"]}
    mains = [k for k, r in was.items() if r.get("role", "main") == "main"]
    assert set(mains) <= set(now)
    for k in was:
        if k not in now:
            continue  # a ramp or crossing left out (its open end could not come down to the ground): in the report
        a, b = was[k]["stations"], now[k]["stations"]
        A = was_ints[a["offset"]:a["offset"] + a["count"]]
        B = now_ints[b["offset"]:b["offset"] + b["count"]]
        if k in mains or a["count"] == b["count"]:
            assert a["count"] == b["count"], k
            assert np.array_equal(A[:, PLAN], B[:, PLAN]), k
            strip = lambda r: {kk: v for kk, v in r.items() if kk not in HEIGHT_KEYS and kk != "stations"}  # noqa: E731
            assert strip(now[k]) == strip(was[k]), k
            if k in mains:  # a ramp's or crossing's deck is where it stands over 3 m up (structures.deck_spans): it follows its heights
                assert [(x["s0"], x["s1"]) for x in now[k].get("bridges", [])] == [(x["s0"], x["s1"]) for x in was[k].get("bridges", [])], k
        else:
            # a ramp or crossing cut back at an open end that hung in the air, or one that was cut short to fit and fits
            # further now: the shorter is a run of the longer's stations, unmoved (x, y, heading, curvature; s counts
            # from its own start)
            long_, short = (A, B) if len(A) > len(B) else (B, A)
            xy = long_[:, [1, 2, 4, 5]]
            starts = [i for i in range(len(long_) - len(short) + 1) if np.array_equal(xy[i], short[0, [1, 2, 4, 5]])]
            assert any(np.array_equal(xy[i:i + len(short)], short[:, [1, 2, 4, 5]]) for i in starts), k
    ref = committed("public/data/lv/routes.json")
    later = ("files", "outline", *ROUTE_HEIGHT_KEYS)
    plain = lambda r: {k: ([m for m in v if m["kind"] != "reveal"] if k == "markers" else v)  # noqa: E731
                       for k, v in r.items() if k not in later}
    assert plain(route(rid)) == plain(next(r for r in json.loads(ref)["routes"] if r["id"] == rid))


@pytest.mark.parametrize("rid", ["i15n", *NEW])
def test_each_route_has_an_outline_along_its_road(rid):
    """The route picker's small map: a few dozen points, from the route's first station to its last, never far
    from its road."""
    r = route(rid)
    doc = json.loads((DATA / r["files"]["roadnet"]).read_text())
    road = next(x for x in decode_roadnet(doc, (DATA / r["files"]["roadnet"].replace(".json", ".bin")).read_bytes()) if x["id"] == r["road"])
    pts = np.asarray(r["outline"], float)
    assert 2 <= len(pts) <= 80
    xy = np.column_stack([road["x"], road["y"]])
    assert np.hypot(*(pts[0] - xy[0])) < 20 and np.hypot(*(pts[-1] - xy[-1])) < 20
    d = np.min(np.hypot(xy[None, :, 0] - pts[:, None, 0], xy[None, :, 1] - pts[:, None, 1]), axis=1)
    assert d.max() < build_roads.OUTLINE_TOL + build_roads.OUTLINE_ROUND


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


@pytest.mark.parametrize("rid", ["i15n", *NEW])
def test_each_carriageway_runs_on_beyond_both_ends_as_scenery(rid):
    # build_roads.py build_lead: LEAD_M of the same road before the first station and after the last of both
    # carriageways, separate roads joined end to end (the route's chainage still starts at 0 where it did)
    r = route(rid)
    doc = json.loads((DATA / r["files"]["roadnet"]).read_text())
    roads = {x["id"]: x for x in decode_roadnet(doc, (DATA / r["files"]["roadnet"].replace(".json", ".bin")).read_bytes())}
    for cw in (r["road"], r["opposite"]):
        c = roads[cw]
        for which, j, k in (("in", 0, -1), ("out", -1, 0)):
            lead = roads[f"{cw}.{which}"]
            assert lead["lead"] == {"of": cw, "end": "start" if which == "in" else "end"}
            assert lead.get("role", "main") == "main" and lead["length"] == build_roads.LEAD_M
            # it meets the carriageway's end station exactly: position, heading, height
            assert (lead["x"][k], lead["y"][k], lead["h"][k]) == (c["x"][j], c["y"][j], c["h"][j]), (cw, which)
            assert lead["heading"][k] == c["heading"][j]
            # with the carriageway's own end section there (lanes from OSM beyond it), and within the grade limit
            at = lead["sections"][k]
            assert at["provenance"]["lanes"].startswith("as ") and len(at["lanes"]) == len(c["sections"][j]["lanes"])
            assert [ln["w"] for ln in at["lanes"]] == [ln["w"] for ln in c["sections"][j]["lanes"]]
            assert (at["s1"] - at["s0"]) >= build_roads.LEAD_SAME_M - 1e-6 or len(lead["sections"]) == 1
            assert np.abs(np.diff(lead["h"])).max() / lead["spacing"] <= build_roads.GRADE + 1e-3
        leads = report(rid)["routes"][rid]["leads"]
        for which in ("in", "out"):
            info = leads[f"{cw}.{which}"]
            assert info["built"] and info["buried_below_envelope_m"] == 0 and info["eased_m"] < 0.5, info
            # one known shortfall: I-15 south's lead-out starts under Russell Road's deck, 4.62 m below it (not 4.9)
            assert "under_crossing" not in info or f"{cw}.{which}" == "i15s.main.out", info
    # the US-93 deck runs on to the Arizona side: the lead-in starts on land and is a held deck where it meets the route
    if rid == "us93":
        lead = next(x for x in doc["roads"] if x["id"] == "us93.main.in")
        assert lead["bridges"][-1]["s1"] == build_roads.LEAD_M and lead["bridges"][-1].get("deck")


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
