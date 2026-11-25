"""One command bakes every selected flight (plan 03, F2.7): from the committed raw extracts, weather inputs and
published approaches alone, with no network, the bake reproduces the served files and the QA reports byte for byte."""
import json
from pathlib import Path

import pytest

import bake_flight
import bake_flights

ROOT = Path(__file__).resolve().parents[3]
SEL = ROOT / "data" / "flights" / "lv"
OUT = ROOT / "public" / "data" / "lv" / "flights"


@pytest.fixture(scope="module")
def rebaked():
    done, index = bake_flight.bake_selected("lv", offline=True, write=False)
    return done, index


def test_every_selected_flight_has_its_inputs_in_the_repository():
    sel = json.loads((SEL / "selection.json").read_text())
    assert sel["flights"]
    for f in sel["flights"]:
        assert (SEL / f["raw"]).exists(), f["raw"]
        assert (SEL / "weather" / f"{f['id']}.json").exists(), f["id"]
    assert (SEL / "cifp-KLAS.json").exists()


def test_the_bake_reproduces_the_served_files_byte_for_byte(rebaked):
    done, index = rebaked
    for f, baked in done:
        head, blob = bake_flights.served_bytes(baked)
        assert (OUT / f"{f['id']}.json").read_bytes() == head, f["id"]
        assert (OUT / f"{f['id']}.bin").read_bytes() == blob, f["id"]
        qa = (json.dumps(baked.report["qa"], indent=1) + "\n").encode()
        assert (SEL / "qa" / f"{f['id']}.json").read_bytes() == qa, f["id"]
    assert (OUT / "index.json").read_bytes() == (json.dumps(index, indent=1) + "\n").encode()


def test_the_index_lists_every_selected_flight_once(rebaked):
    done, index = rebaked
    ids = [e["id"] for e in index["flights"]]
    assert sorted(ids) == sorted(f["id"] for f, _ in done) and len(ids) == len(set(ids))
    for e in index["flights"]:
        assert e["preview"] is None
        assert set(e) >= {"id", "runway", "aircraftType", "date", "localTime", "touchdown", "duration", "samples",
                          "start", "badges", "header", "data", "preview"}


def test_the_guards_pass(rebaked):
    done, _ = rebaked
    for f, baked in done:
        head, blob = bake_flights.served_bytes(baked)
        assert bake_flights.guards(f, baked, head, blob, SEL) == [], f["id"]
