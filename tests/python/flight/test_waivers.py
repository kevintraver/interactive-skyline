"""Gate waivers (plan 03, lv-19-dusk): a waiver in selection.json names one gate of one flight, the value measured and
the limit; the bake then passes that gate but marks it waived, in the QA report and the served header. It never
passes another gate, another flight, or a value worse than the one it records."""
import copy
import json
from pathlib import Path

import pytest

import bake_flight

ROOT = Path(__file__).resolve().parents[3]
SEL = ROOT / "data" / "flights" / "lv" / "selection.json"
FLIGHTS = ROOT / "public" / "data" / "lv" / "flights"

GATES = {
    "heightRmsLast60sM": {"value": 3.62, "max": 3.0, "pass": False},
    "decelerationMs2": {"value": 3.7, "max": 3.5, "pass": False},
    "bankDeg": {"value": 20.0, "maxAbs": 35.0, "pass": True},
}
W = {"gate": "heightRmsLast60sM", "value": 3.62, "limit": 3.0, "reason": "noise floor of 25 ft altitudes"}


def test_a_waiver_passes_the_gate_it_names_and_marks_it_waived():
    g = copy.deepcopy(GATES)
    waived = bake_flight.apply_waivers(g, [W])
    assert waived == [W]
    assert g["heightRmsLast60sM"]["pass"] is True and g["heightRmsLast60sM"]["waived"] is True
    assert g["heightRmsLast60sM"]["waiver"]["reason"] == W["reason"]


def test_an_unnamed_failing_gate_still_fails():
    g = copy.deepcopy(GATES)
    bake_flight.apply_waivers(g, [W])
    assert g["decelerationMs2"]["pass"] is False and "waived" not in g["decelerationMs2"]
    assert not all(x["pass"] for x in g.values())


def test_no_waiver_no_change():
    g = copy.deepcopy(GATES)
    assert bake_flight.apply_waivers(g, None) == [] and g == GATES


def test_a_worse_value_than_the_waiver_records_still_fails():
    g = copy.deepcopy(GATES)
    g["heightRmsLast60sM"]["value"] = 3.80
    assert bake_flight.apply_waivers(g, [W]) == []
    assert g["heightRmsLast60sM"]["pass"] is False


def test_a_waiver_must_name_a_real_gate_and_its_limit():
    with pytest.raises(ValueError):
        bake_flight.apply_waivers(copy.deepcopy(GATES), [{**W, "gate": "noSuchGate"}])
    with pytest.raises(ValueError):
        bake_flight.apply_waivers(copy.deepcopy(GATES), [{**W, "limit": 4.0}])
    for k in ("gate", "value", "limit", "reason"):
        with pytest.raises(ValueError):
            bake_flight.apply_waivers(copy.deepcopy(GATES), [{x: v for x, v in W.items() if x != k}])


def test_a_waiver_on_a_gate_that_passes_is_not_recorded_as_waived():
    g = copy.deepcopy(GATES)
    assert bake_flight.apply_waivers(g, [{"gate": "bankDeg", "value": 20.0, "limit": 35.0, "reason": "x"}]) == []
    assert "waived" not in g["bankDeg"]


def test_only_the_flight_that_names_a_waiver_carries_it():
    flights = json.loads(SEL.read_text())["flights"]
    for f in flights:
        head = json.loads((FLIGHTS / f"{f['id']}.json").read_text())
        named = {w["gate"] for w in f.get("waivers", [])}
        marked = {k for k, g in head["qa"]["gates"].items() if g.get("waived")}
        assert marked == named, f["id"]
        assert {w["gate"] for w in head["qa"].get("waived", [])} == named
        qa = json.loads((ROOT / "data" / "flights" / "lv" / "qa" / f"{f['id']}.json").read_text())
        assert {w["gate"] for w in qa.get("waived", [])} == named
        for w in f.get("waivers", []):
            assert w["reason"] and w["limit"] == head["qa"]["gates"][w["gate"]].get("max")
    # lv-19-dusk is the one flight with a waiver, for the one gate
    with_waivers = {f["id"]: [w["gate"] for w in f["waivers"]] for f in flights if f.get("waivers")}
    assert with_waivers == {"lv-19-dusk": ["heightRmsLast60sM"]}


def test_lv_19_dusk_is_the_default_flight_first_in_the_index():
    index = json.loads((FLIGHTS / "index.json").read_text())
    assert index["flights"][0]["id"] == "lv-19-dusk"
    assert index["flights"][0]["badges"]["light"] == "dusk"
