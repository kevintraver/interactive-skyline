"""The served track against the recording, and the QA gates against the served track (the validation of plan 03,
docs/validation/03-window-seat-flight.md section 4: the flare fit once lowered the served wheels by up to 10.75 m over
the last 90 s while the gates measured the path before that shift).

Heights are read from each committed .bin the way the app reads them (src/flight/track.js: monotone cubic Hermite
between 1 Hz samples, with the vertical speed's break at a touchdown that falls on a sample), and compared with the
raw trace's geometric heights, calibrated as the QA file says. Every gate in a header's QA block is then recomputed
here, independently of the bake, from the served arrays and the raw observations."""
import gzip
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from lib import adsb, smooth
from lib.frame import create_frame

import bake_flight

ROOT = Path(__file__).resolve().parents[3]
FLIGHTS = ROOT / "public" / "data" / "lv" / "flights"
SEL = ROOT / "data" / "flights" / "lv"
ANT = bake_flight.ANTENNA_ABOVE_WHEELS_M


def _selection():
    return json.loads((SEL / "selection.json").read_text())["flights"]


def _iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


# --- the app's decoding of h (src/flight/track.js) ---------------------------------------------------------------

def _monotone_tangents(v, dt=1.0):
    n = len(v)
    d = np.diff(v) / dt
    m = np.empty(n)
    m[0], m[-1] = d[0], d[-1]
    m[1:-1] = (d[:-1] + d[1:]) / 2
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        if a < 0:
            m[i] = 0.0
        if b < 0:
            m[i + 1] = 0.0
        r = a * a + b * b
        if r > 9:
            k = 3 / math.sqrt(r)
            m[i], m[i + 1] = k * a * d[i], k * b * d[i]
    return m


class AppHeight:
    """h(t) as the app samples it."""

    def __init__(self, h, touchdown_t, dt=1.0):
        self.v = np.asarray(h, dtype=np.float64)
        self.m = _monotone_tangents(self.v, dt)
        self.dt = dt
        n = len(self.v)
        k = int(round(touchdown_t / dt))
        self.brk = None
        if 0 < k < n - 1 and abs(touchdown_t - k * dt) < 1e-6:
            self.brk = (k, (self.v[k] - self.v[k - 1]) / dt, (self.v[k + 1] - self.v[k]) / dt)

    def __call__(self, t):
        t = np.atleast_1d(np.asarray(t, dtype=float))
        n = len(self.v)
        tc = np.clip(t, 0, (n - 1) * self.dt)
        i = np.minimum((tc // self.dt).astype(int), n - 2)
        u = (tc - i * self.dt) / self.dt
        m0, m1 = self.m[i].copy(), self.m[i + 1].copy()
        if self.brk:
            k, before, after = self.brk
            m0 = np.where(i == k, after, m0)
            m1 = np.where(i + 1 == k, before, m1)
        u2, u3 = u * u, u * u * u
        return ((2 * u3 - 3 * u2 + 1) * self.v[i] + (u3 - 2 * u2 + u) * self.dt * m0
                + (-2 * u3 + 3 * u2) * self.v[i + 1] + (u3 - u2) * self.dt * m1)


# --- a flight as served, with its raw observations ---------------------------------------------------------------

class Served:
    def __init__(self, f, frame, airport):
        self.f = f
        self.head = json.loads((FLIGHTS / f"{f['id']}.json").read_text())
        h = self.head
        data = np.frombuffer((FLIGHTS / f"{f['id']}.bin").read_bytes(), dtype="<f4").reshape(len(h["channels"]), -1)
        self.ch = dict(zip(h["channels"], data.astype(np.float64)))
        self.t0 = _iso(h["recordedStart"])
        self.td = float(h["touchdownT"])
        self.t = np.arange(h["samples"]) * h["dt"]
        self.app_h = AppHeight(self.ch["h"], self.td)
        self.end = airport["ends"][h["runway"]]
        self.airport = airport
        files = json.loads(gzip.decompress((SEL / f["raw"]).read_bytes()))
        p = adsb.stitch(*[adsb.points(tr) for tr in (files if isinstance(files, list) else [files])])
        pf = adsb.filter_sources(p)
        ob = smooth.observations(pf, frame)
        ob = ob.take(smooth.gate(ob))
        self.ob = ob
        self.ob_t = ob.t - self.t0
        self.raw_ant = ob.h - h["qa"]["calibration"]["offsetM"]    # antenna height above sea level, as recorded

    def served_antenna(self, t):
        return self.app_h(t) + ANT

    def airborne_obs(self):
        return (self.ob_t >= 0) & (self.ob_t <= self.t[-1]) & ~self.ob.ground & (self.ob_t < self.td) \
            & np.isfinite(self.raw_ant)

    def runway_coords(self, x, n):
        return adsb.runway_coords(self.end, np.asarray(x), np.asarray(n))

    def threshold_index(self):
        along, lat = self.runway_coords(self.ch["x"], self.ch["n"])
        k_td = int(np.searchsorted(self.t, self.td))
        idx = np.arange(1, len(along))
        cross = np.flatnonzero((along[:-1] < 0) & (along[1:] >= 0) & (np.abs(lat[1:]) < 600) & (idx <= k_td))
        return int(cross[-1] + 1)

    def threshold_time(self):
        along, _ = self.runway_coords(self.ch["x"], self.ch["n"])
        i = self.threshold_index()
        a0, a1 = along[i - 1], along[i]
        return self.t[i - 1] + (-a0 / (a1 - a0)) * (self.t[i] - self.t[i - 1])


@pytest.fixture(scope="module")
def served(lv_city):
    frame = create_frame(lv_city)
    airport = json.loads((ROOT / "public" / "data" / "lv" / "airport.json").read_text())
    return {f["id"]: Served(f, frame, airport) for f in _selection()}


def _rms(v):
    return float(np.sqrt(np.mean(np.square(v))))


def _limit(fl, gate):
    """The gate's limit, or the value a waiver of this flight records for it."""
    w = next((w for w in fl.f.get("waivers", []) if w["gate"] == gate), None)
    return w["value"] if w else fl.head["qa"]["gates"][gate]["max"]


IDS = [f["id"] for f in _selection()]


# --- (a) the served heights against the recording ----------------------------------------------------------------

@pytest.mark.parametrize("fid", IDS)
def test_the_served_last_minute_follows_the_recorded_heights(served, fid):
    fl = served[fid]
    m = fl.airborne_obs() & (fl.ob_t > fl.td - 60) & (fl.ob_t < fl.td - 8)
    err = fl.served_antenna(fl.ob_t[m]) - fl.raw_ant[m]
    assert m.sum() >= 20
    assert abs(float(np.mean(err))) < 1.5, f"{fid}: served minus recorded, mean {np.mean(err):.2f} m"
    # 0.01 m for the gate's rounding to centimetres and the app's Hermite against the bake's linear interpolation
    assert _rms(err) <= _limit(fl, "heightRmsLast60sM") + 0.01, f"{fid}: RMS {_rms(err):.3f} m"


@pytest.mark.parametrize("fid", IDS)
def test_the_served_threshold_crossing_is_the_recorded_one(served, fid):
    fl = served[fid]
    t_thr = fl.threshold_time()
    served_ant = float(fl.served_antenna(t_thr)[0]) - fl.end["threshold"][2]
    # the recorded heights within 15 s either side of the crossing, as a straight line in time
    m = fl.airborne_obs() & (np.abs(fl.ob_t - t_thr) < 15) & (fl.ob_t < fl.td - 3)
    slope, icpt = np.polyfit(fl.ob_t[m] - t_thr, fl.raw_ant[m], 1)
    recorded_ant = icpt - fl.end["threshold"][2]
    assert abs(served_ant - recorded_ant) < 3.0, f"{fid}: served {served_ant:.1f} m, recorded {recorded_ant:.1f} m"
    assert 12.0 <= served_ant <= 32.0
    assert served_ant == pytest.approx(fl.head["qa"]["crossingHeightM"], abs=0.15)


# --- (b) every gate from the served arrays --------------------------------------------------------------------------

def _recompute(fl):
    ch, t, td = fl.ch, fl.t, fl.td
    out = {}
    ob, obt = fl.ob, fl.ob_t
    air_o = fl.airborne_obs() | ((obt >= 0) & (obt <= t[-1]) & ~ob.ground & (obt < td) & ~np.isfinite(fl.raw_ant))
    sx, sn = np.interp(obt, t, ch["x"]), np.interp(obt, t, ch["n"])
    perr = np.hypot(sx - ob.x, sn - ob.n)
    out["positionRmsAirM"] = _rms(perr[air_o])
    s_ant = fl.served_antenna(obt)
    elev_o = bake_flight.surface_elevation(fl.airport, sx, sn)
    low = air_o & (s_ant - ANT - elev_o < 300)
    out["positionRmsLowM"] = _rms(perr[low])
    hok = fl.airborne_obs()
    herr = s_ant - fl.raw_ant
    out["heightRmsAirM"] = _rms(herr[hok])
    out["heightRmsLast60sM"] = _rms(herr[hok & (obt > td - 60) & (obt < td - 8)])
    along, lat = fl.runway_coords(ch["x"], ch["n"])
    i_thr = fl.threshold_index()
    idx = np.arange(len(t))
    fin = (t < td) & (idx >= i_thr - 400) & (np.abs(lat) < 600) & (idx <= i_thr) & (along > -3000) & (along < -1000)
    out["glidePathDeg"] = math.degrees(math.atan(-np.polyfit(along[fin], ch["h"][fin] + ANT, 1)[0]))
    out["crossingHeightM"] = float(fl.served_antenna(fl.threshold_time())[0]) - fl.end["threshold"][2]
    i_td = min(int(np.searchsorted(t, td)), len(t) - 1)
    out["touchdownPastThresholdM"] = float(along[i_td])
    out["touchdownOffCentreM"] = float(lat[i_td])
    out["bankDeg"] = float(np.abs(ch["roll"]).max())
    out["pitchDeg"] = [float(ch["pitch"].min()), float(ch["pitch"].max())]
    out["decelerationMs2"] = float((-np.gradient(ch["gs"], t))[t >= td].max())
    return out


TOL = {"positionRmsAirM": 0.1, "positionRmsLowM": 0.1, "heightRmsAirM": 0.1, "heightRmsLast60sM": 0.1,
       "glidePathDeg": 0.02, "crossingHeightM": 0.15, "touchdownPastThresholdM": 0.2, "touchdownOffCentreM": 0.2,
       "bankDeg": 0.06, "pitchDeg": 0.06, "decelerationMs2": 0.02}


@pytest.mark.parametrize("fid", IDS)
def test_every_gate_is_computed_from_the_served_arrays(served, fid):
    fl = served[fid]
    got = _recompute(fl)
    gates = fl.head["qa"]["gates"]
    wrong = {}
    for k, tol in TOL.items():
        v = gates[k]["value"]
        if isinstance(v, list):
            ok = all(abs(a - b) <= tol for a, b in zip(v, got[k]))
        else:
            ok = abs(v - got[k]) <= tol
        if not ok:
            wrong[k] = (v, got[k])
    assert not wrong, f"{fid}: gate in the QA block, value from the served arrays: {wrong}"
