"""Air data and attitude for a baked flight (plan 03, F2.4: section 7.2 steps 8 and 9, section 7.3).

Air data. Wind comes from the upper-air archive (Open-Meteo's historical forecast API, GFS pressure levels, one request
per flight, section 6.4) with the airport's surface report (IEM ASOS) blended in underneath; without the archive, the
surface wind on a power-law profile and the standard atmosphere shifted to the surface temperature. The air velocity
is the ground velocity minus the wind; true airspeed is its magnitude, indicated airspeed the calibrated airspeed for
that true airspeed in the local temperature and pressure.

Attitude. Heading is the direction of the air velocity (the crab is the difference from the track), taken off in the
last seconds before touchdown and equal to the track on the ground. Bank is the coordinated-turn bank for the turn
rate of the air velocity, phi = atan(V w / g), limited to 30 degrees and 5 degrees a second. Pitch is the flight-path
angle through the air plus the angle of attack from lift, CL = n W / (q S), alpha = alpha0(flap) + CL / CLalpha, with
the constants fitted so that the model returns the reference attitudes of section 7.3 (REFERENCE_ATTITUDES); the
flare comes out of the flight-path angle going to zero at a nearly constant angle of attack, and the nose comes down
after touchdown.

Wind rows are [altitude m above sea level, temperature degC, wind toward east m/s, wind toward north m/s], the
`atmosphere` rows of the flight header that src/flight/track.js reads. Vectors here are in true-north axes until the
caller turns them into the city grid (see `to_grid`).
"""
import math
from datetime import datetime, timezone

import numpy as np

KT = 1852 / 3600
FT = 0.3048
G = 9.80665
R_AIR = 287.05287
GAMMA = 1.4
T0, P0, RHO0 = 288.15, 101325.0, 1.225
LAPSE = 0.0065
A0 = math.sqrt(GAMMA * R_AIR * T0)
WING_AREA = 124.58           # m2, spec.py WING["area"] [B3]

# --- the atmosphere ---------------------------------------------------------------------------------------------


def isa(h_m, dT=0.0):
    """Temperature (K), pressure (Pa) and density (kg/m3) at geometric height h in the standard atmosphere, with the
    temperature shifted by dT (the pressure is the standard one at that height: good to a few per cent for density)."""
    h = np.asarray(h_m, dtype=float)
    t_isa = np.where(h < 11000, T0 - LAPSE * h, 216.65)
    p = np.where(h < 11000, P0 * (1 - LAPSE * h / T0) ** (G / (R_AIR * LAPSE)),
                 22632.06 * np.exp(-G * (h - 11000) / (R_AIR * 216.65)))
    T = t_isa + dT
    return T, p, p / (R_AIR * T)


def mach(tas, h_m, dT=0.0):
    T, _, _ = isa(h_m, dT)
    return np.asarray(tas, dtype=float) / np.sqrt(GAMMA * R_AIR * T)


def cas_from_tas(tas, h_m, dT=0.0):
    """Calibrated airspeed (m/s) for a true airspeed: the impact pressure of the flow (compressible, subsonic), read
    as a sea-level airspeed. Indicated airspeed is taken equal to it (no position error is known)."""
    T, p, _ = isa(h_m, dT)
    M = np.asarray(tas, dtype=float) / np.sqrt(GAMMA * R_AIR * T)
    qc = p * ((1 + 0.2 * M * M) ** 3.5 - 1)
    out = A0 * np.sqrt(5 * ((qc / P0 + 1) ** (2 / 7) - 1))
    return float(out) if np.ndim(out) == 0 else out


def tas_from_cas(cas, h_m, dT=0.0):
    T, p, _ = isa(h_m, dT)
    qc = P0 * ((1 + 0.2 * (np.asarray(cas, dtype=float) / A0) ** 2) ** 3.5 - 1)
    M = np.sqrt(5 * ((qc / p + 1) ** (2 / 7) - 1))
    out = M * np.sqrt(GAMMA * R_AIR * T)
    return float(out) if np.ndim(out) == 0 else out


# --- wind -------------------------------------------------------------------------------------------------------

POWER_LAW_EXP = 1 / 7        # neutral boundary layer over open ground (the usual engineering exponent)
POWER_LAW_TOP_M = 600.0      # above this the surface wind is held: a profile from one report means little higher
REPORT_HEIGHT_M = 10.0       # the ASOS anemometer


def wind_vector(from_deg, speed_kt):
    """A reported wind (direction it blows from, true; knots) as the air's velocity toward east and north, m/s."""
    if from_deg is None or speed_kt is None:
        return 0.0, 0.0
    v = float(speed_kt) * KT
    a = math.radians(float(from_deg))
    return -v * math.sin(a), -v * math.cos(a)


def surface_profile(wind_dir, wind_kt, temp_c, station_elev, top=12000.0):
    """Rows from one surface report: the wind on a power law to POWER_LAW_TOP_M and held above, the temperature
    falling at the standard lapse rate."""
    we, wn = wind_vector(wind_dir, wind_kt)
    rows = []
    for dz in (0.0, REPORT_HEIGHT_M, 30.0, 100.0, 300.0, POWER_LAW_TOP_M, 2000.0, 5000.0, top - station_elev):
        f = (max(min(dz, POWER_LAW_TOP_M), REPORT_HEIGHT_M) / REPORT_HEIGHT_M) ** POWER_LAW_EXP
        if dz == 0.0:
            f = 1.0
        rows.append([round(station_elev + dz, 1), round(temp_c - LAPSE * dz, 2), round(we * f, 3), round(wn * f, 3)])
    return rows


def wind_at(rows, h):
    """(east, north) wind at a height from atmosphere rows, linear between rows and held beyond them, as the loader
    (src/flight/track.js windAt) reads them."""
    if not rows:
        return (0.0, 0.0)
    r = np.asarray(rows, dtype=float)
    return (float(np.interp(h, r[:, 0], r[:, 2])), float(np.interp(h, r[:, 0], r[:, 3])))


def winds_at(rows, h):
    if not rows:
        return np.zeros(len(h)), np.zeros(len(h))
    r = np.asarray(rows, dtype=float)
    return np.interp(h, r[:, 0], r[:, 2]), np.interp(h, r[:, 0], r[:, 3])


def temp_at(rows, h):
    r = np.asarray(rows, dtype=float)
    hh = np.asarray(h, dtype=float)
    # above the top row, the standard lapse rate (to the tropopause)
    top_h, top_t = r[-1, 0], r[-1, 1]
    above = top_t - LAPSE * (np.minimum(hh, 11000) - top_h)
    out = np.where(hh > top_h, above, np.interp(hh, r[:, 0], r[:, 1]))
    return float(out) if np.ndim(out) == 0 else out


def temp_offset(rows, h):
    """The temperature's difference from the standard atmosphere at each height (K)."""
    t_isa, _, _ = isa(h)
    return temp_at(rows, h) + 273.15 - t_isa


def geometric_rate_factor(rows, h):
    """How much faster a height changes than the pressure altitude at that height: T / T_isa (hypsometric relation;
    1 without a profile). A barometric vertical rate times this is a geometric one."""
    h = np.asarray(h, dtype=float)
    if not rows:
        return np.ones_like(h)
    t_isa, _, _ = isa(h)
    return (temp_at(rows, h) + 273.15) / t_isa


OPEN_METEO = "https://historical-forecast-api.open-meteo.com/v1/forecast"
LEVELS_HPA = (925, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150)


def open_meteo_params(lat, lon, day):
    v = []
    for lev in LEVELS_HPA:
        v += [f"temperature_{lev}hPa", f"wind_speed_{lev}hPa", f"wind_direction_{lev}hPa",
              f"geopotential_height_{lev}hPa"]
    return {"latitude": round(lat, 3), "longitude": round(lon, 3), "start_date": day, "end_date": day,
            "hourly": ",".join(v), "models": "gfs_seamless", "wind_speed_unit": "ms", "timezone": "GMT"}


def rows_from_open_meteo(resp, epoch):
    """Atmosphere rows at an instant from an Open-Meteo hourly pressure-level response: each level's geopotential
    height (taken as height above sea level), temperature and wind, interpolated in time between the hours."""
    h = resp["hourly"]
    times = np.array([datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() for s in h["time"]])
    rows = []
    for lev in LEVELS_HPA:
        keys = [f"geopotential_height_{lev}hPa", f"temperature_{lev}hPa", f"wind_speed_{lev}hPa",
                f"wind_direction_{lev}hPa"]
        if not all(k in h for k in keys):
            continue
        cols = [np.array([np.nan if v is None else v for v in h[k]], dtype=float) for k in keys]
        ok = np.all([np.isfinite(c) for c in cols], axis=0)
        if ok.sum() < 2:
            continue
        z, tc = (float(np.interp(epoch, times[ok], c[ok])) for c in cols[:2])
        # wind as a vector before interpolating in time, so a veer goes the short way
        a = np.radians(cols[3][ok])
        e = float(np.interp(epoch, times[ok], -cols[2][ok] * np.sin(a)))
        n = float(np.interp(epoch, times[ok], -cols[2][ok] * np.cos(a)))
        rows.append([round(z, 1), round(tc, 2), round(e, 3), round(n, 3)])
    rows.sort(key=lambda r: r[0])
    return rows


def merge_surface(upper, wind_dir, wind_kt, temp_c, station_elev):
    """The surface report under the upper-air rows: the power-law profile up to the first upper level that stands
    clear of it (levels below the surface or within POWER_LAW_TOP_M of it are dropped), then the upper rows."""
    above = [r for r in upper if r[0] > station_elev + POWER_LAW_TOP_M]
    surf = [r for r in surface_profile(wind_dir, wind_kt, temp_c, station_elev)
            if r[0] <= station_elev + POWER_LAW_TOP_M]
    return surf + [list(r) for r in above]


def to_grid(e, n, north_bearing_deg):
    """A vector in true-north axes turned into the city grid, where true north lies at `north_bearing_deg`
    (smooth.true_north_bearing)."""
    b = np.radians(north_bearing_deg)
    return e * np.cos(b) + n * np.sin(b), -e * np.sin(b) + n * np.cos(b)


# --- heading and bank -------------------------------------------------------------------------------------------

DECRAB_S = 5.0               # the crab is taken off over the last seconds before the wheels touch (estimate)


def _smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def heading(avx, avn, gvx, gvn, *, t, td, air):
    """Heading (deg, [0, 360)) and crab angle (deg, heading minus track, positive nose right) from the air velocity
    and the ground velocity. The crab goes to zero over DECRAB_S before touchdown; on the ground heading is the
    track (held when nearly stopped)."""
    trk = np.degrees(np.arctan2(gvx, gvn))
    hdg = np.degrees(np.arctan2(avx, avn))
    crab = (hdg - trk + 180) % 360 - 180
    if td is not None:
        crab = crab * (1 - _smoothstep((t - (td - DECRAB_S)) / DECRAB_S))
    crab = np.where(air, crab, 0.0)
    gs = np.hypot(gvx, gvn)
    trk_held = trk.copy()
    slow = gs < 3.0
    if slow.any():
        idx = np.where(~slow, np.arange(len(trk)), 0)
        np.maximum.accumulate(idx, out=idx)
        trk_held = trk[idx]
    return (trk_held + crab) % 360, crab


def _moving_average(y, n):
    if n <= 1:
        return np.asarray(y, dtype=float)
    k = np.ones(n) / n
    pad = n // 2
    return np.convolve(np.pad(y, (pad, n - 1 - pad), mode="edge"), k, mode="valid")


def _rate_limit(y, dt, rate):
    out = np.array(y, dtype=float)
    for i in range(1, len(out)):
        out[i] = out[i - 1] + np.clip(out[i] - out[i - 1], -rate * dt, rate * dt)
    return out


BANK_LIMIT = 30.0            # section 7.3
ROLL_RATE = 5.0              # deg/s, section 7.3


def bank(t, avx, avn, tas, air):
    """Coordinated-turn bank (deg, right wing down positive) from the turn rate of the air velocity."""
    psi = np.unwrap(np.arctan2(avx, avn))
    rate = _moving_average(np.gradient(psi, t), 5)
    phi = np.degrees(np.arctan(np.asarray(tas, dtype=float) * rate / G))
    phi = np.clip(phi, -BANK_LIMIT, BANK_LIMIT)
    phi = np.where(air, phi, 0.0)
    dt = float(np.median(np.diff(t))) if len(t) > 1 else 1.0
    phi = _rate_limit(phi, dt, ROLL_RATE)
    # rate limiting in both directions is symmetric; a short re-average keeps roll in and out smooth
    phi = np.where(air, _moving_average(phi, 3), 0.0)
    return _rate_limit(phi, dt, ROLL_RATE)


# --- weight -----------------------------------------------------------------------------------------------------

# Reference speed (kt) at landing weight, section 7.3's table for the 737-800 (from the type's reference-speed
# tables as publicly reposted, plan [B8]); between and beyond the rows, by the square root of weight.
VREF = {40: ((55000, 128), (60000, 135), (65000, 141)), 30: ((55000, 136), (60000, 142), (65000, 148))}
WEIGHT_DEFAULT = 62000.0     # section 7.3
WEIGHT_MIN, WEIGHT_MAX = 45000.0, 72000.0   # around the 737-800/-900 operating empty and maximum landing weights


def vref_kt(weight, flap):
    rows = VREF[40 if flap >= 35 else 30]
    w = np.array([r[0] for r in rows], dtype=float)
    v = np.array([r[1] for r in rows], dtype=float)
    if weight <= w[0]:
        return float(v[0] * math.sqrt(weight / w[0]))
    if weight >= w[-1]:
        return float(v[-1] * math.sqrt(weight / w[-1]))
    return float(np.interp(weight, w, v))


def weight_for_vref(vref, flap):
    lo, hi = 20000.0, 120000.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if vref_kt(mid, flap) < vref:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def wind_additive_kt(headwind_kt, gust_kt):
    """Boeing's approach-speed additive: half the steady headwind plus the gust, at least 5 kt and at most 20."""
    return float(np.clip(0.5 * max(headwind_kt or 0.0, 0.0) + (gust_kt or 0.0), 5.0, 20.0))


def weight_from_approach(vapp_kt, headwind_kt, gust_kt, landing_flap, autothrottle=True):
    """Landing weight (kg) from the stabilised approach speed: minus the additive gives Vref, and the table gives
    the weight. Default 62 t without a speed; clamped to the type's range.

    On the autothrottle (assumed: the usual airline practice) the additive is 5 kt whatever the wind: Boeing's 737
    crew guidance (FCTM ch. 5, "When using the autothrottle, position command speed to VREF + 5 knots. Sufficient
    wind and gust protection is available with the autothrottle engaged"). By hand it is the wind additive. Section
    7.3 names the wind additive; on gusty evenings it gave weights near the type's empty weight."""
    if vapp_kt is None or not np.isfinite(vapp_kt):
        return WEIGHT_DEFAULT
    vref = vapp_kt - (5.0 if autothrottle else wind_additive_kt(headwind_kt, gust_kt))
    return float(np.clip(weight_for_vref(vref, landing_flap), WEIGHT_MIN, WEIGHT_MAX))


# --- pitch ------------------------------------------------------------------------------------------------------

def _cas_to_eas_q(cas_kt, h_m, dT=0.0):
    """Dynamic pressure (Pa) at a calibrated airspeed and height."""
    tas = tas_from_cas(cas_kt * KT, h_m, dT)
    _, _, rho = isa(h_m, dT)
    return 0.5 * float(rho) * tas * tas, tas


def _ref_cl(ref):
    w = ref["weight"]
    if "mach" in ref:
        T, _, rho = isa(ref["altFt"] * FT)
        tas = ref["mach"] * math.sqrt(GAMMA * R_AIR * float(T))
        q = 0.5 * float(rho) * tas * tas
    else:
        q, tas = _cas_to_eas_q(ref["casKt"], ref["altFt"] * FT)
    gamma = ref.get("gammaDeg")
    if gamma is None:
        gamma = math.degrees(math.asin(-ref["descentFpm"] * FT / 60 / tas)) if ref.get("descentFpm") else 0.0
    cl = w * G * math.cos(math.radians(gamma)) / (q * WING_AREA)
    return cl, gamma


# Section 7.3's pitch attitudes for a 737-800 at 60 t (plan [B8]; recorded with sources in models/aircraft/spec.py
# PERFORMANCE["reference_attitudes"]). Conditions the table leaves open are filled in here, each marked: the
# manoeuvring speeds are the flaps-40 reference speed plus 70 kt clean and 30 kt at flaps 5 (section 7.3), and "on a
# 3 degree path at reference speed + 5" uses the flaps-30 or flaps-40 reference speed at 60 t.
_V40 = 135.0
REFERENCE_ATTITUDES = [
    {"case": "cruise FL350 M0.78", "flap": 0, "weight": 60000.0, "altFt": 35000, "mach": 0.78, "gammaDeg": 0.0,
     "pitch": 2.5, "fit": True},
    {"case": "level clean at Vref40+70", "flap": 0, "weight": 60000.0, "altFt": 5000, "casKt": _V40 + 70,
     "gammaDeg": 0.0, "pitch": 5.0, "fit": True},
    {"case": "level flaps 5 at Vref40+30", "flap": 5, "weight": 60000.0, "altFt": 4000, "casKt": _V40 + 30,
     "gammaDeg": 0.0, "pitch": 6.0, "fit": True},
    {"case": "3 deg path flaps 30 at Vref30+5", "flap": 30, "weight": 60000.0, "altFt": 3000, "casKt": 142 + 5,
     "gammaDeg": -3.0, "pitch": 2.4, "fit": True},
    {"case": "3 deg path flaps 40 at Vref40+5", "flap": 40, "weight": 60000.0, "altFt": 3000, "casKt": _V40 + 5,
     "gammaDeg": -3.0, "pitch": 1.4, "fit": True},
    # not fitted: a check of the clean constants at another condition
    {"case": "idle descent M0.78 at FL350", "flap": 0, "weight": 60000.0, "altFt": 35000, "mach": 0.78,
     "descentFpm": 2200, "pitch": 0.0, "fit": False},
]


def fit_lift(refs=REFERENCE_ATTITUDES):
    """alpha0 (deg) per fitted flap setting and one lift-curve slope CLalpha (per deg) from the reference attitudes:
    the slope from the two clean references, each flap setting's alpha0 from its own reference."""
    clean = [r for r in refs if r["fit"] and r["flap"] == 0]
    (c1, g1), (c2, g2) = (_ref_cl(r) for r in clean[:2])
    a1, a2 = clean[0]["pitch"] - g1, clean[1]["pitch"] - g2
    cla = (c2 - c1) / (a2 - a1)
    out = {}
    for r in refs:
        if not r["fit"]:
            continue
        cl, g = _ref_cl(r)
        out.setdefault(r["flap"], round(r["pitch"] - g - cl / cla, 4))
    return out, cla


LIFT_ALPHA0, CL_ALPHA = fit_lift()
LIFT = {f: (a0, CL_ALPHA) for f, a0 in LIFT_ALPHA0.items()}
# Lever position -> main-flap surface angle (spec.py FLAPS["detents"], ESTIMATED): alpha0 is interpolated in the
# surface angle between the fitted settings, so flaps 1, 2, 10, 15 and 25 and the surfaces in travel get a value
# between their neighbours' (an estimate: no reference attitude exists for them).
_DETENT_ANGLE = ((0, 0.0), (1, 1.0), (2, 2.0), (5, 5.0), (10, 8.0), (15, 11.0), (25, 17.0), (30, 20.0), (40, 25.0))


def _surface(flap):
    d = np.array(_DETENT_ANGLE, dtype=float)
    return np.interp(flap, d[:, 0], d[:, 1])


def alpha0(flap):
    fl = sorted(LIFT_ALPHA0)
    xs = _surface(np.array(fl, dtype=float))
    return np.interp(_surface(np.asarray(flap, dtype=float)), xs, [LIFT_ALPHA0[f] for f in fl])


def angle_of_attack(cl, flap):
    return alpha0(flap) + np.asarray(cl) / CL_ALPHA


def reference_pitch(ref):
    cl, gamma = _ref_cl(ref)
    return float(gamma + angle_of_attack(cl, ref["flap"]))


FLARE_FROM_M = 20 * FT       # section 7.3: the flare begins at about 20 ft of wheel height
FLARE_RAISE_MAX = 3.0        # by raising the nose 2 to 3 degrees (section 7.3, [B8])
LIFT_AVERAGE_S = 41          # s (estimate): centred, so a steady deceleration is unchanged
DEROTATE_S = 5.0             # nose wheel down over this long after the main wheels touch (estimate, B8: 4 to 8 s flare)
PITCH_LIMITS = (-6.0, 12.0)  # section 7.2's gate
TAIL_STRIKE = 11.0           # section 7.3


def pitch(t, tas, vz_air, h, *, flap, bank, weight, air, td, dT=0.0, hagl=None):
    """Pitch attitude (deg, nose up positive): flight-path angle through the air plus the angle of attack from lift.
    `tas` is the true airspeed (m/s, horizontal part when vz_air is given separately is fine at these angles),
    `vz_air` the vertical speed (m/s), `bank` in degrees, `dT` the temperature offset from ISA (scalar or per
    sample), `hagl` the wheel height above the runway (m) if known. In the flare (from FLARE_FROM_M of wheel height,
    or the last 8 s without `hagl`) the nose rises by no more than FLARE_RAISE_MAX over its attitude at the flare's
    start: the lift model alone would also count the ground effect and the float as angle of attack. After
    touchdown the nose comes down to 0 (the body level on its gear; the ground attitude of the model
    is the app's) over DEROTATE_S."""
    tas = np.maximum(np.asarray(tas, dtype=float), 1.0)
    vz_air = np.asarray(vz_air, dtype=float)
    # the lift sees the airspeed averaged over LIFT_AVERAGE_S: short swings of the derived airspeed are mostly the
    # low-level wind the profile does not know, and a gust the aircraft rides changes its load, not its attitude
    # (airborne samples only: the rollout's falling speed must not reach back into the final)
    air_b = np.asarray(air, bool)
    tas_q = tas.copy()
    if air_b.sum() >= LIFT_AVERAGE_S:
        tas_q[air_b] = _moving_average(tas[air_b], LIFT_AVERAGE_S)
    _, _, rho = isa(h, dT)
    v_h = np.sqrt(np.maximum(tas**2 - vz_air**2, 1.0))
    gamma = np.degrees(np.arctan2(vz_air, v_h))
    q = 0.5 * rho * tas_q**2
    n = np.cos(np.radians(gamma)) / np.cos(np.radians(np.clip(bank, -60, 60)))
    cl = n * weight * G / (q * WING_AREA)
    alpha = angle_of_attack(cl, flap)
    p = gamma + alpha
    p = np.where(air, p, 0.0)
    if td is not None:
        before = np.flatnonzero(np.asarray(air) & (t < td))
        if len(before):
            if hagl is not None:
                high = np.flatnonzero(np.asarray(air) & (t < td) & (np.asarray(hagl) >= FLARE_FROM_M))
                k0 = int(high[-1]) if len(high) else int(before[0])
            else:
                k0 = int(np.searchsorted(t, td - 8.0))
            flare = (np.arange(len(p)) > k0) & np.asarray(air)
            p = np.where(flare, np.minimum(p, p[k0] + FLARE_RAISE_MAX), p)
        k = np.flatnonzero(np.asarray(air))
        p_td = float(p[k[-1]]) if len(k) else 0.0
        after = ~np.asarray(air)
        derot = 1 - _smoothstep((t - td) / DEROTATE_S)
        p = np.where(after & (t >= td), p_td * derot, p)
    return np.clip(p, PITCH_LIMITS[0], min(PITCH_LIMITS[1], TAIL_STRIKE - 0.5))


# --- comparison with what the trace recorded --------------------------------------------------------------------

def rms_against(model, recorded, angle=False):
    """RMS of model minus recorded where recorded is present (None if nothing is); angles the short way round."""
    m = np.isfinite(recorded) & np.isfinite(model)
    if not m.any():
        return None
    d = np.asarray(model)[m] - np.asarray(recorded)[m]
    if angle:
        d = (d + 180) % 360 - 180
    return float(np.sqrt(np.mean(d * d)))
