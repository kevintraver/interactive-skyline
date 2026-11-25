"""The NASR codes F4.1 adds to the runway part of airport.json (plan 03): decoded marking, lighting and beacon codes,
per runway and per end, offline against the committed LAS extract."""
import json

import pytest

from lib import nasr

ROOT = __import__("pathlib").Path(__file__).resolve().parents[3]


def test_marking_kinds():
    assert nasr.marking_kind("PIR") == "precision"
    assert nasr.marking_kind("NPI") == "non-precision"
    assert nasr.marking_kind("BSC") == "basic"
    assert nasr.marking_kind("NRS") == "numbers-only"
    assert nasr.marking_kind("") is None


def test_edge_light_intensity():
    assert nasr.light_intensity("HIGH") == "high"
    assert nasr.light_intensity("MED") == "medium"
    assert nasr.light_intensity("LOW") == "low"
    assert nasr.light_intensity("NONE") is None
    assert nasr.light_intensity("") is None


def test_approach_light_systems():
    assert nasr.approach_lights("MALSF") == {"code": "MALSF", "system": "MALS", "lengthFt": 1400, "flashers": True,
                                             "rail": False}
    assert nasr.approach_lights("MALS") == {"code": "MALS", "system": "MALS", "lengthFt": 1400, "flashers": False,
                                            "rail": False}
    m = nasr.approach_lights("MALSR")
    assert (m["system"], m["lengthFt"], m["rail"]) == ("MALS", 2400, True)
    assert nasr.approach_lights("ALSF2")["lengthFt"] == 2400
    assert nasr.approach_lights("ODALS")["lengthFt"] == 1500
    assert nasr.approach_lights("") is None
    assert nasr.approach_lights("NONE") is None


def test_beacon_colours():
    assert nasr.beacon_colours("WG") == ["white", "green"]
    assert nasr.beacon_colours("SWG") == ["white", "white", "green"]  # military: split (two-peaked) white
    assert nasr.beacon_colours("WY") == ["white", "yellow"]
    assert nasr.beacon_colours("") == []


def test_the_runways_carry_the_decoded_codes(lv_airport):
    by_id = {r["id"]: r for r in lv_airport["runways"]}
    assert by_id["01R/19L"]["edgeLightIntensity"] == "medium"
    assert by_id["08R/26L"]["edgeLightIntensity"] == "high"
    assert {k: r["condition"] for k, r in by_id.items()} == {
        "01L/19R": "GOOD", "01R/19L": "GOOD", "08L/26R": "GOOD", "08R/26L": "EXCELLENT"}
    assert {r["pavementType"] for r in by_id.values()} == {"rigid"}
    e = lv_airport["ends"]
    assert {k for k, v in e.items() if v["markingKind"] == "precision"} == {"26L", "26R", "1L"}
    assert e["19R"]["markingKind"] == "non-precision"
    assert e["26L"]["approachLightSystem"]["flashers"] is True
    assert e["26R"]["approachLightSystem"]["flashers"] is False
    assert e["19R"]["approachLightSystem"] is None
    assert e["1L"]["markingCondition"] == "GOOD"
    assert {k for k, v in e.items() if v["rightHandTraffic"]} == {"19R", "1R"}  # as the record has it


def test_the_airport_lighting_and_beacon(lv_airport):
    assert lv_airport["lightingSchedule"] == "SS-SR"
    assert lv_airport["towerType"] == "ATCT"
    assert lv_airport["windIndicator"] == {"code": "Y-L", "lighted": True}
    b = lv_airport["beacon"]
    assert b["colors"] == "WG" and b["schedule"] == "SS-SR"  # v0's fields, unchanged
    assert b["colours"] == ["white", "green"]
    assert b["flashesPerMinute"] == [24, 30]


def test_every_v0_field_is_kept_with_its_value(lv_airport):
    """What other code already reads: every field of the committed v0 runways and ends, with the same value."""
    v0 = json.loads((ROOT / "tests" / "data" / "flight" / "fixtures" / "airport_v0" / "runways.json").read_text())
    for key in ("faa", "icao", "name", "arp", "magneticVariation"):
        assert lv_airport[key] == v0[key], key
    for k, v in v0["beacon"].items():
        assert lv_airport["beacon"][k] == v
    new = {r["id"]: r for r in lv_airport["runways"]}
    for r in v0["runways"]:
        for k, v in r.items():
            assert new[r["id"]][k] == v, (r["id"], k)
    for eid, e in v0["ends"].items():
        for k, v in e.items():
            assert lv_airport["ends"][eid][k] == pytest.approx(v) if isinstance(v, float) else \
                lv_airport["ends"][eid][k] == v, (eid, k)
