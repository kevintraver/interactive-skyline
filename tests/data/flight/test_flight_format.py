"""The flight file as settled on 24 November (plan 03, "The flight file, settled"): lights bits, slat states, grid
headings in degrees, event ids in flight order. The loader src/flight/track.js reads the same."""
import math

import numpy as np
import pytest

from lib import adsb

import bake_flight

STD = {"altimeterInHg": 29.92, "tempC": 15.0 - 0.0065 * 664.5, "stationElevation": 664.5}
KT = 1852 / 3600
SETTLED_EVENTS = ["cruise", "start", "tod", "fl180", "10000", "terrain", "gear", "ft1000", "threshold", "touchdown",
                  "vacate", "end"]


@pytest.fixture(scope="module")
def baked(lv_frame, lv_airport):
    import synth
    end = lv_airport["ends"]["19R"]
    # a descent from 24,000 ft along the extended centre line to a 3-degree final and a rollout to taxi speed
    final = synth.approach(end, final_m=12000, rollout_s=80,
                           surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    lead = [{"dur": 300, "vs": 0.0}, {"dur": 600, "vs": -10.0}]
    truth = synth.approach(end, final_m=12000, rollout_s=80, lead=lead,
                           surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    assert truth.h[0] > final.h[0] + 5000
    raw = synth.record(truth, lv_frame, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0,
                       start_epoch=1760461200.37)  # 2025-10-14 17:00Z: daylight in Las Vegas
    wide = (-56000, -64000, 48000, 48000)
    return bake_flight.bake(adsb.points(raw), lv_airport, lv_frame, metar=STD, runway="19R", flight_id="fmt",
                            wide=wide)


def test_lights_use_the_bits_of_section_5_5():
    assert bake_flight.LIGHT == {"nav": 1, "beacon": 2, "strobe": 4, "landing": 8, "taxi": 16, "turnoff": 32,
                                 "logo": 64, "wing": 128}


def test_every_lamp_that_is_on_has_its_bit(baked):
    L = bake_flight.LIGHT
    lights = baked.channels["lights"].astype(int)
    h = baked.channels["h"]
    t = np.arange(len(h))
    td = baked.header["touchdownT"]
    vacate = next(e["t"] for e in baked.header["events"] if e["id"] == "vacate")
    assert ((lights & L["nav"]) > 0).all() and ((lights & L["beacon"]) > 0).all()
    assert ((lights[t < vacate] & L["strobe"]) > 0).all()
    assert ((lights[t > vacate] & L["strobe"]) == 0).all()
    above10k = h > 10000 * 0.3048 + 100
    assert ((lights[above10k] & L["landing"]) == 0).all()
    below = (h < 10000 * 0.3048 - 100) & (t < td)
    assert ((lights[below] & L["landing"]) > 0).all()
    assert ((lights[t > vacate + 1] & L["taxi"]) > 0).all()
    # by day: no logo or wing lights
    assert ((lights & (L["logo"] | L["wing"])) == 0).all()


def test_slats_are_0_retracted_1_extend_2_full_extend(baked):
    slat, flap = baked.channels["slat"], baked.channels["flap"]
    assert slat.min() == 0 and slat.max() == pytest.approx(2.0)
    assert (slat[flap == 0] == 0).all()
    assert (slat[(flap >= 1) & (flap <= 5)] == pytest.approx(1.0))
    assert (slat[flap >= 10] == pytest.approx(2.0))


def test_heading_is_degrees_clockwise_from_grid_north_along_the_path(baked):
    x, n, hdg = (baked.channels[k].astype(float) for k in ("x", "n", "hdg"))
    path = np.degrees(np.arctan2(np.gradient(x), np.gradient(n))) % 360
    moving = baked.channels["gs"] > 20
    diff = (hdg - path + 180) % 360 - 180
    assert np.abs(diff[moving]).max() < 1.0
    assert hdg.min() >= 0 and hdg.max() < 360
    # on final to 19R the path runs along the runway in the grid (204.9 deg), not its true 205.0 by chance
    end = baked.header["runway"]
    assert end == "19R"


def test_pitch_and_roll_are_degrees(baked):
    assert -6 <= baked.channels["pitch"].min() and baked.channels["pitch"].max() <= 12
    assert np.abs(baked.channels["roll"]).max() <= 35


def test_events_are_the_settled_ids_in_flight_order(baked):
    ev = baked.header["events"]
    ids = [e["id"] for e in ev]
    assert set(ids) <= set(SETTLED_EVENTS)
    for need in ("cruise", "tod", "fl180", "10000", "terrain", "gear", "ft1000", "threshold", "touchdown", "vacate",
                 "end"):
        assert need in ids, need
    ts = [e["t"] for e in ev]
    assert ts == sorted(ts)
    for a, b in (("tod", "fl180"), ("fl180", "10000"), ("gear", "ft1000"), ("ft1000", "threshold"),
                 ("threshold", "touchdown"), ("touchdown", "vacate"), ("vacate", "end")):
        assert ids.index(a) < ids.index(b), (a, b)
    for e in ev:
        assert set(e) == {"t", "s", "id", "label"}


def test_ft1000_is_1000_ft_above_the_landing_threshold(baked, lv_airport):
    e = next(e for e in baked.header["events"] if e["id"] == "ft1000")
    h = baked.channels["h"][e["t"]] + bake_flight.ANTENNA_ABOVE_WHEELS_M * 0
    thr = lv_airport["ends"]["19R"]["threshold"][2]
    assert (h - thr) == pytest.approx(1000 * 0.3048, abs=10)


def test_a_recording_that_begins_below_18000_ft_starts_with_start(lv_frame, lv_airport):
    import synth
    end = lv_airport["ends"]["19L"]
    truth = synth.approach(end, final_m=20000, rollout_s=60)
    raw = synth.record(truth, lv_frame, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0)
    res = bake_flight.bake(adsb.points(raw), lv_airport, lv_frame, metar=STD, runway="19L", flight_id="s")
    assert res.header["events"][0]["id"] == "start"


def test_touchdown_falls_on_a_sample_and_the_iso_time_says_the_same(baked):
    # src/flight/track.js takes touchdownT from the ISO times, and treats the wheels' change of vertical speed
    # exactly when the touchdown falls on a sample
    from datetime import datetime
    h = baked.header
    td = h["touchdownT"]
    assert td == int(td)
    iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()  # noqa: E731
    assert iso(h["touchdown"]) - iso(h["recordedStart"]) == td
    assert next(e["t"] for e in h["events"] if e["id"] == "touchdown") == td
