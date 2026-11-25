"""build_traffic.py (plan 02, D6.1): the pipeline stage by stage on a three-station fixture, then
the acceptance numbers on the real report and the shape of the real product."""
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

import build_traffic as B
from lib import traffic as T

ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parent / "fixtures" / "traffic"
REPORT = ROOT / "data" / "derived" / "lv" / "traffic_report.json"
PRODUCT = ROOT / "public" / "data" / "lv" / "traffic" / "i15n.json"


# ---------------------------------------------------------------- fixture

@pytest.fixture(scope="module")
def fx():
    stations = T.parse_stations((FIX / "stations.txt").read_text().splitlines())
    records = T.parse_volume((FIX / "volume.txt").read_text().splitlines())
    days, dropped = T.station_days(records, stations)
    return {"stations": stations, "records": records, "days": days, "dropped": dropped}


def raw_counts(sid, direction, date):
    """Hourly whole-carriageway counts of one day, summed straight from the fixture text."""
    tot = np.zeros(24)
    for line in (FIX / "volume.txt").read_text().splitlines():
        f = line.split("|")
        if f[3] == sid and int(f[4]) == direction and (int(f[7]), int(f[8])) == (date.month, date.day):
            tot += np.array([int(x) for x in f[11:35]])
    return tot


def test_stage1_parse_and_drop(fx):
    assert fx["stations"][("000001", 1)]["lanes"] == 2
    assert fx["stations"][("000003", 5)]["lanes"] == 3
    assert T.tmas_id("0035440") == "035440" and T.trina_id("035440") == "0035440"
    reasons = {(d["station"], d["dir"], d["date"]): d["reason"] for d in fx["dropped"]}
    assert reasons == {("000001", 1, "2025-01-13"): "lane 2 missing",
                       ("000001", 5, "2025-02-10"): "lane 1 zero all day"}
    assert len(fx["days"][("000001", 1)]) == 56
    assert len(fx["days"][("000002", 1)]) == 28
    d = dt.date(2025, 7, 11)
    assert np.array_equal(fx["days"][("000003", 5)][d], raw_counts("000003", 5, d))


def test_stage2_hour_of_week_means(fx):
    m = T.hour_of_week_means(fx["days"])
    a = m[("000001", 1)]
    assert a["flow"].shape == (4, 168) and a["counted"] == [True] * 4
    # summer Friday 15:00 = mean of the two summer Fridays in the fixture
    want = (raw_counts("000001", 1, dt.date(2025, 7, 11))[15] + raw_counts("000001", 1, dt.date(2025, 8, 8))[15]) / 2
    assert a["flow"][2, 24 * 4 + 15] == pytest.approx(want)
    assert m[("000002", 1)]["counted"] == [True, False, False, True]
    assert np.isnan(m[("000002", 1)]["flow"][1]).all()
    assert T.how_index(dt.date(2025, 11, 23), 11) == 24 * 6 + 11  # a Sunday


def test_stage2_borrow(fx):
    m = T.hour_of_week_means(fx["days"])
    got = T.borrow_seasons(m, ("000002", 1), ("000003", 1))
    assert got == [1, 2]
    k = np.sum(m[("000002", 1)]["flow"][[0, 3]]) / np.sum(m[("000003", 1)]["flow"][[0, 3]])
    assert np.allclose(m[("000002", 1)]["flow"][2], m[("000003", 1)]["flow"][2] * k)
    assert m[("000002", 1)]["counted"] == [True, False, False, True]


def test_stage4_lanes_speed_capacity(fx):
    sh = T.lane_shares(fx["records"], fx["days"])
    # TMAS lane 1 is the right lane; the product lists left to right
    assert sh[("000001", 1)] == pytest.approx([0.38, 0.62], abs=0.01)
    r = T.resample_shares([0.3, 0.4, 0.3], 5)
    assert sum(r) == pytest.approx(1) and len(r) == 5
    assert T.resample_shares([0.5, 0.5], 2) == [0.5, 0.5]
    assert T.lane_offsets_mps(3) == pytest.approx([6 * T.MPH, 3 * T.MPH, 0], abs=1e-3)
    assert T.lane_offsets_mps(5)[0] == pytest.approx(6 * T.MPH, abs=1e-3)
    assert T.capacity_vph(3, 0.0) == 6900
    assert T.capacity_vph(2, 0.2) == pytest.approx(2300 * 2 / 1.2)


def test_boundaries():
    e = T.boundaries(1000, [100, 500, 500.4], [{"s": 600}, {"s": 800}, {"s": 600}])
    assert e == [0, 100, 500, 700, 1000]


def straight_road(rid, length, sections, links, speed, reverse=False, spacing=4.0):
    count = int(length / spacing) + 1
    y = np.arange(count) * spacing
    if reverse:
        y = y[::-1].copy()
    return {"id": rid, "x": np.zeros(count), "y": y, "spacing": spacing, "count": count,
            "sections": [{"s0": a, "s1": b, "lanes": [{"kind": "drive"}] * n} for a, b, n in sections],
            "speed": speed, "links": links}


@pytest.fixture(scope="module")
def built(fx):
    L = 10000.0
    main = straight_road("t.main", L, [(0, 5000, 2), (5000, 5600, 4), (5600, L, 3)],
                         [{"s": 3000, "ref": "3"}, {"s": 5000, "ref": "5"}, {"s": 7500, "ref": "7"}],
                         [{"s0": 0, "mph": 70}, {"s0": 6000, "mph": 65}])
    opp = straight_road("t.opp", L, [(0, L, 3)], [{"s": 2498.0, "ref": "x"}, {"s": 1000, "ref": "y"}],
                        [{"s0": 0, "mph": 65}], reverse=True)
    stations_on = [
        {"id": "0000001", "s": 2000.0, "offset": 0, "type": "Permanent", "aadt2way": 20000, "location": "A"},
        {"id": "0000004", "s": 4500.0, "offset": 0, "type": "ShortTerm", "aadt2way": 50000, "location": "short"},
        {"id": "0000002", "s": 6000.0, "offset": 0, "type": "Permanent", "aadt2way": 40000, "location": "B"},
        {"id": "0000003", "s": 9000.0, "offset": 0, "type": "Permanent", "aadt2way": 90000, "location": "C"},
    ]
    cfg = {"with": {"road": "t.main", "tmasDir": 1}, "against": {"road": "t.opp", "tmasDir": 5},
           "laneShareStations": ["0000001", "0000003"], "totalsOnly": [], "borrowFrom": {"0000002": "0000003"},
           "trucks": [{"fromExit": "", "share": 0.2, "source": "x"}, {"fromExit": "5", "share": 0.1, "source": "y"}],
           "plan": {"station": "0000001", "withRatio": 1.3, "withPeak": 15, "againstRatio": 1.4, "againstPeak": 11}}
    directions, accept, extra = B.run_pipeline("t", cfg, L, main, opp, {}, {}, stations_on, fx["records"],
                                               fx["days"], fx["dropped"], fx["stations"], {})
    return {"directions": directions, "accept": accept, "extra": extra, "L": L, "fx": fx}


def test_stage3_and_5_segments_tile(built):
    for k in ("with", "against"):
        segs = built["directions"][k]["segments"]
        assert segs[0]["s0"] == 0 and segs[-1]["s1"] == built["L"]
        assert all(a["s1"] == b["s0"] for a, b in zip(segs, segs[1:]))
        for sg in segs:
            assert len(sg["flow"]) == 4 and all(len(r) == 168 for r in sg["flow"])
            assert sum(sg["laneShares"]) == pytest.approx(1, abs=1e-9)
            assert len(sg["laneShares"]) == len(sg["laneSpeedOffsetsMps"]) == sg["lanes"]
            assert set(sg["provenance"]) == {"shape", "level", "lanes", "notes"}
    edges = built["extra"]["edges"]
    # our exits, the opposing exit at s=9000 (route chainage), not the one at the same interchange
    assert {3000, 5000, 7500, 9000} <= set(edges)
    assert not any(abs(e - 7502) < 1 for e in edges)


def test_stage3_levels(built):
    segs = built["directions"]["with"]["segments"]
    short = T.segment_at(segs, 4500)
    assert short["provenance"]["level"] == "0000004"
    a = built["accept"]
    # the short-term level is TRINA's two-way AADT times the directional split of a station counted both ways
    w = T.season_weights(2025)
    sw = T.segment_at(built["directions"]["with"]["segments"], 4500)["aadt"]
    sa = T.segment_at(built["directions"]["against"]["segments"], 4500)["aadt"]
    assert sw + sa == pytest.approx(50000, abs=2)
    inter = T.segment_at(segs, 8000)
    assert inter["provenance"]["level"] == "interpolated"
    assert inter["provenance"]["shape"] == "0000001+0000003"
    # lanes: the minimum over the segment; speed: the lowest limit in it; trucks by stretch
    assert T.segment_at(segs, 5200)["lanes"] == 3
    assert T.segment_at(segs, 1000)["lanes"] == 2
    assert T.segment_at(segs, 9500)["freeFlowMps"] == pytest.approx(65 * T.MPH, abs=1e-3)
    assert T.segment_at(segs, 1000)["truckShare"] == 0.2 and T.segment_at(segs, 8000)["truckShare"] == 0.1
    assert a["pass"]


def test_acceptance_on_fixture(built):
    res = built["accept"]["stationFlows"]
    ids = {(r["station"], r["dir"]) for k in res for r in res[k]}
    assert ids == {(s, d) for s in ("0000001", "0000002", "0000003") for d in ("north", "south")}
    assert all(r["maxRelError"] < 0.01 for k in res for r in res[k])
    b = next(r for r in res["with"] if r["station"] == "0000002")
    assert b["seasonsCounted"] == ["winter", "autumn"]
    # the product at a station equals the source mean, hour by hour
    seg = T.segment_at(built["directions"]["with"]["segments"], 9000)
    d1, d2 = dt.date(2025, 4, 9), dt.date(2025, 5, 7)  # the spring Wednesdays
    want = (raw_counts("000003", 1, d1) + raw_counts("000003", 1, d2)) / 2
    assert np.allclose(seg["flow"][1][48:72], want, rtol=0.001)
    p = built["accept"]["planStation"]
    assert p["with"]["source"]["peakHour"] == 15 and p["against"]["source"]["peakHour"] == 11
    assert p["with"]["productMatchesSource"] and p["against"]["productMatchesSource"]


# ---------------------------------------------------------------- the real build

def real_report():
    if not REPORT.exists():
        pytest.skip("run scripts/build_traffic.py lv first")
    return json.loads(REPORT.read_text())["routes"]["i15n"]


def test_real_every_station_within_1pct():
    r = real_report()
    flows = r["acceptance"]["stationFlows"]
    assert flows["with"] and flows["against"]
    for k in flows:
        for x in flows[k]:
            assert x["maxRelError"] <= 0.01, x
    for x in r["acceptance"]["twoWayTotals"]:
        assert x["relError"] <= 0.01
    assert r["acceptance"]["pass"]


def test_real_jean_pattern():
    p = real_report()["acceptance"]["planStation"]
    assert p["station"] == "0035440"
    fri, sun = p["with"], p["against"]
    assert fri["weekday"] == "Fri" and fri["direction"] == "north"
    assert sun["weekday"] == "Sun" and sun["direction"] == "south"
    # the 2025 data agrees with the plan: 1.36 and 1.41 (each +-0.05), peaks at 15:00 and 11:00
    assert fri["source"]["ratio"] == pytest.approx(1.36, abs=0.05)
    assert sun["source"]["ratio"] == pytest.approx(1.41, abs=0.05)
    assert abs(fri["source"]["peakHour"] - 15) <= 1 and abs(sun["source"]["peakHour"] - 11) <= 1
    # and so does the product (season-weighted)
    assert fri["product"]["ratio"] == pytest.approx(1.36, abs=0.05)
    assert sun["product"]["ratio"] == pytest.approx(1.41, abs=0.05)
    assert abs(fri["product"]["peakHour"] - 15) <= 1 and abs(sun["product"]["peakHour"] - 11) <= 1


def test_real_product_shape():
    if not PRODUCT.exists():
        pytest.skip("run scripts/build_traffic.py lv first")
    d = json.loads(PRODUCT.read_text())
    assert d["version"] == 1 and d["route"] == "i15n" and d["year"] == 2025 and d["tz"] == "America/Los_Angeles"
    assert d["seasons"] == ["winter", "spring", "summer", "autumn"]
    assert d["seasonOfMonth"] == [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0]
    assert d["directions"]["with"]["road"] == "i15n.main" and d["directions"]["against"]["road"] == "i15s.opp"
    for k in ("with", "against"):
        segs = d["directions"][k]["segments"]
        assert segs[0]["s0"] == 0 and segs[-1]["s1"] == 68352
        assert all(a["s1"] == b["s0"] for a, b in zip(segs, segs[1:]))
        for sg in segs:
            assert sg["lanes"] >= 1 and len(sg["laneShares"]) == sg["lanes"] == len(sg["laneSpeedOffsetsMps"])
            assert sum(sg["laneShares"]) == pytest.approx(1, abs=1e-9)
            assert len(sg["flow"]) == 4 and all(len(r) == 168 and min(r) >= 0 for r in sg["flow"])
            assert 0 < sg["truckShare"] < 1 and sg["aadt"] > 0 and sg["capacityVph"] > 0 and sg["freeFlowMps"] > 20
    assert {s["id"] for s in d["sources"]} >= {"tmas", "trina"}
