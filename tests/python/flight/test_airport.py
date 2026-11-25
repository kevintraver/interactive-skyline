"""Runway ends from the FAA NASR rows (plan 03, F1.1), offline against the committed LAS extract."""
import math

import pytest

from lib import nasr


def test_the_fixture_has_the_las_rows(nasr_rows):
    assert [r["ARPT_ID"] for r in nasr_rows["APT_BASE"]] == ["LAS"]
    assert len(nasr_rows["APT_RWY"]) == 4
    assert len(nasr_rows["APT_RWY_END"]) == 8


def test_four_runways_with_their_lengths(lv_airport):
    by_id = {r["id"]: r for r in lv_airport["runways"]}
    assert sorted(by_id) == ["01L/19R", "01R/19L", "08L/26R", "08R/26L"]
    want = {"08L/26R": 4521, "08R/26L": 3208, "01L/19R": 2978, "01R/19L": 2977}
    for rid, metres in want.items():
        assert by_id[rid]["length"] == pytest.approx(metres, abs=2), rid
        assert by_id[rid]["surveyedLength"] == pytest.approx(metres, abs=2), rid


def test_the_19r_landing_threshold(lv_airport):
    thr = lv_airport["ends"]["19R"]["threshold"]
    assert math.hypot(thr[0] - 1373, thr[1] + 1885) < 3
    assert lv_airport["ends"]["19R"]["displacedM"] == pytest.approx(783 * 0.3048, abs=0.01)


def test_the_ends_match_the_plans_table(lv_airport):
    # section 6.3: app x, y of each end (m) and its elevation (m)
    table = {"8L": (137, -4254, 665.4), "26R": (4658, -4248, 619.7), "8R": (1024, -4557, 657.4),
             "26L": (4232, -4553, 624.4), "1L": (219, -4369, 664.8), "19R": (1474, -1668, 634.7),
             "1R": (479, -4489, 663.0), "19L": (1733, -1789, 633.3)}
    for eid, (x, y, z) in table.items():
        e = lv_airport["ends"][eid]["end"]
        assert math.hypot(e[0] - x, e[1] - y) < 3, eid
        assert e[2] == pytest.approx(z, abs=0.1), eid


def test_every_runway_slopes_about_one_percent_down_to_the_north_or_east(lv_airport):
    for rwy in lv_airport["runways"]:
        (s0, z0), (s1, z1) = rwy["profile"][0], rwy["profile"][-1]
        slope = (z1 - z0) / (s1 - s0)
        assert -0.013 < slope < -0.007, rwy["id"]
        low, high = rwy["ends"]
        # profile runs from the first (west or south) end to the second (east or north) end
        assert lv_airport["ends"][low]["end"][2] > lv_airport["ends"][high]["end"][2]


def test_papi_approach_lights_and_alignment(lv_airport):
    e = lv_airport["ends"]
    assert e["19R"]["papi"] == {"type": "PAPI", "lights": 4, "side": "left", "angle": 3.04,
                                "crossingHeightFt": 80, "code": "P4L"}
    assert e["19L"]["papi"]["angle"] == 3.0
    assert e["1L"]["approachLights"] == "MALSF"
    assert e["26R"]["approachLights"] == "MALS"
    assert e["19R"]["approachLights"] is None
    assert e["19R"]["trueHeading"] == 205
    # the landing direction in the app grid is within a degree of true near the origin
    assert abs(e["19R"]["gridHeading"] - 205) < 1.0
    assert abs(e["8L"]["gridHeading"] - 90) < 1.0


def test_elevation_along_a_runway(lv_airport):
    rwy = next(r for r in lv_airport["runways"] if r["id"] == "01L/19R")
    from build_airport import runway_elevation
    mid = rwy["length"] / 2
    z = runway_elevation(rwy, mid)
    assert z == pytest.approx((664.8 + 634.7) / 2, abs=0.2)


def test_vgsi_codes():
    assert nasr.vgsi("P4L") == {"type": "PAPI", "lights": 4, "side": "left"}
    assert nasr.vgsi("P2R") == {"type": "PAPI", "lights": 2, "side": "right"}
    assert nasr.vgsi("V4L")["type"] == "VASI"
    assert nasr.vgsi("") is None


def test_the_current_cycle():
    from datetime import date
    assert nasr.cycle_for(date(2026, 11, 23)) == date(2026, 10, 29)
    assert nasr.cycle_for(date(2026, 11, 26)) == date(2026, 11, 26)
    assert nasr.zip_url(date(2026, 10, 29)).endswith("/29_Oct_2026_APT_CSV.zip")
