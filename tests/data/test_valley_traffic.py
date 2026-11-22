"""D6.6: traffic on the rest of the valley (scripts/lib/valley_traffic.py) on small fixtures."""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from lib import valley_traffic as V  # noqa: E402

# a flat frame: one degree is 1000 m (lon -> x east, lat -> y north)
FRAME = SimpleNamespace(to_local=lambda lat, lon: (np.asarray(lon, float) * 1000.0, np.asarray(lat, float) * 1000.0))
BOUNDS = (-10000.0, -10000.0, 10000.0, 10000.0)


def osm_doc(ways):
    """ways: [(id, tags, [(lat, lon), ...])] -> an Overpass document."""
    els, nid = [], 1
    for wid, tags, pts in ways:
        ids = []
        for lat, lon in pts:
            els.append({"type": "node", "id": nid, "lat": lat, "lon": lon})
            ids.append(nid)
            nid += 1
        els.append({"type": "way", "id": wid, "nodes": ids, "tags": tags})
    return {"elements": els}


def trina_doc(stations):
    return {"features": [{"attributes": {"Name": n, "ROUTE_NAME": r, "LOCATION_D": loc, "StationType": "ShortTerm",
                                         "LAT_DECIMAL": lat, "LON_DECIMAL": lon, "AADT_2025": aadt}}
                         for n, r, loc, lat, lon, aadt in stations]}


def flat_shapes():
    week = np.ones(168)
    out = []
    for i, (d, kind, x, y) in enumerate([(1, "arterial", 0, 0), (5, "arterial", 0, 0), (3, "arterial", 0, 0),
                                         (7, "arterial", 0, 0), (1, "freeway", 0, 0), (5, "freeway", 0, 0),
                                         (3, "freeway", 0, 0), (7, "freeway", 0, 0)]):
        out.append({"id": i, "station": f"00{i}", "dir": d, "kind": kind, "x": x, "y": y, "location": "", "meanDay": 1.0,
                    "values": week / (week.sum() / 7)})
    return out


def test_name_and_ref_keys():
    assert V.name_key("East Lake Mead Boulevard North") == "lake mead blvd"
    assert V.name_key("Saint Rose Parkway") == "st rose pkwy"
    assert V.trina_keys("SR159 (Charleston Blvd)") == {"SR159", "charleston blvd"}
    assert V.trina_keys("IR515, US95") == {"IR515", "US95"}
    assert V.osm_ref_keys("I 15;US 93") == {"IR15", "US93"}
    assert V.osm_ref_keys("US 95 Business") == set()  # another road than US-95
    assert "charleston blvd" in V.way_keys({"name": "West Charleston Boulevard", "ref": "SR 159"})


def test_station_matching_by_name_and_distance():
    # two parallel east-west roads 60 m apart, and a north-south one crossing them
    doc = osm_doc([
        (1, {"highway": "primary", "name": "West Flamingo Road"}, [(0.0, -2.0), (0.0, 2.0)]),
        (2, {"highway": "primary", "name": "West Harmon Avenue"}, [(0.06, -2.0), (0.06, 2.0)]),
        (3, {"highway": "secondary", "name": "South Decatur Boulevard"}, [(-2.0, 0.5), (2.0, 0.5)]),
        (4, {"highway": "motorway", "ref": "CC 215", "name": "Bruce Woodbury Beltway", "oneway": "yes"}, [(-0.03, -2.0), (-0.03, 2.0)]),
    ])
    st = V.trina_points(trina_doc([
        ("A", "Flamingo Rd", "300ft W of Decatur Blvd", 0.035, 0.2, 40000),  # nearer Harmon (25 m) than Flamingo (35 m)
        ("B", "Decatur Blvd", "200ft N of Flamingo Rd", 0.8, 0.52, 30000),
        ("C", "CC215", "btwn exits", -0.03, -1.0, 90000),
        ("D", "IR215", "EB on-ramp to Decatur", 0.0, 1.0, 5000),  # a ramp: left out
        ("E", "CC215", "btwn exits", 0.0, -1.5, 80000),          # a freeway count beside an arterial: never onto it
    ]), FRAME, 2025)
    assert [s["id"] for s in st] == ["A", "B", "C", "E"]
    ways = V.osm_ways(doc, FRAME)
    snapped = V.snap_stations(st, ways)
    by = {st[i]["id"]: ways[w]["id"] for i, (w, _) in snapped.items()}
    assert by["A"] == 1  # by name, not the nearer Harmon Avenue
    assert by["B"] == 3
    assert by["C"] == 4
    assert by["E"] == 4  # the beltway (30 m away), not Flamingo Road (0 m): names must agree

    res = V.build(ways, st, flat_shapes(), [], BOUNDS)
    flam = [p for p in res["pieces"] if p["name"] == "West Flamingo Road"]
    assert flam and all(p["station"] is not None and st[p["station"]]["id"] == "A" for p in flam)
    assert all(p["fwd"] == 20000 and p["bwd"] == 20000 for p in flam)
    harmon = [p for p in res["pieces"] if p["name"] == "West Harmon Avenue"]
    assert harmon and all(p["assumed"] and p["fwd"] == V.CLASS_DEFAULT_AADT["primary"] / 2 for p in harmon)
    beltway = [p for p in res["pieces"] if p["cls"] == "motorway"]
    assert all(p["oneway"] and p["bwd"] == 0 for p in beltway)
    # secondary roads only where a station counts them: Decatur has B
    assert any(p["name"] == "South Decatur Boulevard" for p in res["pieces"])


def test_secondary_without_a_station_is_left_out():
    doc = osm_doc([(1, {"highway": "secondary", "name": "Quiet Street"}, [(0.0, -1.0), (0.0, 1.0)])])
    res = V.build(V.osm_ways(doc, FRAME), [], flat_shapes(), [], BOUNDS)
    assert res["pieces"] == []


def test_driven_routes_are_left_out():
    # a freeway whose middle 2 km is a driven carriageway, and a street crossing it
    doc = osm_doc([
        (1, {"highway": "motorway", "ref": "I 15", "oneway": "yes"}, [(-3.0, 0.0), (3.0, 0.0)]),
        (2, {"highway": "primary", "name": "Tropicana Avenue"}, [(0.0, -3.0), (0.0, 3.0)]),
    ])
    driven = [{"id": "route:main", "xy": np.array([[0.0, -1000.0], [0.0, 1000.0]]) + [8.0, 0.0]}]
    res = V.build(V.osm_ways(doc, FRAME), [], flat_shapes(), driven, BOUNDS)
    fw = [p for p in res["pieces"] if p["cls"] == "motorway"]
    assert fw, "the freeway outside the driven stretch stays"
    for p in fw:
        # nothing of the freeway within the driven stretch
        inside = (np.abs(p["xy"][:, 1]) < 1000 - V.DRIVEN_NEAR_M - V.DENSIFY_M)
        assert not inside.any()
    assert sum(p["length"] for p in fw) == pytest.approx(4000, abs=150)
    cross = [p for p in res["pieces"] if p["name"] == "Tropicana Avenue"]
    assert sum(p["length"] for p in cross) == pytest.approx(6000, abs=5)  # crossing it: kept whole
    assert res["cutM"]["motorway"] == pytest.approx(2000, abs=150)


def test_shapes_sum_to_their_daily_volumes():
    rng = np.random.default_rng(3)
    flow = rng.uniform(50, 3000, size=(4, 168))
    flow[3] = np.nan  # autumn not counted
    means = {("035440", 1): {"flow": flow, "covered": [True, True, True, False]},
             ("035441", 1): {"flow": flow, "covered": [True, False, False, False]}}  # one season: left out
    stations = {k: {"x": 0.0, "y": 0.0, "f_system": "14", "location": ""} for k in means}
    w = np.array([0.25, 0.25, 0.25, 0.25])
    shapes = V.make_shapes(stations, means, w)
    assert len(shapes) == 1
    s = shapes[0]
    assert s["values"].sum() / 7 == pytest.approx(1, abs=1e-12)
    assert s["kind"] == "arterial"
    # a road of daily volume Q carries Q x 7 vehicles a week, and the shape keeps the station's week
    q = 34567.0
    assert (q * s["values"]).sum() == pytest.approx(7 * q, rel=1e-12)
    week = np.mean(flow[:3], axis=0)
    assert s["meanDay"] == pytest.approx(week.sum() / 7, rel=1e-12)
    assert np.allclose(s["values"] * s["meanDay"], week)


def test_encode_decode_round_trip():
    doc = osm_doc([(1, {"highway": "primary", "name": "West Flamingo Road", "lanes": "6", "maxspeed": "45 mph"},
                    [(0.0, -2.0), (0.01, 0.0), (0.0, 2.0)])])
    st = V.trina_points(trina_doc([("A", "Flamingo Rd", "x", 0.0, 0.2, 40000)]), FRAME, 2025)
    res = V.build(V.osm_ways(doc, FRAME), st, flat_shapes(), [], BOUNDS)
    jdoc, blob = V.encode(res, {"city": "t", "year": 2025, "tz": "America/Los_Angeles"})
    back = V.decode(jdoc, blob)
    assert len(back) == len(res["pieces"])
    for a, b in zip(res["pieces"], back):
        assert np.max(np.abs(a["xy"] - b["xy"])) <= V.QUANTUM / 2 + 1e-9
        assert b["fwd"] == 20000 and b["bwd"] == 20000 and b["lanes"] == 3 and b["kmh"] == 72
        assert b["name"] == "West Flamingo Road"
        assert jdoc["stations"][b["station"]]["id"] == "A"
