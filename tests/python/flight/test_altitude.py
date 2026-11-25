"""Heights (plan 03, 7.2 step 4; 8.2 test_altitude): geometric altitude calibrated on the runway, barometric
altitude corrected with the altimeter setting and temperature as the cross-check and fallback."""
import numpy as np
import pytest

from lib import adsb, geodesy

import bake_flight

ANT = bake_flight.ANTENNA_ABOVE_WHEELS_M
STD = {"altimeterInHg": 29.92, "tempC": 15.0 - 0.0065 * 664.5, "stationElevation": 664.5}


def _flight(synth, frame, airport, end, **kw):
    truth = synth.approach(end, final_m=25000, rollout_s=60,
                           surface=lambda x, n: bake_flight.surface_elevation(airport, x, n))
    raw = synth.record(truth, frame, antenna_m=ANT, **kw)
    return truth, adsb.points(raw), raw


def test_a_28_m_datum_offset_comes_back_from_the_rollout(synthetic, lv_frame, lv_airport):
    end = lv_airport["ends"]["19R"]
    # the fresh heights on the runway are the airborne-format positions a transponder sends while rolling above
    # 100 kt; surface positions carry none (readsb repeats a stale one, which the calibration must not use)
    truth, p, raw = _flight(synthetic, lv_frame, lv_airport, end, datum_m=-28.0, surface_below_kt=100,
                            every=2)   # near the airport the archive holds a point every 0.5 to 2 s
    res = bake_flight.bake(p, lv_airport, lv_frame, metar=STD, runway="19R", flight_id="test")
    cal = res.header["qa"]["calibration"]
    assert cal["method"] == "rollout"
    assert cal["offsetM"] == pytest.approx(-28.0, abs=2.0)
    assert cal["datum"] == "ellipsoid"
    t = res.t_epoch - raw["timestamp"]
    h = np.interp(t, truth.t, truth.h)
    ground = np.interp(t, truth.t, truth.ground.astype(float)) > 0.5
    air = ~ground & (t > 10) & (t < truth["touchdown_t"] - 12)   # the flare is modelled, not recorded
    assert np.abs(res.channels["h"][ground] - h[ground]).max() < 2.0
    assert np.sqrt(np.mean((res.channels["h"][air] - h[air]) ** 2)) < 6.0


def test_without_heights_on_the_ground_the_barometer_calibrates(synthetic, lv_frame, lv_airport):
    end = lv_airport["ends"]["19L"]
    truth, p, raw = _flight(synthetic, lv_frame, lv_airport, end, datum_m=-28.0)
    res = bake_flight.bake(p, lv_airport, lv_frame, metar=STD, runway="19L", flight_id="test")
    cal = res.header["qa"]["calibration"]
    assert cal["method"] == "barometric"
    assert cal["offsetM"] == pytest.approx(-28.0, abs=3.0)


def test_a_warm_day_raises_the_true_height_above_the_barometric(synthetic):
    # 1,000 m above a station at 664.5 m, 25 degC warmer than standard: about 9% higher
    pa_ft = (664.5 + 1000) / 0.3048
    cold = geodesy.baro_to_msl(pa_ft, 29.92, 15 - 0.0065 * 664.5, 664.5)
    warm = geodesy.baro_to_msl(pa_ft, 29.92, 15 - 0.0065 * 664.5 + 25, 664.5)
    assert cold == pytest.approx(1664.5, abs=1.0)
    assert warm - cold == pytest.approx(1000 * 25 / (273.15 + 15 - 0.0065 * 664.5), rel=0.15)


def test_the_altimeter_setting_shifts_heights():
    # one hectopascal is about 8.6 m near 600 m
    lo = geodesy.baro_to_msl(2500, 29.92, 10.0, 664.5)
    hi = geodesy.baro_to_msl(2500, 29.92 + 0.02953, 10.0, 664.5)
    assert hi - lo == pytest.approx(8.6, abs=0.6)


def test_the_datum_is_named_from_the_offset():
    assert geodesy.datum_from_offset(-27.0, geoid=-28.1) == "ellipsoid"
    assert geodesy.datum_from_offset(1.5, geoid=-28.1) == "sea level"
    assert geodesy.datum_from_offset(-60.0, geoid=-28.1) == "unknown"
