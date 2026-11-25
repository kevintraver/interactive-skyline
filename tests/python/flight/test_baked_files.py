"""The committed flights (plan 03, 8.2 test_baked_files): schema, sizes, quality gates, provenance, and nothing
that names the aircraft or its operator in what the site serves (assumption A2)."""
import gzip
import json
import re
from pathlib import Path

import numpy as np
import pytest

import bake_flight

ROOT = Path(__file__).resolve().parents[3]
FLIGHTS = ROOT / "public" / "data" / "lv" / "flights"
SELECTION = ROOT / "data" / "flights" / "lv" / "selection.json"


def _selection():
    return json.loads(SELECTION.read_text())["flights"] if SELECTION.exists() else []


def _ids():
    return [f["id"] for f in _selection()]


@pytest.fixture(scope="module")
def index():
    return json.loads((FLIGHTS / "index.json").read_text())


def test_there_is_a_runway_19_flight_by_day(index):
    assert "lv-19-day" in _ids()
    e = next(f for f in index["flights"] if f["id"] == "lv-19-day")
    assert e["runway"] in ("19L", "19R")
    assert e["badges"]["light"] == "day"


@pytest.mark.parametrize("fid", _ids())
def test_header_and_binary_agree(fid):
    head = json.loads((FLIGHTS / f"{fid}.json").read_text())
    assert head["format"] == "skyline-flight/1"
    assert head["channels"] == bake_flight.CHANNELS
    assert set(head["provenance"]) == set(bake_flight.CHANNELS)
    blob = (FLIGHTS / f"{fid}.bin").read_bytes()
    assert len(blob) == head["samples"] * len(head["channels"]) * 4
    data = np.frombuffer(blob, dtype="<f4").reshape(len(head["channels"]), head["samples"])
    assert np.isfinite(data).all()
    ch = dict(zip(head["channels"], data))
    assert head["dt"] == 1.0
    assert 0 <= ch["slat"].min() and ch["slat"].max() <= 2
    assert ch["hdg"].min() >= 0 and ch["hdg"].max() < 360
    lights = ch["lights"].astype(int)
    assert ((lights & 3) == 3).all()  # NAV and BEACON throughout
    ids = [e["id"] for e in head["events"]]
    for need in ("terrain", "ft1000", "threshold", "touchdown", "end"):
        assert need in ids, need
    assert [e["t"] for e in head["events"]] == sorted(e["t"] for e in head["events"])
    # whole flight: from cruise (or the start of the recording) to the end of the surface positions
    assert ids[0] in ("cruise", "start") and ids[-1] == "end"
    assert head["touchdownT"] < head["samples"] - 1


@pytest.mark.parametrize("fid", _ids())
def test_the_quality_gates_pass(fid):
    qa = json.loads((FLIGHTS / f"{fid}.json").read_text())["qa"]
    failed = {k: g["value"] for k, g in qa["gates"].items() if not g["pass"]}
    assert not failed, failed
    assert qa["pass"] is True


@pytest.mark.parametrize("fid", _ids())
def test_the_wheels_are_on_the_runway_at_touchdown(fid):
    head = json.loads((FLIGHTS / f"{fid}.json").read_text())
    airport = json.loads((ROOT / "public" / "data" / "lv" / "airport.json").read_text())
    data = np.frombuffer((FLIGHTS / f"{fid}.bin").read_bytes(), dtype="<f4").reshape(len(head["channels"]), -1)
    ch = dict(zip(head["channels"], data.astype(float)))
    t = np.arange(head["samples"]) * head["dt"]
    td = head["touchdownT"]
    x, n = np.interp(td, t, ch["x"]), np.interp(td, t, ch["n"])
    wheel = np.interp(td, t, ch["h"]) - bake_flight.surface_elevation(airport, np.array([x]), np.array([n]))[0]
    assert abs(wheel) < 0.3
    on = t >= td
    elev = bake_flight.surface_elevation(airport, ch["x"][on], ch["n"][on])
    assert np.abs(ch["h"][on] - elev).max() < 0.05


def test_nothing_served_names_the_aircraft():
    sel = _selection()
    served = [p for p in FLIGHTS.glob("*") if p.is_file()]
    text = "\n".join(p.read_text() for p in served if p.suffix == ".json").lower()
    for f in sel:
        assert f["icao"].lower() not in text
        for extract in [ROOT / "data" / "flights" / "lv" / f["raw"]]:
            files = json.loads(gzip.decompress(extract.read_bytes()))
            for tr in files:
                if tr.get("r"):
                    assert tr["r"].lower() not in text
                for pt in tr["trace"]:
                    st = pt[8] if len(pt) > 8 else None
                    if isinstance(st, dict) and (st.get("flight") or "").strip():
                        assert st["flight"].strip().lower() not in text
    assert not re.search(r'"(icao|registration|callsign|flight_number|operator|airline)"', text)


def test_sizes():
    for p in FLIGHTS.glob("*.bin"):
        assert p.stat().st_size < 400_000, p
    for f in _selection():
        assert (ROOT / "data" / "flights" / "lv" / f["raw"]).stat().st_size < 600_000
    assert (ROOT / "data" / "flights" / "LICENSE").exists()
    # and the served folder carries the ODbL notice itself (the validation of 25 November found it missing)
    notice = (FLIGHTS / "LICENSE").read_text()
    for need in ("adsb.lol", "Open Database License", "ODbL", "share-alike", "https://opendatacommons.org/licenses/odbl/1-0/"):
        assert need.lower() in notice.lower(), need


@pytest.mark.parametrize("fid", _ids())
def test_the_attitude_is_an_airliners_in_degrees(fid):
    """The reported defect ("the aircraft barely pitches or banks"): in the file, pitch and roll are degrees of the
    size a 737 flies. On the final with the landing flap it sits 1 to 4.5 degrees nose up, it touches down 3.5 to
    7.5 degrees nose up, and in a turn of the track it banks as a coordinated turn says."""
    head = json.loads((FLIGHTS / f"{fid}.json").read_text())
    data = np.frombuffer((FLIGHTS / f"{fid}.bin").read_bytes(), dtype="<f4").reshape(len(head["channels"]), -1)
    ch = dict(zip(head["channels"], data.astype(float)))
    td = int(head["touchdownT"])
    final = slice(td - 90, td - 20)
    assert np.all(ch["flap"][final] >= 29.5)
    assert 1.0 <= np.median(ch["pitch"][final]) <= 4.5
    assert 3.5 <= ch["pitch"][td] <= 7.5
    turn = np.degrees(np.gradient(np.unwrap(np.radians(ch["hdg"]))))
    turning = (np.abs(turn) > 1.0) & (np.arange(len(turn)) < td)
    if turning.any():
        expect = np.degrees(np.arctan(ch["tas"][turning] * np.radians(np.abs(turn[turning])) / 9.80665))
        assert np.median(np.abs(ch["roll"][turning])) > 0.5 * np.median(expect)
    assert np.abs(ch["roll"]).max() <= 30.0 + 1e-3
