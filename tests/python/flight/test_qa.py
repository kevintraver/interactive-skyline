"""The procedure check and the QA report (plan 03, F2.6): the published approaches read from the FAA's CIFP, the
flown final compared with them, and the report written for every selected flight."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from lib import cifp, qa

import bake_flight

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIX = HERE / "fixtures" / "flights" / "cifp_klas_2611.txt"
SELECTION = ROOT / "data" / "flights" / "lv" / "selection.json"


@pytest.fixture(scope="module")
def klas():
    lines = FIX.read_text().splitlines()
    own, fixes = cifp.airport_lines(lines, "KLAS")
    apps, rwys = cifp.approaches(own, fixes)
    return {"approaches": apps, "runways": rwys, "cycle": "2611"}


def test_runway_records(klas):
    r = klas["runways"]["19R"]
    assert r["thresholdElevationFt"] == 2089 and r["displacedFt"] == 783
    assert r["lat"] == pytest.approx(36.09771, abs=1e-4) and r["lon"] == pytest.approx(-115.15755, abs=1e-4)


def test_the_approaches_of_the_four_landing_ends(klas):
    by_end = {}
    for proc, a in klas["approaches"].items():
        by_end.setdefault(a["runway"], {})[proc] = a
    # 19R: the RNP with its curved final (75 ft crossing height) and the RNAV (GPS) straight in, both 3.24 degrees
    assert by_end["19R"]["H19RZ"]["glidePathDeg"] == 3.24 and by_end["19R"]["H19RZ"]["crossingHeightFt"] == 75
    assert by_end["19R"]["R19RY"]["glidePathDeg"] == 3.24 and by_end["19R"]["R19RY"]["crossingHeightFt"] == 60
    assert by_end["19R"]["H19RZ"]["lastFix"] == "CEGIL"
    # 19L: the RNP and the RNAV (GPS), whose missed approach point is a fix (read from its FAS data block)
    assert {a["glidePathDeg"] for a in by_end["19L"].values()} == {3.0}
    assert "R19LY" in by_end["19L"] and by_end["19L"]["R19LY"]["fas"]["tchFt"] == 60
    assert {a["glidePathDeg"] for a in by_end["26L"].values()} == {3.0}
    assert {a["glidePathDeg"] for a in by_end["26R"].values()} == {3.0}
    assert by_end["26L"]["I26LZ"]["type"] == "ILS"


def test_final_approach_courses_run_along_the_runways(klas):
    for proc, a in klas["approaches"].items():
        if a["runway"] in ("19R", "19L"):
            assert a["finalCourseTrue"] == pytest.approx(205.0, abs=0.5), proc
        if a["runway"] in ("26L", "26R"):
            assert a["finalCourseTrue"] == pytest.approx(270.0, abs=0.5), proc


def test_the_bakes_published_angles_agree_with_cifp(klas, lv_airport):
    for end_id in ("19R", "19L", "26L", "26R"):
        cifp_angles = {a["glidePathDeg"] for a in klas["approaches"].values() if a["runway"] == end_id}
        assert set(bake_flight.PUBLISHED[end_id]["angles"]) <= cifp_angles, end_id
    # with the PAPI, 19R offers 3.04 and 3.24 (section 7.2)
    end = {"papi": {"angle": 3.04, "crossingHeightFt": 80}}
    assert qa.published_angles("19R", klas, end) == [3.04, 3.24]


def _final(end, offset_deg=0.0, n=200):
    hd = math.radians(end["gridHeading"] + offset_deg)
    thr = np.array(end["threshold"][:2])
    d = np.linspace(-4000, 0, n)
    return thr[0] + d * math.sin(hd), thr[1] + d * math.cos(hd)


def test_the_flown_final_course(lv_airport):
    end = lv_airport["ends"]["26L"]
    x, n = _final(end)
    assert qa.flown_final_course(x, n, end) == pytest.approx(end["gridHeading"], abs=0.01)
    x, n = _final(end, 2.0)
    assert qa.flown_final_course(x, n, end) == pytest.approx(end["gridHeading"] + 2.0, abs=0.05)


def _header(end_id, gp, tch=20.0):
    return {"id": "t", "runway": end_id, "touchdown": "2026-01-01T00:00:00Z", "recordedStart": "2026-01-01T00:00:00Z",
            "samples": 10, "qa": {"glidePathDeg": gp, "crossingHeightM": tch, "altitudeOffsetM": -28.0,
                                  "datum": "ellipsoid", "calibration": {"method": "rollout"},
                                  "gates": {"a": {"value": 1, "pass": True}}}}


def test_procedure_check_passes_within_0_35_degrees(klas, lv_airport):
    end = lv_airport["ends"]["26L"]
    x, n = _final(end)
    ok = qa.procedure_check(_header("26L", 3.10), {"x": x, "n": n}, end, klas, 0.0)
    assert ok["nearestPublishedDeg"] == 3.0 and ok["pass"] and not ok["warn"]
    warn = qa.procedure_check(_header("26L", 3.25), {"x": x, "n": n}, end, klas, 0.0)
    assert warn["pass"] and warn["warn"]
    bad = qa.procedure_check(_header("26L", 3.5), {"x": x, "n": n}, end, klas, 0.0)
    assert not bad["pass"]
    i26 = next(r for r in ok["published"] if r["source"] == "CIFP I26LZ")
    assert abs(i26["courseDiffDeg"]) < 0.6 and i26["crossingHeightDiffFt"] == pytest.approx(20 / 0.3048 - 60, abs=0.1)


def test_the_report_records_the_calibration_and_every_gate(klas, lv_airport):
    end = lv_airport["ends"]["26L"]
    x, n = _final(end)
    r = qa.report(_header("26L", 3.0), {"x": x, "n": n}, end, klas, 0.0)
    assert r["calibration"]["offsetM"] == -28.0 and r["calibration"]["datum"] == "ellipsoid"
    assert r["gates"] == {"a": {"value": 1, "pass": True}}
    assert r["procedure"]["pass"] and r["pass"]


def _selected():
    return json.loads(SELECTION.read_text())["flights"] if SELECTION.exists() else []


@pytest.mark.parametrize("f", _selected(), ids=lambda f: f["id"])
def test_every_selected_flight_has_a_passing_report(f):
    path = ROOT / "data" / "flights" / "lv" / "qa" / f"{f['id']}.json"
    rep = json.loads(path.read_text())
    assert rep["id"] == f["id"] and rep["runway"] == f["runway"]
    assert rep["procedure"]["pass"], rep["procedure"]
    assert abs(rep["procedure"]["diffDeg"]) <= 0.35
    assert "offsetM" in rep["calibration"] and rep["calibration"]["datum"]
    for k, g in rep["gates"].items():
        assert "value" in g and "pass" in g, k
    assert rep["pass"]
    text = path.read_text().lower()
    assert f["icao"].lower() not in text
