"""Barriers, delineators and overhead signs (plan 02, D3.6 and D3.7): the barriers file format
against the JavaScript writer's fixture, the rule fit and its hold-out comparison, the placement
rules on fixtures, and the acceptance checks on the real build (skipped where its inputs are missing)."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from lib import roadside_barriers as B
from lib.roadside_barrier_format import decode_barriers, encode_barriers, num
from lib.roadside_legend import denied, load_denylist
from lib.roadside_overhead import MIN_CLEAR, is_overhead

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
DATA = ROOT / "public" / "data" / "lv"
RAW = ROOT / "data" / "raw" / "lv"
FT = 0.3048

# ---- the format


def test_python_writer_matches_the_fixture_the_javascript_writer_matches():
    inp = json.loads((FIX / "barriers-input.json").read_text())
    assert encode_barriers(inp) == (FIX / "barriers.json").read_text()


def test_decode_then_encode_gives_the_file_back():
    text = (FIX / "barriers.json").read_text()
    assert encode_barriers(decode_barriers(text)) == text
    d = decode_barriers(text)
    wall = d["roads"][0]["runs"][3]
    assert (wall["type"], wall["h"], wall["z1"], wall["open0"], wall["open1"]) == ("wall", 4, -0.28, True, True)


def test_numbers_round_half_away_from_zero_without_negative_zero():
    assert num(0.125, 2) == 0.13 and num(-0.125, 2) == -0.13
    assert num(12.0, 1) == 12 and isinstance(num(12.0, 1), int)
    assert str(num(-0.0001, 2)) == "0"


# ---- rules and their fit


def test_osm_types():
    assert B.osm_type({"barrier": "jersey_barrier"}, 1.0) == B.T_CODE["concrete"]
    assert B.osm_type({"barrier": "guard_rail"}, 0.5) == B.T_CODE["guardrail"]
    assert B.osm_type({"barrier": "guard_rail", "material": "concrete"}, 0.5) == B.T_CODE["concrete"]
    assert B.osm_type({"barrier": "wall", "material": "concrete"}, 1.5) == B.T_CODE["concrete"]  # a median wall
    assert B.osm_type({"barrier": "wall", "wall": "noise_barrier"}, 14.0) == B.T_CODE["wall"]
    assert B.osm_type({"barrier": "fence"}, 20.0) == B.FENCE
    assert B.wall_height({"barrier": "wall", "wall": "noise_barrier"}) == B.WALL_H["noise"]
    assert B.wall_height({"barrier": "wall", "height": "2.5 m"}) == 2.5


def test_fit_threshold_recovers_a_known_threshold():
    rng = np.random.default_rng(3)
    x = rng.uniform(0, 30, 4000)
    truth = x < 9.0
    noisy = truth ^ (rng.uniform(0, 1, x.size) < 0.03)
    t, sc = B.fit_threshold(x, noisy, below=True)
    assert abs(t - 9.0) < 0.5 and sc["f1"] > 0.9
    t2, _ = B.fit_threshold(x, x > 20, below=False)
    assert abs(t2 - 20.0) < 0.5


def test_an_unsupported_fit_keeps_the_design_value_and_says_why():
    rng = np.random.default_rng(4)
    x = rng.uniform(0, 5, 3000)
    y = rng.uniform(0, 1, 3000) < 0.02  # positives unrelated to x
    m = np.ones(3000, dtype=bool)
    out = B.fit_rules({"fill": [(x, y, m, m)], "median": []})
    assert out["fill"]["fitted"] is False and out["fill"]["threshold"] == B.DEFAULT_FILL
    assert "design value" in out["fill"]["why"]
    few = B.fit_rules({"fill": [(x, np.zeros(3000, dtype=bool), m, m)], "median": []})
    assert few["fill"]["fitted"] is False


def test_the_holdout_takes_every_fourth_surveyed_block():
    s = np.arange(0, 20000, B.STEP)
    surveyed = s < 16000
    train, test = B.holdout_split(s, surveyed)
    blocks = sorted(set((s[test] // B.BLOCK).astype(int)))
    assert blocks == [3, 7, 11, 15]
    assert not (train & test).any() and not (test & ~surveyed).any()


def test_mapped_coverage_closes_small_gaps_and_drops_short_bits():
    m = np.zeros(100, dtype=bool)
    m[10:20] = True
    m[24:40] = True  # a 4-station gap: closed
    m[60:62] = True  # too short: dropped
    out = B.drop_short(B.close_gaps(m, B.GAP_BRIDGE), B.MIN_RUN)
    assert out[10:40].all() and not out[60:62].any()


def test_rule_runs_are_smoothed_so_the_desert_is_not_patchy():
    lab = np.full(400, B.NONE)
    lab[0:150] = B.T_CODE["concrete"]  # 600 m: kept
    lab[160:170] = B.T_CODE["concrete"]  # 40 m after a 40 m gap: joined
    lab[300:320] = B.T_CODE["concrete"]  # 80 m alone: dropped
    out = B.smooth_rule(lab, B.T_CODE["concrete"], "concrete")
    assert (out[0:170] == B.T_CODE["concrete"]).all() and (out[300:320] == B.NONE).all()


def test_delineator_spacing_on_curves_follows_mutcd_table_3f1():
    # S = 3 sqrt(R - 50) ft: 1000 ft radius -> 92.5 ft; very tight curves stop at 20 ft, gentle ones at 300 ft
    assert B.curve_spacing(1000 * FT) / FT == pytest.approx(3 * math.sqrt(950), rel=1e-9)
    assert B.curve_spacing(40 * FT) / FT == pytest.approx(20)
    assert B.curve_spacing(50000 * FT) / FT == pytest.approx(300)


def test_overhead_where_the_road_is_wide_or_the_exit_is_on_the_left():
    assert is_overhead("advance", "right", 4) and is_overhead("exit", "left", 2)
    assert not is_overhead("advance", "right", 3) and not is_overhead("gore", "left", 6)


# ---- the real build

need = pytest.mark.skipif(not ((DATA / "roadnet.json").exists() and (RAW / "osm-i15-barriers.json").exists()),
                          reason="needs the built roadnet and the OSM barrier extract")


@pytest.fixture(scope="module")
def built():
    from lib.frame import create_frame
    from lib.heights import load_heights
    from lib.osm import load_osm
    from lib.roadnet import decode_roadnet
    doc = json.loads((DATA / "roadnet.json").read_text())
    roads = {r["id"]: r for r in decode_roadnet(doc, (DATA / "roadnet.bin").read_bytes())}
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())["lv"]
    osm = load_osm(json.loads((RAW / "osm-i15-barriers.json").read_text()))
    out, rep, ctx = B.build(roads, doc["junctions"], [dict(s) for s in doc["structures"]], "i15n.main", "i15s.opp",
                            osm, create_frame(cfg), load_heights("lv"))
    return {"roads": roads, "doc": doc, "out": out, "report": rep, "ctx": ctx}


@need
def test_the_median_rule_holds_up_on_the_held_out_mapped_stretches(built):
    med = built["report"]["fit"]["median"]
    assert med["fitted"] and 3 < med["threshold"] < 20
    assert med["holdout"]["stations"] >= 200
    assert med["holdout"]["precision"] >= 0.7 and med["holdout"]["recall"] >= 0.7


@need
def test_provenance_is_recorded_and_both_kinds_are_used(built):
    provs = {r["prov"] for road in built["out"] for r in road["runs"]}
    assert provs == {"mapped", "rule"}
    assert {r["type"] for road in built["out"] for r in road["runs"]} >= {"concrete", "guardrail", "wall"}


@need
def test_no_barrier_in_a_lane_a_gore_opening_or_another_roads_pavement(built):
    geoms, pav = built["ctx"]["geoms"], built["ctx"]["pavements"]
    for road in built["out"]:
        g = geoms[road["id"]]
        for r in road["runs"]:
            lo = {"concrete": 0.3, "guardrail": -0.01, "cable": -0.01, "wall": 1.0}[r["type"]]
            assert min(r["o0"], r["o1"]) >= lo, (road["id"], r)
            ss = np.arange(r["s0"], r["s1"] + 1e-9, 4.0)
            o = np.interp(ss, [r["s0"], r["s1"]], [r["o0"], r["o1"]])
            x, y, he = g.point(ss, r["side"], o)
            assert not pav.blocked(g.id, x, y, he, clearance=0.2).any(), (road["id"], r)
            if min(r["o0"], r["o1"]) < 6:
                for a, b in B.junction_cuts(g, built["doc"]["junctions"], r["side"]):
                    assert r["s1"] <= a + 1e-6 or r["s0"] >= b - 1e-6, (road["id"], r, a, b)


@need
def test_thirty_check_points_say_what_they_rest_on(built):
    pts = built["report"]["check_points"]
    assert len(pts) == 30
    for p in pts:
        for side in ("left", "right"):
            assert p[side]["basis"] in ("mapped", "rule only")
            if p[side]["basis"] == "mapped":
                assert p[side]["agrees"] is True, p


@need
def test_the_barrier_file_is_small(built):
    assert len(encode_barriers({"roads": built["out"]}).encode()) < 100_000


# ---- D3.7 on the built signs.json

need_signs = pytest.mark.skipif(not (DATA / "signs.json").exists(), reason="needs public/data/lv/signs.json")


@need_signs
def test_every_exit_has_its_three_signs_and_overhead_signs_clear_17_ft():
    rep = json.loads((ROOT / "data" / "derived" / "lv" / "roadside_report.json").read_text())["i15n"]
    fewer = rep["checks"]["exits"]["fewer_than_three"]
    # Exit 1 is 202 m past the route's start: its advance signs would stand in California
    assert all(f["exit"] == "1" and all(w.get("why") == "before the route starts" for w in f["why"]) for f in fewer)
    assert not rep["median_too_narrow"]
    assert all(o["clearance_m"] >= MIN_CLEAR for o in rep["overhead"])
    assert len(rep["overhead"]) >= 36


@need_signs
def test_letter_heights_mounting_and_sheeting_are_in_range():
    doc = json.loads((DATA / "signs.json").read_text())
    caps = {"advance": (16, 20), "exit": (16, 20), "sequence": (16, 20), "gore": (12, 16), "speed": (16, 24),
            "route": (12, 24), "mile": (6, 12)}
    for r in doc["roads"][0]["signs"]:
        lo, hi = caps[r["kind"]]
        assert lo - 0.05 <= r["cap"] / 0.0254 <= hi + 0.05
        assert r["mount"] >= (17 * FT if r.get("over") else 4 * FT if r["kind"] == "mile" else 7 * FT) - 1e-6
        assert r["sheeting"][0] in ("green", "white") and r["sheeting"][1] in ("white", "none")


@need_signs
def test_no_legend_carries_a_denied_name():
    deny = load_denylist(ROOT / "data" / "sign_denylist.txt")
    doc = json.loads((DATA / "signs.json").read_text())
    texts = []
    for road in doc["roads"]:
        for e in road["exits"]:
            texts += e["lines"] + [s["num"] for s in e["shields"]] + ([e["tab"]["text"]] if e["tab"] else [])
        for r in road["signs"]:
            texts += [x["text"] for x in r.get("rows", [])] + [r[k] for k in ("action", "dir") if r.get(k)]
    assert texts and not [t for t in texts if denied(t, deny)]


def test_file_names_follow_the_route():
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_roadside", ROOT / "scripts" / "build_roadside.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.suffix_of("i15n") == "" and mod.suffix_of("i15s") == "-i15s" and mod.suffix_of("us95") == "-us95"
