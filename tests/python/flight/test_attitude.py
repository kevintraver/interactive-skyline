"""Air data and attitude (plan 03, F2.4; section 7.2 steps 8 and 9, section 7.3): the standard atmosphere and
airspeeds, wind aloft and at the surface, heading with crab, bank from the turn of the air velocity, weight from the
approach speed, and pitch from the lift model fitted to the reference attitudes."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from lib import attitude as A

KT = 1852 / 3600
FT = 0.3048
FIX = Path(__file__).resolve().parent / "fixtures" / "flights"


# --- the atmosphere and airspeeds ------------------------------------------------------------------------------

def test_standard_atmosphere():
    T, p, rho = A.isa(np.array([0.0, 11000.0, 35000 * FT]))
    assert T[0] == pytest.approx(288.15) and p[0] == pytest.approx(101325, rel=1e-6) and rho[0] == pytest.approx(1.225, abs=1e-3)
    assert T[1] == pytest.approx(216.65, abs=0.01)
    assert rho[2] == pytest.approx(0.3796, abs=0.002)        # the standard table at 35,000 ft


def test_calibrated_airspeed_equals_true_at_sea_level_and_is_far_lower_at_cruise():
    assert A.cas_from_tas(100.0, 0.0) == pytest.approx(100.0, abs=0.01)
    T, _, _ = A.isa(35000 * FT)
    tas = 0.78 * math.sqrt(1.4 * 287.05287 * float(T))
    cas_kt = A.cas_from_tas(tas, 35000 * FT) / KT
    # Mach 0.78 at FL350 is about 262 kt indicated in the type's speed tables
    assert cas_kt == pytest.approx(262, abs=4)
    # a warmer day: the same true airspeed is a lower indicated one
    assert A.cas_from_tas(80.0, 700.0, dT=20.0) < A.cas_from_tas(80.0, 700.0)


def test_mach_number():
    T, _, _ = A.isa(35000 * FT)
    a = math.sqrt(1.4 * 287.05287 * float(T))
    assert A.mach(0.78 * a, 35000 * FT) == pytest.approx(0.78, abs=1e-6)


# --- wind -------------------------------------------------------------------------------------------------------

def test_metar_wind_is_the_air_velocity_toward_where_it_blows():
    # a wind from 270 at 20 kt blows toward the east
    e, n = A.wind_vector(270.0, 20.0)
    assert e == pytest.approx(20 * KT) and n == pytest.approx(0.0, abs=1e-9)


def test_surface_profile_follows_a_power_law_and_holds_above_its_top():
    rows = A.surface_profile(wind_dir=180.0, wind_kt=10.0, temp_c=20.0, station_elev=664.0)
    assert rows[0][0] == pytest.approx(664.0)
    w = lambda h: np.hypot(*A.wind_at(rows, h))  # noqa: E731
    assert w(664.0 + 10) == pytest.approx(10 * KT, rel=0.02)            # the report is the 10 m wind
    assert w(664.0 + 300) == pytest.approx(10 * KT * (300 / 10) ** (1 / 7), rel=0.03)
    assert w(10000.0) == pytest.approx(w(664 + A.POWER_LAW_TOP_M), rel=0.01)
    # the temperature falls at the standard lapse rate
    assert A.temp_at(rows, 664.0 + 1000) == pytest.approx(20.0 - 6.5, abs=0.1)


def test_wind_between_rows_is_interpolated_and_held_beyond_them():
    rows = [[1000, 10, 0.0, 0.0], [3000, 0, 10.0, -4.0]]
    assert A.wind_at(rows, 2000) == pytest.approx((5.0, -2.0))
    assert A.wind_at(rows, 500) == pytest.approx((0.0, 0.0))
    assert A.wind_at(rows, 9000) == pytest.approx((10.0, -4.0))


def test_open_meteo_pressure_levels_become_atmosphere_rows():
    resp = json.loads((FIX / "openmeteo_las_2026-02-16.json").read_text())
    rows = A.rows_from_open_meteo(resp, epoch=1771257891.0)   # 2026-02-16T16:04:51Z
    alts = [r[0] for r in rows]
    assert alts == sorted(alts) and len(rows) >= 8
    assert alts[-1] > 10000                                     # up to cruise
    temps = [r[1] for r in rows]
    assert temps[0] > temps[-1] + 40                            # colder aloft
    for r in rows:
        assert len(r) == 4 and all(math.isfinite(v) for v in r)


def test_the_surface_report_is_blended_in_under_the_upper_air_rows():
    upper = [[1500, 5.0, 10.0, 0.0], [3000, -5.0, 20.0, 0.0], [9000, -40.0, 40.0, 0.0]]
    rows = A.merge_surface(upper, wind_dir=180.0, wind_kt=10.0, temp_c=12.0, station_elev=664.0)
    assert rows[0][0] == pytest.approx(664.0)
    assert rows[0][1] == pytest.approx(12.0)
    assert A.wind_at(rows, 664.0 + 10) == pytest.approx(A.wind_vector(180.0, 10.0), abs=0.2)
    assert A.wind_at(rows, 3000) == pytest.approx((20.0, 0.0))


# --- heading and crab -------------------------------------------------------------------------------------------

def _straight(track_deg, gs, n=200):
    tr = math.radians(track_deg)
    return np.full(n, gs * math.sin(tr)), np.full(n, gs * math.cos(tr))


def test_heading_points_into_a_crosswind_by_the_crab_angle():
    vx, vn = _straight(205.0, 72.0)
    wind = A.wind_vector(295.0, 20.0)        # from the right of a 205 track, straight across
    hdg, crab = A.heading(vx - wind[0], vn - wind[1], vx, vn, t=np.arange(200.0), td=None, air=np.ones(200, bool))
    expect = math.degrees(math.atan2(20 * KT, 72.0))
    assert crab[50] == pytest.approx(expect, abs=0.2)
    assert hdg[50] == pytest.approx(205.0 + expect, abs=0.2)  # nose turned into the wind, to the right


def test_the_crab_is_removed_in_the_last_seconds_and_heading_is_the_track_on_the_ground():
    t = np.arange(200.0)
    vx, vn = _straight(205.0, 72.0)
    wind = A.wind_vector(295.0, 20.0)
    air = t < 150
    hdg, _ = A.heading(vx - wind[0], vn - wind[1], vx, vn, t=t, td=150.0, air=air)
    assert abs(hdg[140] - 205.0) > 5
    assert hdg[150] == pytest.approx(205.0, abs=0.3)
    assert np.allclose(hdg[~air], 205.0, atol=0.01)
    assert np.abs(np.diff(hdg)).max() < 3.0                  # the decrab is a smooth yaw, not a jump


# --- bank -------------------------------------------------------------------------------------------------------

def test_bank_of_a_coordinated_turn():
    t = np.arange(0, 120.0)
    v, rate = 75.0, math.radians(-3.0)       # a standard-rate left turn
    psi = np.where(t < 20, 0.0, np.where(t < 100, rate * (t - 20), rate * 80))
    avx, avn = v * np.sin(psi), v * np.cos(psi)
    bank = A.bank(t, avx, avn, np.full(len(t), v), np.ones(len(t), bool))
    expect = -math.degrees(math.atan(v * abs(rate) / 9.80665))
    assert bank[60] == pytest.approx(expect, abs=0.5)
    assert abs(bank[5]) < 0.5 and abs(bank[115]) < 0.5
    assert np.abs(np.diff(bank)).max() <= 5.0 + 1e-6          # roll rate limited to 5 deg/s


def test_bank_follows_the_air_mass_not_the_ground_track_in_wind():
    # a constant-bank circle in the air mass drifts with the wind: the ground track's turn rate swings, the air's not
    t = np.arange(0, 300.0)
    v, rate = 80.0, math.radians(2.0)
    psi = rate * t
    avx, avn = v * np.sin(psi), v * np.cos(psi)
    we, wn = A.wind_vector(250.0, 40.0)
    gx, gn = avx + we, avn + wn
    bank_air = A.bank(t, avx, avn, np.full(len(t), v), np.ones(len(t), bool))
    # v0's method: the ground track's turn rate with the true airspeed
    bank_gnd = A.bank(t, gx, gn, np.full(len(t), v), np.ones(len(t), bool))
    mid = slice(30, 270)
    assert np.ptp(bank_air[mid]) < 0.5
    assert np.ptp(bank_gnd[mid]) > 4.0


def test_bank_is_limited_to_30_degrees_and_zero_on_the_ground():
    t = np.arange(0, 60.0)
    v, rate = 120.0, math.radians(6.0)
    psi = rate * t
    air = t < 40
    b = A.bank(t, v * np.sin(psi), v * np.cos(psi), np.full(len(t), v), air)
    assert b.max() <= 30.0 + 1e-6
    assert np.all(b[~air][6:] == 0)


# --- weight -----------------------------------------------------------------------------------------------------

def test_reference_speed_table_and_its_inverse():
    assert A.vref_kt(60000, 30) == pytest.approx(142)
    assert A.vref_kt(55000, 40) == pytest.approx(128)
    assert A.weight_for_vref(148, 30) == pytest.approx(65000, abs=1)


def test_weight_from_the_stabilised_approach_speed():
    # flaps 30, calm: approach speed Vref + 5
    assert A.weight_from_approach(147.0, headwind_kt=0.0, gust_kt=0.0, landing_flap=30) == pytest.approx(60000, abs=200)
    # flown on the autothrottle (the default), Boeing's command speed is Vref + 5 whatever the wind
    assert A.weight_from_approach(147.0, headwind_kt=6.0, gust_kt=9.0, landing_flap=30) == pytest.approx(60000, abs=200)
    # by hand, a 20 kt headwind adds half of it to the approach speed
    assert A.weight_from_approach(152.0, headwind_kt=20.0, gust_kt=0.0, landing_flap=30,
                                  autothrottle=False) == pytest.approx(60000, abs=200)
    # nonsense speeds fall back within the type's weights, and no speed gives the default
    assert A.weight_from_approach(250.0, 0, 0, 30) <= A.WEIGHT_MAX
    assert A.weight_from_approach(None, 0, 0, 30) == A.WEIGHT_DEFAULT


# --- pitch ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("ref", A.REFERENCE_ATTITUDES, ids=lambda r: r["case"])
def test_the_lift_model_returns_the_reference_attitudes(ref):
    assert A.reference_pitch(ref) == pytest.approx(ref["pitch"], abs=0.5)


def test_angle_of_attack_constants_are_ordered_by_flap():
    a0 = [A.LIFT[f][0] for f in sorted(A.LIFT)]
    assert a0 == sorted(a0, reverse=True)       # more flap, more lift at the same angle


def _final(flap, ias_kt, n=300, glide=3.0, h0=900.0):
    t = np.arange(float(n))
    h = h0 - ias_kt * KT * math.tan(math.radians(glide)) * t      # near enough for the speed lookup
    tas = A.tas_from_cas(np.full(n, ias_kt * KT), h)
    vz = -tas * math.sin(math.radians(glide))
    return t, tas, vz, h


def test_pitch_on_a_3_degree_final_at_flaps_30_and_40():
    for flap, vapp, expect in ((30, 147, 2.4), (40, 140, 1.4)):
        t, tas, vz, h = _final(flap, vapp, h0=1500)
        p = A.pitch(t, tas, vz, h, flap=np.full(len(t), float(flap)), bank=np.zeros(len(t)), weight=60000.0,
                    air=np.ones(len(t), bool), td=None, dT=0.0)
        assert p[150] == pytest.approx(expect, abs=0.5), flap


def test_the_flare_raises_the_nose_to_a_touchdown_attitude_and_the_nose_comes_down_after():
    t = np.arange(0, 120.0)
    td = 90.0
    tas = np.where(t < td, 147 * KT - np.clip(t - 80, 0, None) * 0.5, 0.0)
    # a 3 degree glide, then the sink rate decays to 0.6 m/s over the last 8 s
    vz = np.where(t < 82, -tas * math.tan(math.radians(3)), -3.9 * np.exp(-(t - 82) / 4.0))
    vz = np.where(t >= td, 0.0, vz)
    gs = np.where(t >= td, np.maximum(75 - 2.0 * (t - td), 10), tas)
    tas = np.where(t >= td, gs, tas)
    h = 700 + np.concatenate([[0], np.cumsum(vz[:-1])])
    p = A.pitch(t, tas, vz, h, flap=np.full(len(t), 30.0), bank=np.zeros(len(t)), weight=60000.0,
                air=t < td, td=td, dT=0.0)
    approach = p[60]
    assert 4.0 <= p[int(td)] <= 7.0
    assert p[int(td)] - approach >= 1.5
    assert p.max() < 11.0                         # no tail strike
    assert p[int(td) + 8] == pytest.approx(0.0, abs=0.05)
    assert np.all(np.diff(p[int(td):int(td) + 10]) <= 1e-6)


def test_pitch_in_the_turn_includes_the_load_factor():
    t, tas, vz, h = _final(30, 147, h0=1500)
    level = A.pitch(t, tas, vz, h, flap=np.full(len(t), 30.0), bank=np.zeros(len(t)), weight=60000.0,
                    air=np.ones(len(t), bool), td=None, dT=0.0)
    banked = A.pitch(t, tas, vz, h, flap=np.full(len(t), 30.0), bank=np.full(len(t), 25.0), weight=60000.0,
                     air=np.ones(len(t), bool), td=None, dT=0.0)
    assert banked[100] > level[100] + 0.8


def test_rms_against_recorded_values_ignores_missing():
    assert A.rms_against(np.array([1.0, 2.0, 3.0]), np.array([1.0, np.nan, 5.0])) == pytest.approx(math.sqrt(2))
    assert A.rms_against(np.zeros(3), np.full(3, np.nan)) is None
    # headings compare the short way round
    assert A.rms_against(np.array([359.0]), np.array([1.0]), angle=True) == pytest.approx(2.0)


def test_a_barometric_vertical_rate_is_scaled_to_a_geometric_one_by_the_temperature_ratio():
    # 20 C warmer than standard at the surface: a pressure altitude changes T/T_isa times slower than the height
    rows = A.surface_profile(wind_dir=None, wind_kt=0, temp_c=15 - 0.0065 * 664 + 20, station_elev=664.0)
    r = A.geometric_rate_factor(rows, np.array([700.0, 1500.0]))
    T_isa, _, _ = A.isa(np.array([700.0, 1500.0]))
    assert r == pytest.approx((T_isa + 20) / T_isa, rel=1e-3)
    assert A.geometric_rate_factor([], np.array([1000.0])) == pytest.approx(1.0)


def test_pitch_does_not_follow_a_short_swing_of_the_derived_airspeed():
    # 8 kt up and back down over 20 s on a stabilised final (unmodelled low-level wind in the derived airspeed)
    t, tas, vz, h = _final(30, 147, h0=1500)
    swing = tas + 8 * KT * np.exp(-((t - 150) / 6.0) ** 2)
    base = A.pitch(t, tas, vz, h, flap=np.full(len(t), 30.0), bank=np.zeros(len(t)), weight=60000.0,
                   air=np.ones(len(t), bool), td=None)
    p = A.pitch(t, swing, vz, h, flap=np.full(len(t), 30.0), bank=np.zeros(len(t)), weight=60000.0,
                air=np.ones(len(t), bool), td=None)
    assert np.abs(p - base).max() < 0.7
