# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "requests"]
# ///
"""Usage: bake_flight.py <city> [<flight id> ...] [--allow-fail]

Bake the recorded arrivals named in data/flights/<city>/selection.json into the app's flight format
("skyline-flight/1", plan 03 section 6.2) from their committed single-aircraft extracts, so the bake is reproducible
without the archive. v0 (F1.2): section 7.2's steps 1 to 6 with the altitude calibration on the runway; heading from
the track, bank from the turn rate, pitch from the flight path plus a constant per flap setting; flaps, slats, gear,
spoilers, reversers and lights from simple rules. Everything inferred is marked so in the header's provenance.

  Input    data/flights/<city>/selection.json            which flight: ICAO address, archive release, touchdown
           data/flights/<city>/raw/<id>.trace.json.gz     the aircraft's trace_full file(s) for the day (ODbL)
           public/data/<city>/airport.json                runways (build_airport.py)
           public/data/<city>/terrain.json                the `wide` grid's extent (the "terrain" event)
           METAR for the hour (altimeter, temperature, wind, visibility, clouds): Iowa Environmental Mesonet ASOS
           archive, https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py, cached under data/raw/iem/
  Output   public/data/<city>/flights/<id>.json   header: channels, provenance, events, QA (no airline, flight
                                                  number, registration or ICAO address: assumption A2)
           public/data/<city>/flights/<id>.bin    Float32 little-endian, channel after channel, `samples` each
           public/data/<city>/flights/index.json  the list the picker reads

The whole flight is baked, from 30 minutes before touchdown (cruise for an airliner from beyond 300 km) to the end of
the recorded surface positions; an event "terrain" marks where the aircraft enters the coarse `wide` terrain grid.
The bake fails (exit 1) if a quality gate of section 7.2 fails, unless --allow-fail.
"""
import argparse
import csv
import gzip
import io
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import adsb, geodesy, smooth  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FT = 0.3048
KT = 1852 / 3600
G = 9.80665
FORMAT = "skyline-flight/1"
CHANNELS = ["x", "n", "h", "s", "gs", "vs", "tas", "ias", "hdg", "pitch", "roll",
            "flap", "slat", "gear", "speedbrake", "groundSpoiler", "reverser", "lights", "cabinLight", "turbulence"]
UNITS = {
    "x": "m east of the city origin", "n": "m north of the city origin",
    "h": "m above sea level of the main-gear contact point (on the ground: the surface)",
    "s": "m flown along the ground track since the first sample", "gs": "m/s", "vs": "m/s, up positive",
    "tas": "m/s", "ias": "m/s", "hdg": "deg clockwise from grid north (+n)", "pitch": "deg, nose up positive",
    "roll": "deg, right wing down positive", "flap": "deg (trailing-edge detent: 0, 1, 2, 5, 10, 15, 25, 30, 40)",
    "slat": "0 retracted, 1 extend, 2 full extend", "gear": "0 up and locked, 1 down and locked",
    "speedbrake": "0..1 of flight-detent travel", "groundSpoiler": "0..1", "reverser": "0 stowed, 1 deployed",
    "lights": "bit field (section 5.5): NAV 1, BEACON 2, STROBE 4, LANDING 8, TAXI 16, TURNOFF 32, LOGO 64, WING 128;"
              " every lamp that is on has its bit",
    "cabinLight": "0..1", "turbulence": "0..1",
}
# Estimate: the GNSS antenna on the crown of a 737-800's fuselage, above the main-gear contact point at rest
# (fuselage crown about 5.6 m above the ramp). The calibration on the runway absorbs any error in it, except in the
# crossing-height check, which is quoted for the antenna.
ANTENNA_ABOVE_WHEELS_M = 5.6
# Published final approach angles and crossing heights (FAA CIFP cycle 2611 as read for plan 03, section 6.3) beside
# the PAPI's from NASR. The crossing-height gate is section 7.2's: 60 to 84 ft with 6 m either side, 12 to 32 m.
PUBLISHED = {"19R": {"angles": [3.24], "tchFt": [60]}, "19L": {"angles": [3.00], "tchFt": [75]},
             "26L": {"angles": [3.00], "tchFt": [60]}, "26R": {"angles": [3.00], "tchFt": [60]},
             "1L": {"angles": [3.40], "tchFt": [59]}}
TCH_GATE_M = (12.0, 32.0)
FLAP_LIMIT_KT = {0: 999, 1: 250, 2: 250, 5: 250, 10: 210, 15: 200, 25: 190, 30: 175, 40: 162}
# Section 5.5's bits, as settled on 24 November and read by src/flight/track.js.
LIGHT = {"nav": 1, "beacon": 2, "strobe": 4, "landing": 8, "taxi": 16, "turnoff": 32, "logo": 64, "wing": 128}


# --- the airport surface ---------------------------------------------------------------------------------------

def runway_of(airport, end_id):
    return next(r for r in airport["runways"] if end_id in r["ends"])


def _profile_at(rwy, airport, x, n):
    """Along (from the runway's first end) and lateral offset of points, and the profile's elevation there."""
    first = airport["ends"][rwy["ends"][0]]["end"]
    ux, uy = rwy["direction"]
    dx, dn = np.asarray(x) - first[0], np.asarray(n) - first[1]
    along = dx * ux + dn * uy
    lat = -dx * uy + dn * ux
    prof = np.array(rwy["profile"])
    return along, lat, np.interp(along, prof[:, 0], prof[:, 1])


def surface_elevation(airport, x, n):
    """Elevation (m) of the airport surface under points: the profile of the nearest runway, held level beyond
    its ends (v0: taxiways and aprons take the nearest runway's profile)."""
    best_d, best_z = None, None
    for rwy in airport["runways"]:
        along, lat, z = _profile_at(rwy, airport, x, n)
        d = np.abs(lat) + np.maximum(0, -along) + np.maximum(0, along - rwy["surveyedLength"])
        if best_d is None:
            best_d, best_z = d, z
        else:
            closer = d < best_d
            best_d, best_z = np.where(closer, d, best_d), np.where(closer, z, best_z)
    return best_z


# --- weather ---------------------------------------------------------------------------------------------------

def iem_day(city, day):
    """The day's ASOS reports for the city's station (UTC), as dicts; cached under data/raw/iem/."""
    from lib.fetch import cached_get
    s = city["iemStation"]
    url = ("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station={s}&data=tmpf&data=alti&data=drct"
           "&data=sknt&data=gust&data=vsby&data=skyc1&data=skyl1&data=skyc2&data=skyl2&data=skyc3&data=skyl3"
           "&data=wxcodes&data=metar&year1={y}&month1={m}&day1={d}&year2={y}&month2={m}&day2={d}&tz=Etc/UTC"
           "&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4"
           ).format(s=s, y=day.year, m=day.month, d=day.day)
    _, body = cached_get(url, ROOT / "data" / "raw" / "iem" / f"{s}-{day:%Y-%m-%d}.csv")
    return list(csv.DictReader(io.StringIO(body.decode()))), url


def metar_near(rows, epoch, station_elev):
    """The report nearest an instant, as the values the bake uses."""
    def ts(r):
        return datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
    r = min((r for r in rows if r.get("alti") not in (None, "", "M")), key=lambda r: abs(ts(r) - epoch))
    num = lambda k: None if r.get(k) in (None, "", "M") else float(r[k])  # noqa: E731
    ceiling = None
    for i in (1, 2, 3):
        if r.get(f"skyc{i}") in ("BKN", "OVC", "VV") and num(f"skyl{i}") is not None:
            ceiling = num(f"skyl{i}") if ceiling is None else min(ceiling, num(f"skyl{i}"))
    return {"valid": r["valid"] + "Z", "altimeterInHg": num("alti"), "tempC": (num("tmpf") - 32) / 1.8,
            "windDir": num("drct"), "windKt": num("sknt"), "gustKt": num("gust"), "visibilityMi": num("vsby"),
            "ceilingFt": ceiling, "wx": r.get("wxcodes") or "", "metar": r.get("metar", ""),
            "stationElevation": station_elev}


# --- the bake --------------------------------------------------------------------------------------------------

@dataclass
class Baked:
    header: dict
    channels: dict
    t_epoch: np.ndarray
    report: dict


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _unwrap_deg(a):
    return np.degrees(np.unwrap(np.radians(a)))


def _rate_limit(y, dt, rate):
    out = np.array(y, dtype=float)
    for i in range(1, len(out)):
        d = out[i] - out[i - 1]
        out[i] = out[i - 1] + np.clip(d, -rate * dt, rate * dt)
    return out


def _travel(cmd, dt, rate):
    """Surfaces moving toward a commanded position at a fixed rate."""
    return _rate_limit(cmd, dt, rate)


def _moving_average(y, n):
    if n <= 1:
        return y
    k = np.ones(n) / n
    pad = n // 2
    yp = np.pad(y, (pad, n - 1 - pad), mode="edge")
    return np.convolve(yp, k, mode="valid")


def _bearing_name(deg):
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return names[int(((deg % 360) + 22.5) // 45) % 8]


def calibrate(ob, td, airport, metar, frame, arp_xy, end):
    """Step 4: the offset of the reported geometric altitude from the true height, and how it was found."""
    elev = surface_elevation(airport, ob.x, ob.n)
    # Fresh heights on the runway: airborne-format positions sent while rolling (after the touchdown, before the
    # surface flag). Surface positions carry no altitude, and the geometric altitude readsb repeats on them is stale.
    along_r, lat_r = adsb.runway_coords(end, ob.x, ob.n)
    roll = ob.ground & ~ob.reported_ground & np.isfinite(ob.h) & (ob.t >= td) & (ob.t <= td + 300) \
        & (np.abs(lat_r) < 40)
    out = {}
    baro_ok = np.isfinite(ob.h) & np.isfinite(ob.hb) & ~ob.ground
    near = np.hypot(ob.x - arp_xy[0], ob.n - arp_xy[1]) < 15000
    field = airport["arp"]["elevation"]
    low = baro_ok & near & (ob.hb - field < 900) & (ob.t < td) & (ob.t > td - 900)
    if metar and metar.get("altimeterInHg") and low.sum() >= 5:
        hb = geodesy.baro_to_msl(ob.hb[low] / FT, metar["altimeterInHg"], metar["tempC"], metar["stationElevation"])
        out["barometricOffsetM"] = round(float(np.median(ob.h[low] - hb)), 2)
        out["barometricPoints"] = int(low.sum())
    if roll.sum() >= 3:
        off = float(np.median(ob.h[roll] - (elev[roll] + ANTENNA_ABOVE_WHEELS_M)))
        out.update(method="rollout", offsetM=round(off, 2), points=int(roll.sum()))
    elif "barometricOffsetM" in out:
        out.update(method="barometric", offsetM=out["barometricOffsetM"], points=out["barometricPoints"])
    else:
        lat, lon = frame.to_geodetic(*arp_xy)
        n_geoid = geodesy.geoid_height(float(lat), float(lon))
        out.update(method="geoid", offsetM=round(n_geoid if n_geoid is not None else -28.08, 2), points=0)
    lat, lon = frame.to_geodetic(*arp_xy)
    n_geoid = geodesy.geoid_height(float(lat), float(lon))
    out["geoidM"] = None if n_geoid is None else round(n_geoid, 2)
    out["datum"] = geodesy.datum_from_offset(out["offsetM"], n_geoid if n_geoid is not None else -28.08)
    return out


def bake(p, airport, frame, *, metar, runway=None, flight_id, lead_s=1800.0, wide=None, release=None,
         aircraft_type=None, touchdown_epoch=None):
    """Bake one arrival from the points of its trace (all sources). Returns Baked."""
    landings = adsb.find_landings(p, airport, frame)
    if runway:
        landings = [l for l in landings if l["runway"] == runway]
    if touchdown_epoch is not None:
        landings = [l for l in landings if abs(l["t"] - touchdown_epoch) < 120]
    if not landings:
        raise ValueError(f"{flight_id}: no landing{' on ' + runway if runway else ''} in the trace")
    land = landings[-1]
    td, end_id = land["t"], land["runway"]
    end = airport["ends"][end_id]
    rwy = runway_of(airport, end_id)
    arp_xy = (airport["arp"]["x"], airport["arp"]["y"])

    # 1 Cut: 30 minutes before touchdown (or the start of this leg) to the end of the surface positions
    prev_ground = np.flatnonzero(p.ground & (p.t < td - 120))
    leg_start = p.t[prev_ground[-1]] + 1 if len(prev_ground) else p.t[0]
    surface_rec = land.get("surface", True)
    i_end = land["index"]
    if surface_rec:
        while i_end + 1 < len(p) and p.ground[i_end + 1] and p.t[i_end + 1] - p.t[i_end] < 120:
            i_end += 1
        t_end = float(p.t[i_end])
    else:
        t_end = float(p.t[i_end])          # the last airborne point; the rest is reconstructed below
    t_first = max(td - lead_s, leg_start)
    seg = p.take((p.t >= t_first - 30) & (p.t <= t_end + 1))
    share = adsb.adsb_share(seg)

    # 2 Filter, 3 Gate
    pf = adsb.filter_sources(seg)
    ob = smooth.observations(pf, frame)
    keep = smooth.gate(ob)
    dropped = int((~keep).sum())
    ob = ob.take(keep)
    # points sent in the airborne format after the touchdown (a transponder that reports the surface format only
    # below a speed) are on the ground
    ob.ground = ob.ground | (ob.t >= td)
    t0 = math.ceil(max(t_first, ob.t[0]))
    # without surface positions the smoother runs on past the last point (on the recorded velocity) far enough
    # for the flare to find the runway
    horizon = math.floor(min(t_end, ob.t[-1])) if surface_rec else math.ceil(td + 30)
    t_out = np.arange(t0, horizon + 1, 1.0)

    # 4 Altitude: geometric minus the calibrated offset; barometric (corrected) where geometric is missing
    cal = calibrate(ob, td, airport, metar, frame, arp_xy, end)
    h_obs = ob.h - cal["offsetM"]
    sig_h = np.full(len(ob.t), smooth.SIGMA_H)
    miss = ~np.isfinite(h_obs) & np.isfinite(ob.hb) & ~ob.ground
    if miss.any() and metar and metar.get("altimeterInHg"):
        hb = geodesy.baro_to_msl(ob.hb[miss] / FT, metar["altimeterInHg"], metar["tempC"], metar["stationElevation"])
        h_obs[miss] = hb + (cal.get("barometricOffsetM", cal["offsetM"]) - cal["offsetM"])
        sig_h[miss] = 25.0
    # The vertical smoother sees only the airborne heights: the wheels' heights after touchdown are the surface's,
    # and pinning the smoothed antenna to the runway at the transition would leave no room for the flare (the
    # recorded glide aims short of where the wheels touch).
    h_obs[ob.ground | (ob.t >= td)] = np.nan

    # 5 Smooth: 1 Hz
    # positions: sigma 3 m on the ground, 8 m in the air (7.2) but 4 m below 300 m over the field, where the gate
    # asks the smoothed path to stay within 5 m RMS of the recorded one
    low_obs = ~ob.ground & (np.nan_to_num(h_obs, nan=1e9) - airport["arp"]["elevation"] < 300)
    sig_pos = np.where(ob.ground, smooth.SIGMA_POS_GROUND, np.where(low_obs, 4.0, smooth.SIGMA_POS_AIR))
    trk = smooth.smooth_track(ob, t_out, h_obs=h_obs, sigma_h=sig_h, sigma_pos=sig_pos)
    x, n, vx, vn, vz = trk.x.copy(), trk.n.copy(), trk.vx.copy(), trk.vn.copy(), trk.vz.copy()
    elev = surface_elevation(airport, x, n)
    ant = trk.h.copy()
    wheels = ant - ANTENNA_ABOVE_WHEELS_M - elev
    reconstructed = []

    # 6 Touchdown. Recorded: the air-to-ground transition. Not recorded (no surface position received): where a
    # flare from 7.5 m, the middle of 6 to 9 m, at 0.7 m/s at the wheels, meets the runway from the extrapolated glide.
    if not surface_rec:
        td = smooth.flare_end(t_out, wheels, t_out[0] + 0.0, y0=7.5, td_sink=0.7, after=ob.t[-1] - 60)
        # the unrecorded end of the final eases onto the centre line by touchdown (the extrapolation would carry any
        # last lateral offset or position error to the runway)
        gap = (t_out > ob.t[-1]) & (t_out <= td + 30)
        if gap.any():
            al, la = adsb.runway_coords(end, x[gap], n[gap])
            w = np.clip((t_out[gap] - ob.t[-1]) / max(td - ob.t[-1], 1.0), 0, 1)
            w = w * w * (3 - 2 * w)
            _, _, right = adsb._end_axes(end)
            x[gap] -= la * w * right[0]
            n[gap] -= la * w * right[1]
            idx = np.flatnonzero(gap)
            lo, hi = max(idx[0] - 1, 0), min(idx[-1] + 2, len(x))
            vx[lo:hi] = np.gradient(x[lo:hi], t_out[lo:hi])
            vn[lo:hi] = np.gradient(n[lo:hi], t_out[lo:hi])
            elev = surface_elevation(airport, x, n)
            wheels = ant - ANTENNA_ABOVE_WHEELS_M - elev
        reconstructed.append({"from": int(round(ob.t[-1] - t0)), "to": int(round(td - t0)),
                              "what": "no position received after this: the end of the final follows the recorded"
                                      " velocity onto the centre line, and the touchdown time is where the modelled"
                                      " flare meets the runway"})

    # Touchdown on the 1 s grid (a shift under half a second, within the transition's own precision), so the loader's
    # touchdown, the touchdown sample and the ISO time agree
    td_recorded = td
    td = float(t0 + round(td - t0))

    # 7 Ground: a constant deceleration to taxi speed along the centre line where the surface positions end early
    last_gs = float(np.hypot(vx[-1], vn[-1]))
    if not surface_rec or last_gs > 15.0:
        t_rec = td if not surface_rec else float(t_out[-1])
        keep_n = int(np.searchsorted(t_out, t_rec, side="right"))
        k = max(keep_n - 1, 0)
        along0, lat0 = adsb.runway_coords(end, x[k], n[k])
        v0 = float(np.hypot(vx[k], vn[k]))
        length = rwy["surveyedLength"] - end["displacedM"]          # threshold to the far end
        decel = max(1.8, (v0**2 - 10.0**2) / (2 * max(length - 300 - along0, 300)))
        t_stop = (v0 - 10.0) / decel
        tt = np.arange(t_out[k] + 1, t_rec + t_stop + 1, 1.0)
        dtt = tt - t_rec
        v = np.maximum(10.0, v0 - decel * np.clip(dtt, 0, None))
        a_along = along0 + v0 * np.clip(dtt, 0, None) - 0.5 * decel * np.clip(dtt, 0, t_stop) ** 2
        a_along = np.where(dtt > t_stop, along0 + v0 * t_stop - 0.5 * decel * t_stop**2 + 10.0 * (dtt - t_stop),
                           a_along)
        lat = lat0 * np.exp(-np.clip(dtt, 0, None) / 4.0)            # onto the centre line in a few seconds
        thr, u, right = adsb._end_axes(end)
        rx = thr[0] + a_along * u[0] + lat * right[0]
        rn = thr[1] + a_along * u[1] + lat * right[1]
        t_out = np.concatenate([t_out[:k + 1], tt])
        x, n = np.concatenate([x[:k + 1], rx]), np.concatenate([n[:k + 1], rn])
        vx = np.concatenate([vx[:k + 1], v * u[0]])
        vn = np.concatenate([vn[:k + 1], v * u[1]])
        vz = np.concatenate([vz[:k + 1], np.zeros(len(tt))])
        ant = np.concatenate([ant[:k + 1], np.full(len(tt), np.nan)])
        elev = surface_elevation(airport, x, n)
        wheels = np.concatenate([wheels[:k + 1], np.zeros(len(tt))])
        reconstructed.append({"from": int(round(tt[0] - t0)), "to": int(round(tt[-1] - t0)),
                              "what": "rollout: constant deceleration of %.1f m/s2 to taxi speed along the centre line"
                                      % decel})
    win = (t_out >= td - 150) & (t_out <= td + 3)
    y_new, flare_info = smooth.flare(t_out[win], wheels[win], td)
    wheels[win] = y_new
    wheels[t_out > td] = 0.0
    air = t_out < td
    wheels = np.where(air, np.maximum(wheels, 0.0), 0.0)
    h = elev + wheels

    # derived kinematics
    dt = 1.0
    gs = np.hypot(vx, vn)
    hdg = np.degrees(np.arctan2(vx, vn)) % 360
    slow = gs < 3.0
    if slow.any():
        idx = np.where(~slow, np.arange(len(hdg)), 0)
        np.maximum.accumulate(idx, out=idx)
        hdg = hdg[idx]
    vs = np.gradient(h, t_out)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(n)))])

    # air data, v0: no wind (true airspeed = ground speed), ISA shifted to the surface temperature
    temp_off = (metar["tempC"] - (15 - 0.0065 * metar["stationElevation"])) if metar else 0.0
    tas = np.sqrt(gs**2 + vs**2)
    ias = tas * np.sqrt(geodesy.isa_density_ratio(h, temp_off))

    # attitude, v0: bank from the turn rate, pitch from the flight path plus a constant per flap setting
    turn = np.gradient(_unwrap_deg(hdg), t_out)
    turn = _moving_average(turn, 5)
    roll = np.degrees(np.arctan(tas * np.radians(turn) / G))
    roll = np.clip(roll, -30, 30)
    roll[~air] = 0.0
    roll = _rate_limit(roll, dt, 5.0)

    # configuration, v0 rules (section 7.3, simplified): by distance to the threshold along the path
    along_thr, lat_thr = adsb.runway_coords(end, x, n)
    # the threshold crossing: the last time before touchdown the path passes the threshold line near the runway
    # (far away the aircraft can be "past" the line on the far side of the field)
    k_td0 = int(np.searchsorted(t_out, td))
    cross = np.flatnonzero((along_thr[:-1] < 0) & (along_thr[1:] >= 0) & (np.abs(lat_thr[1:]) < 600)
                           & (np.arange(1, len(s)) <= k_td0))
    i_thr = int(cross[-1] + 1) if len(cross) else k_td0
    final_seg = (np.arange(len(s)) >= (i_thr - 400)) & (np.abs(lat_thr) < 600)
    to_go = s[i_thr] - s                          # m along the path to the threshold (negative after it)
    above_field = h - end["threshold"][2]
    ias_kt = ias / KT
    flap_cmd = np.zeros(len(s))
    for dist, setting in ((22000, 1), (16000, 5), (11000, 15), (7500, 30)):
        flap_cmd = np.where((to_go < dist) & air, np.maximum(flap_cmd, setting), flap_cmd)
    flap_cmd = np.where(h > 20000 * FT, 0, flap_cmd)
    # never selected above its limit speed: hold the previous setting until slow enough
    settings = sorted(FLAP_LIMIT_KT)
    for i in range(len(flap_cmd)):
        while flap_cmd[i] > 0 and ias_kt[i] > FLAP_LIMIT_KT[int(flap_cmd[i])]:
            flap_cmd[i] = settings[settings.index(int(flap_cmd[i])) - 1]
    flap_cmd = np.maximum.accumulate(flap_cmd * air) * air  # never retracted in the air on an arrival
    after = t_out >= td
    exit_slow = after & (gs < 15.0)
    t_exit = t_out[np.flatnonzero(exit_slow)[0]] if exit_slow.any() else t_out[-1] + 1
    landing_flap = flap_cmd[air][-1] if air.any() else 30
    flap_cmd = np.where(after & (t_out < t_exit + 20), landing_flap, flap_cmd)
    flap_cmd = np.where(t_out >= t_exit + 20, 0.0, flap_cmd)
    flap = _travel(flap_cmd, dt, 1.0)            # estimate: 40 s from up to 40
    # slats: 1 "extend" with flaps 1 to 5, 2 "full extend" beyond 5 (section 7.3), moving with the flaps
    slat = np.clip(flap / 1.0, 0, 1) + np.clip((flap - 5) / 5.0, 0, 1)
    gear_cmd = (((to_go < 11000) | ((above_field < 760) & (to_go < 25000))) & air) | ~air
    gear_cmd = np.maximum.accumulate(gear_cmd.astype(float))
    gear = _travel(gear_cmd, dt, 0.1)            # estimate: 10 s to extend
    spoiler_cmd = (t_out >= td + 0.5) & (gs > 15.0) & after
    ground_spoiler = _travel(spoiler_cmd.astype(float), dt, 1.0)
    rev_cmd = (t_out >= td + 2) & (gs > 15.0) & after
    reverser = _travel(rev_cmd.astype(float), dt, 0.5)
    speedbrake = np.zeros(len(s))

    sun_td = geodesy.sun_elevation(td, airport["arp"]["lat"], airport["arp"]["lon"])
    sun = np.array([geodesy.sun_elevation(t, *frame.to_geodetic(x[i], n[i])) for i, t in
                    zip(range(0, len(t_out), 60), t_out[::60])])
    sun = np.interp(t_out, t_out[::60], sun)
    below10k = h < 10000 * FT
    descending_below = np.maximum.accumulate(below10k & air) > 0
    # section 7.8: position lights and beacon always (engines running); strobes until the runway is vacated;
    # landing lights below 10,000 ft until vacating; turn-off lights from gear down; taxi light after vacating;
    # wing and logo lights at night below 10,000 ft
    lights = np.full(len(s), LIGHT["nav"] | LIGHT["beacon"], dtype=np.int64)
    lights |= np.where(t_out < t_exit, LIGHT["strobe"], 0)
    lights |= np.where((descending_below & air) | (after & (t_out < t_exit)), LIGHT["landing"], 0)
    gear_down_on = np.maximum.accumulate(gear_cmd > 0.5) | after
    lights |= np.where(gear_down_on, LIGHT["turnoff"], 0)
    lights |= np.where(after & (t_out >= t_exit), LIGHT["taxi"], 0)
    lights |= np.where(descending_below & (sun < 0), LIGHT["logo"] | LIGHT["wing"], 0)
    cabin = np.where(descending_below & (sun < -6) & (t_out < t_exit), 0.3, 1.0)

    # pitch: flight path plus a constant by flap (2.5 deg clean, 5.4 deg with landing flap: the reference
    # attitudes of 7.3 for cruise and a 3-degree path); the nose comes down over 4 s after touchdown
    fpa = np.degrees(np.arctan2(vs, np.maximum(gs, 1.0)))
    alpha = 2.5 + (5.4 - 2.5) * np.clip(flap / 30.0, 0, 1)
    pitch = np.where(air, fpa + alpha, 0.0)
    k_td = int(np.searchsorted(t_out, td))
    if k_td < len(pitch):
        p_td = float(pitch[max(k_td - 1, 0)])
        derot = np.clip((t_out - td) / 4.0, 0, 1)
        pitch = np.where(after, p_td * (1 - derot), pitch)
    pitch = np.clip(pitch, -6, 12)

    # turbulence: 30 s RMS of recorded minus smoothed vertical rate, scaled to 0..1 (2 m/s -> 1)
    rec_vz = ob.vz
    sm_vz = np.interp(ob.t, t_out, vz)
    res2 = np.where(np.isfinite(rec_vz) & ~ob.ground, (rec_vz - sm_vz) ** 2, np.nan)
    grid_res = np.interp(t_out, ob.t[np.isfinite(res2)], res2[np.isfinite(res2)]) if np.isfinite(res2).any() \
        else np.zeros(len(t_out))
    turbulence = np.clip(np.sqrt(_moving_average(grid_res, 30)) / 2.0, 0, 1)
    turbulence[~air] = 0.0

    channels = {"x": x, "n": n, "h": h, "s": s, "gs": gs, "vs": vs, "tas": tas, "ias": ias, "hdg": hdg,
                "pitch": pitch, "roll": roll, "flap": flap, "slat": slat, "gear": gear, "speedbrake": speedbrake,
                "groundSpoiler": ground_spoiler, "reverser": reverser, "lights": lights, "cabinLight": cabin,
                "turbulence": turbulence}
    channels = {k: np.asarray(channels[k], dtype=np.float32) for k in CHANNELS}

    # --- QA (section 7.2's gates) ---
    sx, sn = np.interp(ob.t, t_out, x), np.interp(ob.t, t_out, n)
    in_range = (ob.t >= t_out[0]) & (ob.t <= t_out[-1])
    perr = np.hypot(sx - ob.x, sn - ob.n)
    s_ant = np.interp(ob.t, t_out, ant)
    s_elev_obs = np.interp(ob.t, t_out, elev)
    obs_air = in_range & ~ob.ground & (ob.t < td)
    low300 = obs_air & (s_ant - ANTENNA_ABOVE_WHEELS_M - s_elev_obs < 300)
    raw_h = ob.h - cal["offsetM"]
    herr = s_ant - raw_h
    hok = obs_air & np.isfinite(herr)
    last60 = hok & (ob.t > td - 60) & (ob.t < td - 8)   # the modelled flare excluded
    rms = lambda v: round(float(np.sqrt(np.mean(v**2))), 2) if len(v) else None  # noqa: E731

    fin = air & final_seg & (np.arange(len(s)) <= i_thr) & (along_thr > -3000) & (along_thr < -1000)
    if fin.sum() >= 5:
        slope = np.polyfit(along_thr[fin], ant[fin], 1)[0]
        gp = float(math.degrees(math.atan(-slope)))   # height falls as the along-runway distance grows
    else:
        gp = None
    pub = sorted(set(PUBLISHED.get(end_id, {}).get("angles", [])
                     + ([end["papi"]["angle"]] if end.get("papi") and end["papi"].get("angle") else [])))
    gp_near = min(pub, key=lambda a: abs(a - gp)) if (gp is not None and pub) else None
    if 0 < i_thr < len(s):
        a0, a1 = along_thr[i_thr - 1], along_thr[i_thr]
        f = -a0 / (a1 - a0) if a1 != a0 else 0.0
        ant_at_thr = float(ant[i_thr - 1] + f * (ant[i_thr] - ant[i_thr - 1]))
    else:
        ant_at_thr = None
    tch = None if ant_at_thr is None else ant_at_thr - end["threshold"][2]
    i_td = min(int(np.searchsorted(t_out, td)), len(t_out) - 1)
    td_along, td_lat = float(along_thr[i_td]), float(lat_thr[i_td])
    decel = -np.gradient(gs, t_out)
    gates = {
        "positionRmsAirM": {"value": rms(perr[obs_air]), "max": 12.0},
        "positionRmsLowM": {"value": rms(perr[low300]), "max": 5.0},
        "heightRmsAirM": {"value": rms(herr[hok]), "max": 8.0},
        "heightRmsLast60sM": {"value": rms(herr[last60]), "max": 3.0},
        "glidePathDeg": {"value": None if gp is None else round(gp, 2), "nearest": gp_near,
                         "maxDiff": 0.35, "warnDiff": 0.2},
        "crossingHeightM": {"value": None if tch is None else round(tch, 1), "min": TCH_GATE_M[0],
                            "max": TCH_GATE_M[1]},
        "touchdownPastThresholdM": {"value": round(td_along, 1), "min": 250.0, "max": 1000.0},
        "touchdownOffCentreM": {"value": round(td_lat, 1), "maxAbs": 8.0},
        "bankDeg": {"value": round(float(np.abs(roll).max()), 1), "maxAbs": 35.0},
        "pitchDeg": {"value": [round(float(pitch.min()), 1), round(float(pitch.max()), 1)], "min": -6.0, "max": 12.0},
        "decelerationMs2": {"value": round(float(decel[after].max()) if after.any() else 0.0, 2), "max": 3.5},
    }
    for k, gt in gates.items():
        v = gt["value"]
        if v is None:
            gt["pass"] = False
        elif "maxDiff" in gt:
            gt["pass"] = gp_near is not None and abs(v - gp_near) <= gt["maxDiff"]
            gt["warn"] = gp_near is not None and abs(v - gp_near) > gt["warnDiff"]
        elif "maxAbs" in gt:
            gt["pass"] = abs(v) <= gt["maxAbs"]
        elif isinstance(v, list):
            gt["pass"] = gt["min"] <= v[0] and v[1] <= gt["max"]
        else:
            gt["pass"] = (v >= gt.get("min", -np.inf)) and (v <= gt.get("max", np.inf))
    def detent(f):
        return max(k for k in FLAP_LIMIT_KT if k <= f + 0.01)
    flap_over = [int(t_out[i] - t0) for i in range(len(flap))
                 if air[i] and flap[i] > 0.5 and ias_kt[i] > FLAP_LIMIT_KT[detent(flap[i])] + 1]
    gates["flapPlacard"] = {"value": len(flap_over), "max": 0, "pass": not flap_over}
    rec_roll = np.interp(t_out, pf.t[np.isfinite(pf.roll)], pf.roll[np.isfinite(pf.roll)]) \
        if np.isfinite(pf.roll).sum() > 10 else None
    report_only = {"recordedRollRmsDeg": None if rec_roll is None else rms((roll - rec_roll)[air])}

    # --- events ---
    def ev(t, eid, label):
        i = int(np.clip(round(t - t0), 0, len(t_out) - 1))
        return {"t": int(i), "s": round(float(s[i]), 1), "id": eid, "label": label}

    events = []
    h_ft0 = h[0] / FT
    events.append(ev(t0, "cruise" if h_ft0 > 18000 else "start",
                     f"{'Cruise' if h_ft0 > 18000 else 'Descent'}, {int(round(h_ft0, -3)):,} ft"))
    pre = t_out < td - 600
    if pre.any():
        hmax = h[pre].max()
        i_drop = np.flatnonzero(pre & (h < hmax - 300 * FT) & (np.arange(len(h)) > np.argmax(h[pre])))
        if len(i_drop) and hmax / FT > 15000:
            j = i_drop[0]
            while j > 0 and h[j - 1] < hmax - 60 * FT:
                j -= 1
            events.append(ev(t_out[j], "tod", "Top of descent"))
    for thr_ft, eid, label in ((18000, "fl180", "Through 18,000 ft"), (10000, "10000", "Through 10,000 ft")):
        down = np.flatnonzero((h[:-1] >= thr_ft * FT) & (h[1:] < thr_ft * FT))
        if len(down):
            events.append(ev(t_out[down[0] + 1], eid, label))
    if wide:
        inside = (x >= wide[0]) & (x <= wide[2]) & (n >= wide[1]) & (n <= wide[3])
        if inside.any():
            events.append(ev(t_out[np.flatnonzero(inside)[0]], "terrain", "Over the valley's terrain"))
    g_down = np.flatnonzero(gear_cmd > 0.5)
    if len(g_down) and t_out[g_down[0]] < td:
        events.append(ev(t_out[g_down[0]], "gear", "Gear down"))
    above_thr = h - end["threshold"][2]
    k1000 = np.flatnonzero(air[:-1] & (above_thr[:-1] >= 1000 * FT) & (above_thr[1:] < 1000 * FT))
    if len(k1000):
        k = k1000[-1]
        events.append(ev(t_out[k + 1] if abs(above_thr[k + 1] - 1000 * FT) < abs(above_thr[k] - 1000 * FT)
                         else t_out[k], "ft1000", "1,000 ft above the runway"))
    events.append(ev(t_out[i_thr], "threshold", f"Runway {end_id} threshold"))
    events.append(ev(td, "touchdown", "Touchdown"))
    if t_exit <= t_out[-1]:
        events.append(ev(t_exit, "vacate", "Taxi speed"))
    events.append(ev(t_out[-1], "end", "End of recording"))
    events.sort(key=lambda e: e["t"])

    # --- header ---
    lat_s, lon_s = frame.to_geodetic(x[0], n[0])
    i24 = int(np.clip(round(td - 24 * 60 - t0), 0, len(x) - 1))
    from_deg = math.degrees(math.atan2(x[i24] - arp_xy[0], n[i24] - arp_xy[1])) % 360
    thr_xy = np.array(end["threshold"][:2])
    u = np.array([math.sin(math.radians(end["gridHeading"])), math.cos(math.radians(end["gridHeading"]))])
    on_final = thr_xy - 3000 * u
    to_strip = -on_final
    strip_side = "right" if (u[1] * to_strip[0] - u[0] * to_strip[1]) > 0 else "left"
    light = geodesy.light_of(sun_td)
    clear = metar and (metar.get("visibilityMi") or 0) >= 10 and (metar.get("ceilingFt") is None or
                                                                  metar["ceilingFt"] >= 12000)
    prov = {k: "derived" for k in CHANNELS}
    prov.update({"x": "recorded", "n": "recorded", "h": "recorded", "s": "derived", "gs": "recorded",
                 "vs": "recorded", "hdg": "derived", "roll": "derived", "tas": "derived", "ias": "derived",
                 "pitch": "inferred", "flap": "inferred", "slat": "inferred", "gear": "inferred",
                 "speedbrake": "inferred", "groundSpoiler": "inferred", "reverser": "inferred",
                 "lights": "inferred", "cabinLight": "inferred", "turbulence": "derived"})
    td_t = round(td - t0, 2)
    header = {
        "format": FORMAT, "id": flight_id, "city": None, "airport": airport.get("icao"), "runway": end_id,
        "aircraftType": aircraft_type, "recordedStart": _iso(t0), "touchdown": _iso(td), "touchdownT": td_t,
        "dt": 1.0, "samples": int(len(t_out)), "channels": CHANNELS, "units": UNITS,
        "provenance": prov,
        "provenanceNotes": {
            "h": "ADS-B geometric altitude, calibrated on the runway; wheels = antenna - %.1f m (estimate); the "
                 "flare (last seconds before the recorded air-to-ground transition) is modelled" % ANTENNA_ABOVE_WHEELS_M,
            "tas": "v0: ground speed, no wind", "ias": "v0: from tas with an ISA shifted to the surface temperature",
            "hdg": "v0: the ground track (no crab)", "roll": "v0: coordinated turn from the track's turn rate",
            "pitch": "v0: flight-path angle plus 2.5 deg clean to 5.4 deg with landing flap",
            "flap": "v0: by distance to the threshold (1 at 22 km, 5 at 16, 15 at 11, 30 at 7.5), never above a "
                    "limit speed, 1 deg/s travel",
            "speedbrake": "v0: not modelled (always 0)",
        },
        "reconstructed": reconstructed + [{"from": int(max(0, round(flare_info["tf"] - t0))), "to": int(round(td - t0)),
                           "what": "flare: wheel height modelled from %.1f m to the runway" % flare_info["y0"]}],
        "events": events,
        "atmosphere": [[round(metar["stationElevation"], 1), round(metar["tempC"], 1),
                        round(-(metar.get("windKt") or 0) * KT * math.sin(math.radians(metar.get("windDir") or 0)), 1),
                        round(-(metar.get("windKt") or 0) * KT * math.cos(math.radians(metar.get("windDir") or 0)), 1)]]
        if metar else [],
        "atmosphereNote": "v0: the surface report only (altitude m, temperature degC, wind towards east and north m/s); "
                          "the upper-air profile is F2.4",
        "badges": {"light": light, "weather": "clear" if clear else "weather", "from": _bearing_name(from_deg),
                   "stripSide": strip_side},
        "qa": {
            "glidePathDeg": gates["glidePathDeg"]["value"], "crossingHeightM": gates["crossingHeightM"]["value"],
            "touchdownPastThresholdM": gates["touchdownPastThresholdM"]["value"],
            "touchdownRecorded": bool(surface_rec),
            "touchdownSource": land.get("touchdownSource", "estimated") if surface_rec else "modelled flare",
            "touchdownOffCentreM": gates["touchdownOffCentreM"]["value"],
            "altitudeOffsetM": cal["offsetM"], "datum": cal["datum"], "calibration": cal,
            "flare": {k: round(v, 3) if isinstance(v, float) else v for k, v in flare_info.items()
                      if k in ("y0", "tdSink", "sink0", "duration", "shift", "err")},
            "sunAtTouchdownDeg": round(sun_td, 1), "adsbShare": round(share, 4), "gatedOut": dropped,
            "antennaAboveWheelsM": ANTENNA_ABOVE_WHEELS_M,
            "gates": gates, "reported": report_only, "pass": all(g["pass"] for g in gates.values()),
        },
        "weather": None if not metar else {k: metar.get(k) for k in ("valid", "metar", "altimeterInHg", "tempC",
                                                                 "windDir", "windKt", "visibilityMi", "ceilingFt")},
        "source": {"archive": "adsb.lol globe_history", "release": release, "licence": "ODbL-1.0",
                   "attribution": "Flight track: adsb.lol contributors, ODbL 1.0 (https://www.adsb.lol/)"},
    }
    report = {"landing": land, "t0": t0, "flare": flare_info, "calibration": cal}
    return Baked(header=header, channels=channels, t_epoch=t_out, report=report)


def write_flight(out_dir, baked):
    out_dir.mkdir(parents=True, exist_ok=True)
    fid = baked.header["id"]
    blob = b"".join(baked.channels[k].astype("<f4").tobytes() for k in CHANNELS)
    (out_dir / f"{fid}.bin").write_bytes(blob)
    (out_dir / f"{fid}.json").write_text(json.dumps(baked.header, indent=1) + "\n")
    return out_dir / f"{fid}.json", out_dir / f"{fid}.bin"


def index_entry(header, tz):
    from zoneinfo import ZoneInfo
    td = datetime.fromisoformat(header["touchdown"].replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
    start = next((e["t"] for e in header["events"] if e["id"] == "terrain"), 0)
    return {"id": header["id"], "runway": header["runway"], "aircraftType": header["aircraftType"],
            "date": td.strftime("%Y-%m-%d"), "localTime": td.strftime("%H:%M"), "touchdown": header["touchdown"],
            "duration": header["samples"] * header["dt"], "samples": header["samples"], "start": start,
            "badges": header["badges"], "header": f"{header['id']}.json", "data": f"{header['id']}.bin",
            "preview": None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--allow-fail", action="store_true")
    a = ap.parse_args()
    from datetime import date as _date

    from lib.frame import create_frame
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    frame = create_frame(city)
    airport = json.loads((ROOT / "public" / "data" / a.city / "airport.json").read_text())
    terrain = json.loads((ROOT / "public" / "data" / a.city / "terrain.json").read_text())
    w = terrain["grids"]["wide"]
    wide = (w["x0"], w["y0"], w["x0"] + (w["nx"] - 1) * w["step"], w["y0"] + (w["ny"] - 1) * w["step"])
    sel_dir = ROOT / "data" / "flights" / a.city
    selection = json.loads((sel_dir / "selection.json").read_text())
    out_dir = ROOT / "public" / "data" / a.city / "flights"
    index_path = out_dir / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"format": "skyline-flight-index/1",
                                                                           "flights": []}
    failed = False
    for f in selection["flights"]:
        if a.ids and f["id"] not in a.ids:
            continue
        raw = sel_dir / f["raw"]
        with gzip.open(raw, "rt") as fh:
            files = json.load(fh)
        files = files if isinstance(files, list) else [files]
        p = adsb.stitch(*[adsb.points(tr) for tr in files])
        td = datetime.fromisoformat(f["touchdown"].replace("Z", "+00:00")).timestamp()
        rows, _ = iem_day(city, _date.fromisoformat(f["touchdown"][:10]))
        metar = metar_near(rows, td, city.get("stationElevationM", airport["arp"]["elevation"]))
        baked = bake(p, airport, frame, metar=metar, runway=f["runway"], flight_id=f["id"], wide=wide,
                     release=f["release"], aircraft_type=f["type"], touchdown_epoch=td)
        baked.header["city"] = a.city
        qa = baked.header["qa"]
        for k, g in qa["gates"].items():
            print(f"  {k:26s} {str(g['value']):>18s}  {'ok' if g['pass'] else 'FAIL'}{' (warn)' if g.get('warn') else ''}")
        jpath, bpath = write_flight(out_dir, baked)
        print(f"{f['id']}: {baked.header['samples']} samples, {jpath.stat().st_size} + {bpath.stat().st_size} bytes;"
              f" calibration {qa['calibration']['method']} {qa['altitudeOffsetM']} m ({qa['datum']})")
        entry = index_entry(baked.header, city["tz"])
        index["flights"] = [e for e in index["flights"] if e["id"] != f["id"]] + [entry]
        index["flights"].sort(key=lambda e: e["id"])
        if not qa["pass"]:
            failed = True
    index["attribution"] = "Flight tracks: adsb.lol contributors, ODbL 1.0 (https://www.adsb.lol/)"
    index_path.write_text(json.dumps(index, indent=1) + "\n")
    if failed and not a.allow_fail:
        raise SystemExit("a quality gate failed")


if __name__ == "__main__":
    main()
