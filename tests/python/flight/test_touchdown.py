"""The flare and the wheels (plan 03, 7.2 step 6; 8.2 test_touchdown)."""
import numpy as np
import pytest

from lib import adsb, smooth

import bake_flight

STD = {"altimeterInHg": 29.92, "tempC": 15.0 - 0.0065 * 664.5, "stationElevation": 664.5}


def test_the_flare_profile_reaches_the_runway_at_the_chosen_sink_rate():
    k, y_inf, dur = smooth.flare_profile(8.0, 3.8, 0.7)
    y_end = y_inf + (8.0 - y_inf) * np.exp(-k * dur)
    assert y_end == pytest.approx(0.0, abs=1e-9)
    assert k * (y_end - y_inf) == pytest.approx(0.7)
    assert 3.0 < dur < 6.0


def _check_blend(t, y, vz, t_td, out, info, nominal=True):
    i_e = np.searchsorted(t, info["tf"])                    # first sample at or after the flare's entry
    # above the flare the path is the input, untouched
    assert np.array_equal(out[:i_e], y[:i_e])
    # wheels on the runway at the recorded moment, nothing below it before
    k = int(np.flatnonzero(t == t_td)[0])
    assert out[k] == pytest.approx(0.0, abs=1e-9)
    assert (out[:k] > 0).all()
    if nominal:
        assert info["nominal"] is True
        assert 6.0 <= info["y0"] <= 10.0 and 3.0 <= info["duration"] <= 5.0
        assert 0.3 <= info["tdSink"] <= 1.5
    # the vertical speed is continuous at the entry: the blend leaves with the path's own sink rate
    assert info["sink0"] == pytest.approx(-np.interp(info["tf"], t, vz), abs=1e-6)
    # and the sink only decreases through the flare (sampled finely from the blend itself)
    tt = np.linspace(info["tf"], t_td, 200)
    yy = smooth.flare_curve(info, tt)
    sink = -np.gradient(yy, tt)
    assert np.all(np.diff(sink) <= 1e-6)
    assert sink[-1] == pytest.approx(info["tdSink"], abs=0.05)
    assert yy[0] == pytest.approx(np.interp(info["tf"], t, y), abs=1e-6)
    assert "shift" not in info


def test_the_flare_meets_the_runway_at_the_recorded_moment_without_moving_the_path_above_it():
    # a 3-degree glide at 72 m/s whose straight line would reach the runway 2 s before the recorded transition
    t = np.arange(0, 60.0, 1.0)
    t_td = 50.0
    y = 3.77 * (48.0 - t)
    vz = np.full(len(t), -3.77)
    out, info = smooth.flare_blend(t, y, vz, t_td)
    _check_blend(t, y, vz, t_td, out, info)


def test_the_flare_from_a_path_already_rounding_out():
    # as smoothed on lv-26-night (the recorded vertical rate levels in the last 3 s, the smoother is tied to the
    # runway at the recorded touchdown): 16.0, 11.5, 7.6, 4.3, 1.8 and 0.0 m at 5 to 0 s before touchdown
    t = np.arange(-60.0, 10.0, 1.0)
    known_t = np.array([-60.0, -5, -4, -3, -2, -1, 0, 9])
    known_y = np.array([16.0 + 4.4 * 55, 16.0, 11.5, 7.6, 4.3, 1.8, 0.0, 0.0])
    y = np.interp(t, known_t, known_y)
    vz = np.gradient(y, t)
    out, info = smooth.flare_blend(t, y, vz, 0.0)
    _check_blend(t, y, vz, 0.0, out, info)


def test_a_path_too_high_for_a_nominal_flare_still_lands_on_time_and_says_so():
    # 5 m up at touchdown and barely sinking: no flare of 6 to 10 m in 3 to 5 s fits; the blend still ends on the
    # runway at the recorded moment, never below it, and the info says the fit is outside the nominal ranges
    t = np.arange(-60.0, 10.0, 1.0)
    vz = np.full(len(t), -1.0)
    y = 5.0 - 1.0 * t
    out, info = smooth.flare_blend(t, y, vz, 0.0)
    k = int(np.flatnonzero(t == 0)[0])
    assert info["nominal"] is False
    assert out[k] == pytest.approx(0.0, abs=1e-9) and (out[:k] > 0).all()
    assert np.array_equal(out[:np.searchsorted(t, info["tf"])], y[:np.searchsorted(t, info["tf"])])


def test_the_baked_flight_lands_on_the_runway_at_the_recorded_moment(synthetic, lv_frame, lv_airport):
    end = lv_airport["ends"]["19R"]
    truth = synthetic.approach(end, final_m=20000, rollout_s=60,
                               surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    raw = synthetic.record(truth, lv_frame, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0)
    res = bake_flight.bake(adsb.points(raw), lv_airport, lv_frame, metar=STD, runway="19R", flight_id="t")
    h = res.channels["h"]
    t = res.t_epoch
    td = res.t_epoch[0] + res.header["touchdownT"]
    i = int(np.argmin(np.abs(t - td)))
    rwy = bake_flight.runway_of(lv_airport, "19R")
    elev = bake_flight.surface_elevation(lv_airport, res.channels["x"], res.channels["n"])
    wheel = h - elev
    assert np.interp(td, t, wheel) == pytest.approx(0.0, abs=0.3)
    sink = -np.gradient(h, t)
    assert 0.3 <= sink[i - 1] <= 1.2, sink[i - 3:i + 2]
    assert (wheel > -0.05).all()
    assert rwy["id"] == "01L/19R"
    qa = res.header["qa"]
    assert qa["glidePathDeg"] == pytest.approx(3.0, abs=0.1)            # the synthetic final is 3.00 deg
    assert qa["gates"]["glidePathDeg"]["pass"]
    # the antenna crosses the threshold at the glide's 15 m plus the antenna's height above the wheels
    assert qa["crossingHeightM"] == pytest.approx(15.0 + bake_flight.ANTENNA_ABOVE_WHEELS_M, abs=3.0)
    assert 250 <= qa["touchdownPastThresholdM"] <= 1000
    assert abs(qa["touchdownOffCentreM"]) <= 8


def _no_surface(synthetic, lv_frame, lv_airport, end_id, cut_s):
    end = lv_airport["ends"][end_id]
    truth = synthetic.approach(end, final_m=20000, rollout_s=60,
                               surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    raw = synthetic.record(truth, lv_frame, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0)
    raw["trace"] = [pt for pt in raw["trace"] if pt[0] < truth["touchdown_t"] - cut_s]
    return truth, raw


def test_when_no_surface_position_was_received_the_rollout_is_reconstructed(synthetic, lv_frame, lv_airport):
    # section 7.2 step 7: coverage at Las Vegas usually ends 20 to 60 s before touchdown
    truth, raw = _no_surface(synthetic, lv_frame, lv_airport, "19L", 20)
    res = bake_flight.bake(adsb.points(raw), lv_airport, lv_frame, metar=STD, runway="19L", flight_id="ns")
    head = res.header
    assert head["qa"]["touchdownRecorded"] is False
    whats = " ".join(r["what"] for r in head["reconstructed"])
    assert "rollout" in whats and "touchdown" in whats
    t = res.t_epoch - res.t_epoch[0]
    td = head["touchdownT"]
    assert abs(res.t_epoch[0] + td - (raw["timestamp"] + truth["touchdown_t"])) < 6
    gs = res.channels["gs"]
    after = t > td
    assert gs[after][-1] == pytest.approx(10.0, abs=1.0)            # taxi speed
    assert np.all(np.diff(gs[after]) <= 0.01)
    decel = -np.diff(gs[after])
    assert decel.max() <= 2.0
    elev = bake_flight.surface_elevation(lv_airport, res.channels["x"], res.channels["n"])
    assert np.abs((res.channels["h"] - elev)[after]).max() < 0.05
    along, lat = adsb.runway_coords(lv_airport["ends"]["19L"], res.channels["x"][after], res.channels["n"][after])
    assert np.abs(lat).max() < 8.0
    assert along.max() < next(r["surveyedLength"] for r in lv_airport["runways"] if "19L" in r["ends"])
    assert np.interp(td, t, res.channels["h"] - elev) == pytest.approx(0.0, abs=0.3)


def test_a_transponder_that_says_airborne_until_100_kt_still_lands_where_the_wheels_touched(synthetic, lv_frame,
                                                                                            lv_airport):
    # seen on the selected 737-800: the surface format begins only at 97 kt, 16 s and 1 km after the wheels touched
    end = lv_airport["ends"]["19L"]
    truth = synthetic.approach(end, final_m=20000, rollout_s=80,
                               surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    raw = synthetic.record(truth, lv_frame, every=1, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0,
                           surface_below_kt=100)
    p = adsb.points(raw)
    flag = adsb.find_landings(p, lv_airport, lv_frame)[0]
    assert flag["tFlag"] - (raw["timestamp"] + truth["touchdown_t"]) > 10    # the flag is late
    assert abs(flag["t"] - (raw["timestamp"] + truth["touchdown_t"])) <= 1.5
    res = bake_flight.bake(p, lv_airport, lv_frame, metar=STD, runway="19L", flight_id="late")
    qa = res.header["qa"]
    assert abs(res.t_epoch[0] + res.header["touchdownT"] - (raw["timestamp"] + truth["touchdown_t"])) <= 1.5
    assert qa["touchdownPastThresholdM"] == pytest.approx(truth["touchdown_s"], abs=110)
    assert qa["calibration"]["method"] == "rollout"
    assert qa["calibration"]["offsetM"] == pytest.approx(-28.0, abs=2.0)
    assert qa["touchdownSource"] == "levelled before the surface flag"


def test_stale_heights_on_surface_positions_are_not_used_to_calibrate(synthetic, lv_frame, lv_airport):
    # readsb repeats the last geometric altitude on surface positions, which carry none: here 30 m too low
    end = lv_airport["ends"]["19R"]
    truth = synthetic.approach(end, final_m=20000, rollout_s=60,
                               surface=lambda x, n: bake_flight.surface_elevation(lv_airport, x, n))
    raw = synthetic.record(truth, lv_frame, antenna_m=bake_flight.ANTENNA_ABOVE_WHEELS_M, datum_m=-28.0)
    for pt in raw["trace"]:
        if pt[3] == "ground":
            pt[10] = 2000
    res = bake_flight.bake(adsb.points(raw), lv_airport, lv_frame, metar=STD, runway="19R", flight_id="stale")
    cal = res.header["qa"]["calibration"]
    assert cal["method"] == "barometric"
    assert cal["offsetM"] == pytest.approx(-28.0, abs=3.0)
