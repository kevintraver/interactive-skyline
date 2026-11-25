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
from lib import flight_net  # noqa: E402,F401  (the generic client name for outside services)
from lib import adsb, attitude, config_schedule, geodesy, smooth  # noqa: E402
from lib import qa as qa_lib  # noqa: E402

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
SIGMA_V_GROUND = 3.0         # m/s: recorded ground velocity after touchdown (section 7.2 gives 1 m/s in the air)
FLAP_LIMIT_KT = config_schedule.FLAP_LIMIT_KT
# Section 5.5's bits, as settled on 24 November and read by src/flight/track.js.
LIGHT = config_schedule.LIGHT
LANDING_FLAP = 30            # section 7.3: 30 or 40; the bake cannot tell them apart, 30 is the common choice
RECORDED_LIMITS = {"roll": 4.0, "heading": 3.0, "iasKt": 8.0}   # section 7.2, reported (not gated) in Phase 2


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
    flight_net.apply()
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
         aircraft_type=None, touchdown_epoch=None, upper_air=None, upper_air_source=None, published=None):
    """Bake one arrival from the points of its trace (all sources). `upper_air`: atmosphere rows from the upper-air
    archive (true-north axes; lib.wind_aloft), or None for the surface report on a power-law profile. `published`:
    {runway end: {"angles": [...]}} from the CIFP (data/flights/<city>/cifp-<ICAO>.json), PUBLISHED without it.
    Returns Baked."""
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
    rate_is_geom = pf.vrate_is_geom[keep]
    dropped = int((~keep).sum())
    ob = ob.take(keep)
    # points sent in the airborne format after the touchdown (a transponder that reports the surface format only
    # below a speed) are on the ground
    ob.ground = ob.ground | (ob.t >= td)
    # repeats of the last airborne velocity sent after the touchdown are not observed (smooth.stale_velocity)
    stale_v = smooth.stale_velocity(ob, td)
    ob.vx, ob.vn = np.where(stale_v, np.nan, ob.vx), np.where(stale_v, np.nan, ob.vn)
    t0 = math.ceil(max(t_first, ob.t[0]))
    # without surface positions the smoother runs on past the last point (on the recorded velocity) far enough
    # for the flare to find the runway
    horizon = math.floor(min(t_end, ob.t[-1])) if surface_rec else math.ceil(td + 30)
    t_out = np.arange(t0, horizon + 1, 1.0)

    # 4 Altitude: geometric minus the calibrated offset; barometric (corrected) where geometric is missing
    cal = calibrate(ob, td, airport, metar, frame, arp_xy, end)
    # the atmosphere (section 6.4): upper-air rows with the surface report blended in underneath, or the surface
    # report on a power-law profile; true-north axes here
    station_elev = metar["stationElevation"] if metar else airport["arp"]["elevation"]
    m_dir = metar.get("windDir") if metar else None
    m_kt = (metar.get("windKt") or 0.0) if metar else 0.0
    m_temp = metar["tempC"] if metar else 15.0 - 0.0065 * station_elev
    if upper_air:
        rows_true = attitude.merge_surface(upper_air, m_dir, m_kt, m_temp, station_elev)
        atm_source = upper_air_source or "upper-air archive"
    else:
        rows_true = attitude.surface_profile(m_dir, m_kt, m_temp, station_elev)
        atm_source = "the surface report on a power-law profile, ISA lapse from the surface temperature"
    # A barometric vertical rate (flag 4 unset) is the pressure altitude's: in air warmer than standard the height
    # changes T / T_isa times faster (6.8 % on a 31 C evening in September), and the smoother, which weighs the
    # rate heavily, would otherwise lag the recorded heights by metres on the final
    baro_rate = ~rate_is_geom
    rate_factor = attitude.geometric_rate_factor(rows_true, np.nan_to_num(ob.h - cal["offsetM"],
                                                                          nan=airport["arp"]["elevation"]))
    ob.vz = np.where(baro_rate & ~ob.ground, ob.vz * rate_factor, ob.vz)
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
    # on the runway the recorded speed lags and steps through the change to the surface format; the positions
    # (sigma 3 m there) lead
    sig_v = np.where(ob.ground, SIGMA_V_GROUND, smooth.SIGMA_V)
    trk = smooth.smooth_track(ob, t_out, h_obs=h_obs, sigma_h=sig_h, sigma_pos=sig_pos, sigma_v=sig_v)
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

    # 8 Air data: wind from the upper-air rows with the surface report blended in underneath (or the surface report on
    # a power-law profile), turned from true north into the grid; air velocity = ground velocity - wind
    step = 30
    lat_s, lon_s = frame.to_geodetic(x[::step], n[::step])
    bearing = np.interp(t_out, t_out[::step], smooth.true_north_bearing(frame, lat_s, lon_s))
    we_t, wn_t = attitude.winds_at(rows_true, h)
    we, wn = attitude.to_grid(we_t, wn_t, bearing)
    lat_a, lon_a = frame.to_geodetic(*arp_xy)
    b_arp = float(smooth.true_north_bearing(frame, np.array([lat_a]), np.array([lon_a]))[0])
    rows_grid = []
    for r in rows_true:
        ge, gn = attitude.to_grid(r[2], r[3], b_arp)
        rows_grid.append([round(r[0], 1), round(r[1], 2), round(float(ge), 2), round(float(gn), 2)])
    dT = attitude.temp_offset(rows_true, h)
    vs = np.gradient(h, t_out)
    avx, avn = vx - we, vn - wn
    tas = np.sqrt(avx**2 + avn**2 + vs**2)
    ias = attitude.cas_from_tas(tas, h, dT)
    mach = attitude.mach(tas, h, dT)

    # 9 Attitude: heading from the air velocity (crab, taken off before touchdown), bank from its turn rate
    dt = 1.0
    gs = np.hypot(vx, vn)
    hdg, crab = attitude.heading(avx, avn, vx, vn, t=t_out, td=td, air=air)
    roll = attitude.bank(t_out, avx, avn, tas, air)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(n)))])

    # where the runway is: along-track distance to go to the threshold, established on final
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
    trk = np.degrees(np.arctan2(vx, vn))
    trk_off = np.abs((trk - end["gridHeading"] + 180) % 360 - 180)
    on_final = air & (along_thr < 0) & (np.abs(lat_thr) < np.maximum(150.0, 0.06 * np.abs(along_thr))) \
        & (trk_off < 20) & (np.arange(len(s)) <= i_thr)
    ias_kt = ias / KT

    # weight from the stabilised approach speed over the last 5 km (to 300 m before the threshold)
    stab = air & (to_go < 5000) & (to_go > 300)
    vapp = float(np.median(ias_kt[stab])) if stab.sum() >= 10 else None
    rwy_u = (math.sin(math.radians(end["gridHeading"])), math.cos(math.radians(end["gridHeading"])))
    sw_e, sw_n = attitude.to_grid(*attitude.wind_vector(m_dir, m_kt), b_arp)
    headwind_kt = -(sw_e * rwy_u[0] + sw_n * rwy_u[1]) / KT
    gust_kt = max(0.0, ((metar.get("gustKt") or 0.0) - m_kt)) if metar else 0.0
    weight = attitude.weight_from_approach(vapp, headwind_kt, gust_kt, LANDING_FLAP)

    # 10 Configuration and lights (section 7.3, lib.config_schedule)
    sun_td = geodesy.sun_elevation(td, airport["arp"]["lat"], airport["arp"]["lon"])
    sun = np.array([geodesy.sun_elevation(t, *frame.to_geodetic(x[i], n[i])) for i, t in
                    zip(range(0, len(t_out), 60), t_out[::60])])
    sun = np.interp(t_out, t_out[::60], sun)
    cfg = config_schedule.schedule(t=t_out, air=air, td=td, ias_kt=ias_kt, h=h, above_field=above_field,
                                   to_go=to_go, on_final=on_final, gs=gs, tas=tas, vs=vs, sun=sun, weight=weight,
                                   landing_flap=LANDING_FLAP)
    flap, slat, gear = cfg["flap"], cfg["slat"], cfg["gear"]
    speedbrake, ground_spoiler, reverser = cfg["speedbrake"], cfg["groundSpoiler"], cfg["reverser"]
    lights, cabin = cfg["lights"], cfg["cabinLight"]
    after = t_out >= td
    t_exit = cfg["vacateT"]
    gear_cmd = (t_out >= cfg["gearDownT"]).astype(float)

    # pitch: flight-path angle through the air plus the angle of attack from lift (lib.attitude), with the flare
    # limited to the reference raise and the nose lowered after touchdown
    pitch = attitude.pitch(t_out, tas, vs, h, flap=flap, bank=roll, weight=weight, air=air, td=td, dT=dT,
                           hagl=wheels)

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
    pub = sorted(set((published or PUBLISHED).get(end_id, {}).get("angles", [])
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
    flap_over = config_schedule.placard_exceedances(flap, ias_kt, air)
    gates["flapPlacard"] = {"value": len(flap_over), "max": 0, "pass": not flap_over}
    # F2.5's checks on the configuration: flaps only extend on the approach, gear before the landing flap, landing
    # lights on by 10,000 ft
    f_air = flap[air]
    gates["flapsMonotonic"] = {"value": int((np.diff(f_air) < -1e-6).sum()), "max": 0}
    gates["flapsMonotonic"]["pass"] = gates["flapsMonotonic"]["value"] == 0
    sel = {x["flap"]: x["t"] for x in cfg["selections"]}
    t_land = sel.get(cfg["landingFlap"])
    gates["gearBeforeLandingFlapS"] = {"value": None if t_land is None else round(t_land - cfg["gearDownT"], 1),
                                       "min": 0.1}
    gates["gearBeforeLandingFlapS"]["pass"] = t_land is not None and t_land > cfg["gearDownT"]
    k10 = np.flatnonzero(air & (h < 10000 * FT - 30))
    gates["landingLightBy10000ft"] = {"value": bool(len(k10) and np.all(lights[k10].astype(int) & LIGHT["landing"])),
                                      "pass": bool(len(k10) and np.all(lights[k10].astype(int) & LIGHT["landing"]))}
    # Where the trace recorded roll, heading or indicated airspeed (Comm-B replies to a ground radar, or the ADS-B
    # air-referenced velocity message), the RMS of the derived channel against it (section 7.2: reported)
    def at_points(ch, mask):
        return np.interp(pf.t[mask], t_out, ch)
    in_air_pts = (pf.t >= t_out[0]) & (pf.t < td - 2) & ~pf.ground
    rec_hdg = np.array([(st or {}).get("true_heading", np.nan) if isinstance(st, dict) else np.nan
                        for st in pf.state], dtype=float)
    rec_ias = np.where(np.isfinite(pf.ias_kt), pf.ias_kt,
                       np.array([(st or {}).get("ias", np.nan) if isinstance(st, dict) else np.nan
                                 for st in pf.state], dtype=float))
    report_only = {"heightBiasLast60sM": round(float(np.mean(herr[last60])), 2) if last60.any() else None,
                   "heightPointsLast60s": int(last60.sum())}
    for key, rec, model, angle, scale in (
            ("roll", pf.roll, roll, False, 1.0), ("iasKt", rec_ias, ias_kt, False, 1.0),
            ("heading", rec_hdg + smooth.true_north_bearing(frame, pf.lat, pf.lon), _unwrap_deg(hdg), True, 1.0)):
        m = in_air_pts & np.isfinite(rec)
        r = attitude.rms_against(at_points(model, m), rec[m], angle=angle) if m.sum() >= 3 else None
        report_only[key] = {"rms": None if r is None else round(r * scale, 2), "points": int(m.sum()),
                            "limit": RECORDED_LIMITS[key],
                            "within": None if r is None else bool(r <= RECORDED_LIMITS[key])}

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
    p_final = thr_xy - 3000 * u
    to_strip = -p_final
    strip_side = "right" if (u[1] * to_strip[0] - u[0] * to_strip[1]) > 0 else "left"
    light = geodesy.light_of(sun_td)
    clear = metar and (metar.get("visibilityMi") or 0) >= 10 and (metar.get("ceilingFt") is None or
                                                                  metar["ceilingFt"] >= 12000)
    prov = {k: "derived" for k in CHANNELS}
    prov.update({"x": "recorded", "n": "recorded", "h": "recorded", "s": "derived", "gs": "recorded",
                 "vs": "recorded", "hdg": "derived", "roll": "derived", "tas": "derived", "ias": "derived",
                 "pitch": "inferred", "turbulence": "derived"})
    prov.update(cfg["provenance"])
    sel_text = ", ".join("%d at %ds (%s)" % (x["flap"], round(x["t"] - t0), x["why"]) for x in cfg["selections"])
    td_t = round(td - t0, 2)
    header = {
        "format": FORMAT, "id": flight_id, "city": None, "airport": airport.get("icao"), "runway": end_id,
        "aircraftType": aircraft_type, "recordedStart": _iso(t0), "touchdown": _iso(td), "touchdownT": td_t,
        "dt": 1.0, "samples": int(len(t_out)), "channels": CHANNELS, "units": UNITS,
        "provenance": prov,
        "provenanceNotes": {
            "h": "ADS-B geometric altitude, calibrated on the runway; wheels = antenna - %.1f m (estimate); the "
                 "flare (last seconds before the recorded air-to-ground transition) is modelled" % ANTENNA_ABOVE_WHEELS_M,
            "tas": "ground velocity minus the wind of `atmosphere` (" + atm_source + ")",
            "ias": "calibrated airspeed for the true airspeed in the profile's temperature and the standard pressure",
            "hdg": "direction of the air velocity: the crab into the wind, taken off over the last %.0f s before "
                   "touchdown; the track on the ground" % attitude.DECRAB_S,
            "roll": "coordinated turn, atan(V w / g), from the turn rate of the air velocity; limited to 30 deg and "
                    "5 deg/s",
            "pitch": "flight-path angle through the air plus angle of attack from lift, CL = n W / (q S) with "
                     "alpha = alpha0(flap) + CL / CLalpha fitted to the reference attitudes of section 7.3; weight "
                     "%.1f t from the approach speed; the flare raises the nose at most %.0f deg; the nose comes "
                     "down over %.0f s after touchdown" % (weight / 1000, attitude.FLARE_RAISE_MAX,
                                                          attitude.DEROTATE_S),
            "turbulence": "30 s RMS of the recorded minus the smoothed vertical rate, 2 m/s = 1",
            **cfg["notes"],
            "flap": cfg["notes"]["flap"] + "; selected: " + sel_text,
        },
        "reconstructed": reconstructed + [{"from": int(max(0, round(flare_info["tf"] - t0))), "to": int(round(td - t0)),
                           "what": "flare: wheel height modelled from %.1f m to the runway" % flare_info["y0"]}],
        "events": events,
        "chapters": config_schedule.chapters(events, int(len(t_out) - 1)),
        "atmosphere": rows_grid,
        "atmosphereNote": "altitude m above sea level, temperature degC, wind toward grid east and grid north m/s (true "
                          "north turned into the city grid at the airport); " + atm_source + ", with the airport's "
                          "surface report blended in below %.0f m above it" % attitude.POWER_LAW_TOP_M,
        "inferred": {"weightKg": round(weight), "approachSpeedKt": None if vapp is None else round(vapp, 1),
                     "landingFlap": cfg["landingFlap"],
                     "flapSelections": [{"flap": x["flap"], "t": int(round(x["t"] - t0)), "why": x["why"]}
                                        for x in cfg["selections"]],
                     "gearDownT": int(round(cfg["gearDownT"] - t0)),
                     "joinFinalT": None if cfg["joinFinalT"] is None else int(round(cfg["joinFinalT"] - t0)),
                     "maxCrabDeg": round(float(np.abs(crab[air]).max()), 1) if air.any() else 0.0,
                     "maxMach": round(float(mach.max()), 3)},
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


def weather_inputs(city, airport, f, sel_dir, offline=False):
    """The weather a flight's bake reads, kept beside its raw extract (data/flights/<city>/weather/<id>.json) so the
    bake is reproducible without the network: the day's ASOS reports within three hours of touchdown (IEM) and the
    day's upper-air response (Open-Meteo, GFS pressure levels). Fetched once when missing, unless offline."""
    path = sel_dir / "weather" / f"{f['id']}.json"
    td = datetime.fromisoformat(f["touchdown"].replace("Z", "+00:00")).timestamp()
    if path.exists():
        return json.loads(path.read_text())
    if offline:
        raise SystemExit(f"{f['id']}: no {path.relative_to(ROOT)} (run bake_flight.py without --offline once)")
    from datetime import date as _date
    from lib import wind_aloft
    rows, iem_url = iem_day(city, _date.fromisoformat(f["touchdown"][:10]))

    def ts(r):
        return datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
    near = [r for r in rows if abs(ts(r) - td) <= 3 * 3600]
    upper, om_url = wind_aloft.fetch_day(airport["arp"]["lat"], airport["arp"]["lon"], f["touchdown"][:10],
                                         ROOT / "data" / "raw" / "openmeteo")
    out = {"about": "Weather inputs of the bake (plan 03, section 6.4), kept so the bake needs no network.",
           "asos": {"source": "Iowa Environmental Mesonet ASOS archive (public)", "url": iem_url,
                    "fetched": datetime.now(timezone.utc).date().isoformat(), "rows": near},
           "upperAir": {"source": "Open-Meteo historical forecast API, GFS pressure levels (CC BY 4.0; model data "
                                  "NOAA)", "url": om_url, "fetched": datetime.now(timezone.utc).date().isoformat(),
                        "response": upper}}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1) + "\n")
    return out


def bake_selected(city_id, ids=(), *, offline=False, write=True, out_dir=None):
    """Bake the selected flights of a city. Returns [(flight entry, Baked)] and the index; writes the files (and
    the index) unless write is False."""
    from lib.frame import create_frame
    city = json.loads((ROOT / "data" / "cities.json").read_text())[city_id]
    frame = create_frame(city)
    airport = json.loads((ROOT / "public" / "data" / city_id / "airport.json").read_text())
    terrain = json.loads((ROOT / "public" / "data" / city_id / "terrain.json").read_text())
    w = terrain["grids"]["wide"]
    wide = (w["x0"], w["y0"], w["x0"] + (w["nx"] - 1) * w["step"], w["y0"] + (w["ny"] - 1) * w["step"])
    sel_dir = ROOT / "data" / "flights" / city_id
    selection = json.loads((sel_dir / "selection.json").read_text())
    cifp_path = sel_dir / f"cifp-{city['icao']}.json"
    cifp = json.loads(cifp_path.read_text()) if cifp_path.exists() else None
    published = None
    if cifp:
        published = {}
        for a in cifp["approaches"].values():
            if a.get("glidePathDeg"):
                published.setdefault(a["runway"], {"angles": []})["angles"].append(a["glidePathDeg"])
    out_dir = out_dir or ROOT / "public" / "data" / city_id / "flights"
    index_path = out_dir / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"format": "skyline-flight-index/1",
                                                                           "flights": []}
    done = []
    for f in selection["flights"]:
        if ids and f["id"] not in ids:
            continue
        with gzip.open(sel_dir / f["raw"], "rt") as fh:
            files = json.load(fh)
        files = files if isinstance(files, list) else [files]
        p = adsb.stitch(*[adsb.points(tr) for tr in files])
        td = datetime.fromisoformat(f["touchdown"].replace("Z", "+00:00")).timestamp()
        wx = weather_inputs(city, airport, f, sel_dir, offline=offline)
        metar = metar_near(wx["asos"]["rows"], td, city.get("stationElevationM", airport["arp"]["elevation"]))
        upper = attitude.rows_from_open_meteo(wx["upperAir"]["response"], td) \
            if "hourly" in wx["upperAir"]["response"] else None
        baked = bake(p, airport, frame, metar=metar, runway=f["runway"], flight_id=f["id"], wide=wide,
                     release=f["release"], aircraft_type=f["type"], touchdown_epoch=td, upper_air=upper,
                     upper_air_source="Open-Meteo GFS pressure levels for the hour (section 6.4)" if upper else None,
                     published=published)
        baked.header["city"] = city_id
        end = airport["ends"][baked.header["runway"]]
        lat_t, lon_t = frame.to_geodetic(*end["threshold"][:2])
        north = float(smooth.true_north_bearing(frame, np.array([lat_t]), np.array([lon_t]))[0])
        baked.report["qa"] = qa_lib.report(baked.header, {k: v.astype(float) for k, v in baked.channels.items()},
                                           end, cifp, north)
        done.append((f, baked))
        entry = index_entry(baked.header, city["tz"])
        index["flights"] = [e for e in index["flights"] if e["id"] != f["id"]] + [entry]
    keep = {f["id"] for f in selection["flights"]}
    index["flights"] = sorted((e for e in index["flights"] if e["id"] in keep), key=lambda e: e["id"])
    index["attribution"] = "Flight tracks: adsb.lol contributors, ODbL 1.0 (https://www.adsb.lol/)"
    if write:
        qa_dir = sel_dir / "qa"
        qa_dir.mkdir(parents=True, exist_ok=True)
        for _, baked in done:
            write_flight(out_dir, baked)
            (qa_dir / f"{baked.header['id']}.json").write_text(json.dumps(baked.report["qa"], indent=1) + "\n")
        index_path.write_text(json.dumps(index, indent=1) + "\n")
    return done, index


def print_gates(baked):
    qa = baked.header["qa"]
    for k, g in qa["gates"].items():
        print(f"  {k:26s} {str(g['value']):>18s}  {'ok' if g['pass'] else 'FAIL'}{' (warn)' if g.get('warn') else ''}")
    print(f"{baked.header['id']}: {baked.header['samples']} samples; calibration {qa['calibration']['method']} "
          f"{qa['altitudeOffsetM']} m ({qa['datum']}); weight {baked.header['inferred']['weightKg']} kg")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--allow-fail", action="store_true")
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    done, _ = bake_selected(a.city, a.ids, offline=a.offline)
    failed = False
    for _, baked in done:
        print_gates(baked)
        failed |= not baked.header["qa"]["pass"]
    if failed and not a.allow_fail:
        raise SystemExit("a quality gate failed")


if __name__ == "__main__":
    main()
