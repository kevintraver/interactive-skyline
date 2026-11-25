"""public/data/lv/airport.json as built by scripts/build_airport.py (plan 03, F4.1): the acceptance numbers, geometric
sanity, its size, its sources and that the runway fields other code reads are unchanged. Reads the committed file;
rebuild it with `uv run scripts/build_airport.py lv`."""
import json
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from lib import airport_layers as al

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "public" / "data" / "lv" / "airport.json"


@pytest.fixture(scope="module")
def ap():
    return json.loads(PATH.read_text())


def _lights(ap, kind):
    return np.concatenate([np.array(g["xy"]).reshape(-1, 2) for g in ap["lights"] if g["kind"] == kind])


def test_the_file_is_small(ap):
    assert PATH.stat().st_size < 500_000
    assert ap["format"] == "skyline-airport/1"


def test_the_acceptance_numbers(ap):
    # F4.1: 4 runways, 279 taxiway polygons, 23 aprons, about 200 parking positions, 1,339 mapped lights (10 Nov)
    assert len(ap["runways"]) == 4
    assert len(ap["pavement"]["runway"]) == 4
    assert 265 <= len(ap["pavement"]["taxiway"]) <= 295
    assert 21 <= len(ap["pavement"]["apron"]) <= 25
    assert 180 <= len(ap["stands"]) <= 220
    n = sum(len(g["xy"]) // 2 for g in ap["lights"])
    assert 1300 <= n <= 1380


def test_centre_lines_gates_bridges_holds_and_buildings_are_there(ap):
    assert len(ap["taxiways"]) >= 350
    assert sum(1 for t in ap["taxiways"] if t["ref"]) >= 70
    assert len(ap["gates"]) >= 100
    assert len(ap["jetBridges"]) >= 100
    assert len(ap["holdingPositions"]) >= 100
    assert 50 <= len(ap["buildings"]) <= 80
    assert {"terminal", "tower", "hangar"} <= {b["kind"] for b in ap["buildings"]}


def test_every_runway_polygon_contains_its_nasr_centre_line(ap):
    rw = {r["id"]: al.to_polygon(r) for r in ap["pavement"]["runway"]}
    for r in ap["runways"]:
        a, b = (ap["ends"][e]["end"][:2] for e in r["ends"])
        assert rw[r["id"]].buffer(2.0).contains(LineString([a, b])), r["id"]


def test_polygons_are_valid_and_counter_clockwise(ap):
    items = [it for v in ap["pavement"].values() for it in v] + ap["buildings"]
    for it in items:
        assert al.signed_area(it["ring"]) > 0
        assert all(al.signed_area(h) < 0 for h in it.get("holes", []))
        assert al.to_polygon(it).is_valid
    coords = [v for it in items for v in it["ring"]]
    assert all(round(v, 1) == v for v in coords)


def test_every_stand_lies_on_an_apron(ap):
    aprons = unary_union([al.to_polygon(a) for a in ap["pavement"]["apron"]]).buffer(3.0)
    off = [s["ref"] for s in ap["stands"] if not aprons.contains(Point(s["x"], s["y"]))]
    # the stands the FAA's 2025 aprons do not reach are listed in the file, and are few. At Las Vegas (24 Nov 2026)
    # 12 of 197: 11 that OpenStreetMap maps on a strip between two cargo aprons that is bare ground in the 2022
    # photograph and in no FAA apron, and one that stops 4 m past an apron's edge, on pavement in the photograph.
    assert sorted(off, key=str) == sorted(ap["standsOffApron"], key=str)
    assert len(off) <= 0.07 * len(ap["stands"])
    # refs repeat across ramps (several cargo ramps have a stand "5"), so each stand's flag is held to its own stop
    assert all(s["onApron"] == aprons.contains(Point(s["x"], s["y"])) for s in ap["stands"])


def test_mapped_runway_edge_lights_are_at_a_runway_edge(ap):
    rw = [al.to_polygon(r) for r in ap["pavement"]["runway"]]
    xy = _lights(ap, "rwe")
    d = np.array([min(p.exterior.distance(Point(q)) for p in rw) for q in xy])
    assert np.percentile(d, 95) < 5.0
    assert d.max() < 10.0


def test_taxiway_edge_lights_are_near_pavement(ap):
    pav = unary_union([al.to_polygon(t) for k in ("taxiway", "apron", "runway") for t in ap["pavement"][k]])
    xy = _lights(ap, "txe")
    d = np.array([pav.distance(Point(q)) for q in xy])  # 0 on the pavement
    assert np.percentile(d, 95) < 6.0
    assert d.max() < 20.0


def test_buildings_have_heights_and_say_where_from(ap):
    for b in ap["buildings"]:
        assert b["h"] > 0 and b["hSource"] in ("lidar", "dof", "osm-height", "osm-levels", "guess")
        assert 0.0 <= b["cityCover"] <= 1.0
        assert b["inCity"] == (b["cityCover"] >= 0.5)
    lidar = [b for b in ap["buildings"] if b["hSource"] == "lidar"]
    assert len(lidar) >= 0.9 * len(ap["buildings"])
    tower = next(b for b in ap["buildings"] if b["kind"] == "tower")
    assert tower["hSource"] == "dof" and tower["h"] == pytest.approx(370 * 0.3048, abs=0.1)
    # the terminal's south half is outside the city's buildings (plan section 3.2)
    assert any(not b["inCity"] for b in ap["buildings"] if b["kind"] == "terminal")


def test_the_tower_and_the_beacon(ap):
    assert ap["tower"]["heightAgl"] == pytest.approx(112.8, abs=0.1)
    b = ap["beacon"]
    assert b["onTower"] is True and b["z"] == ap["tower"]["topAmsl"]
    assert b["colours"] == ["white", "green"]


def test_every_source_has_its_date_licence_and_credit(ap):
    s = ap["sources"]
    assert set(s) >= {"nasr", "faaAirportMapping", "faaObstacles", "osm", "lidar"}
    for k, v in s.items():
        assert v.get("licence") and v.get("credit"), k
        assert v.get("fetched") or v.get("cycle"), k
    assert s["osm"]["licence"].startswith("ODbL")
    assert isinstance(ap["about"], str) and len(ap["about"]) > 400


def test_the_runway_fields_other_code_reads_are_unchanged(ap):
    v0 = json.loads((ROOT / "tests" / "data" / "flight" / "fixtures" / "airport_v0" / "runways.json").read_text())
    for key in ("faa", "icao", "name", "arp", "magneticVariation"):
        assert ap[key] == v0[key], key
    for k, v in v0["beacon"].items():
        assert ap["beacon"][k] == v
    new = {r["id"]: r for r in ap["runways"]}
    for r in v0["runways"]:
        for k, v in r.items():
            assert new[r["id"]][k] == v, (r["id"], k)
    for eid, e in v0["ends"].items():
        for k, v in e.items():
            assert ap["ends"][eid][k] == v, (eid, k)


def test_no_airport_is_named_in_the_scripts():
    for p in [ROOT / "scripts" / "build_airport.py", *(ROOT / "scripts" / "lib").glob("airport_*.py"),
              ROOT / "scripts" / "lib" / "nasr.py"]:
        text = p.read_text()
        for word in ("KLAS", "'LAS'", '"LAS"', "Harry Reid", "Las Vegas", "36.08", "-115.1"):
            assert word not in text, (p.name, word)
