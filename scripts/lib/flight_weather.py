"""The weather a recorded flight was flown in (plan 03, sections 6.4, 4.2 and 7.7; F2.8's as-flown weather, F5.3's
input): a record in the flight's header that the app flies without any weather data of its own.

  Inputs   the airport's ASOS reports around the arrival (Iowa Environmental Mesonet, public; already cached for the
           bake in data/flights/<city>/weather/<id>.json under "asos") and the GFS column at the airport by pressure
           level: temperature, relative humidity, cloud cover and geopotential height, with the surface precipitation
           and cloud cover (Open-Meteo historical forecast API, CC BY 4.0, model data NOAA; cached under
           "aloftClouds", fetched by fetch_aloft below with the generic client name of lib.flight_net).

What is derived, deterministically (every rule is here, and the record says which numbers are observed and which are
estimated):

  reports      every report from an hour before the recording starts to an hour after touchdown (not one report)
  surface      at touchdown: the two reports around it interpolated (temperature, dew point, visibility, altimeter,
               wind as a vector); the gust and the present weather are the nearest report's
  layers       the nearest report's layers: amount and base OBSERVED (heights above the aerodrome); genus by plan 01's
               rule (src/weather/derive.js genusFor); top ESTIMATED from the GFS column at touchdown: the first height
               above the base where the model's cloud cover by level falls below 50 %, else where its relative humidity
               falls below 90 %, else plan 01's depth for the genus (derive.js topFor); never into the layer above.
               Where an overcast hides the sky the model's own cloud above its top (cover 50 % or more) is added and
               marked so; nothing else is added from the model.
  precipitation  from the reports alone: present weather at each report and the begin/end remarks (RAB41, RAE23)
               make a timeline; whatever falls while the flight is in the air is the record's, its rate from plan 01's
               table for the intensity (derive.js RATE). No precipitation reported, no rain.
  at a height  in cloud inside a broken or overcast layer (a few or scattered clouds are taken as passed between);
               visibility: the surface report's below the lowest base ("10 miles or more" counts as clear), an
               ESTIMATE inside a layer by genus (IN_CLOUD_VISIBILITY_M), clear above; rain below the top of the
               layer it falls from. The layers are taken as the same over the whole track: the record has one station
               and one model column, both at the airport.
  badge        section 4.2's words: rain, overcast (broken or overcast), wind (15 kt or gusts of 20 kt), scattered,
               clear (nothing or a few clouds), in that order.
"""
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import numpy as np

FORMAT = "skyline-flight-weather/1"
FT = 0.3048
SM = 1609.344
INHG_HPA = 33.8639
BADGES = ("clear", "scattered", "overcast", "rain", "wind")

#: Layer cover by METAR amount (plan 01, src/weather/derive.js COVER).
COVER = {"FEW": 0.19, "SCT": 0.44, "BKN": 0.75, "OVC": 1.0, "VV": 1.0}
#: In cloud inside a layer at least this covered (broken: five eighths).
IN_CLOUD_COVER = 0.5
#: Visibility inside a layer, m. ESTIMATED: Gultepe et al. (2006), Vis = 1.002 / (LWC Nd)^0.6473 km, with 0.2 g/m3 and
#: 150 drops/cm3 in low stratiform cloud (about 110 m), 0.1 g/m3 and 100/cm3 in mid-level cloud (about 230 m); ice
#: cloud a few kilometres.
IN_CLOUD_VISIBILITY_M = {"st": 110.0, "sc": 110.0, "cu": 110.0, "tcu": 110.0, "cb": 110.0, "ac": 230.0, "as": 230.0,
                         "ci": 3000.0, "cs": 3000.0}
#: The app's clear visibility (src/flight/env.js CLEAR_VISIBILITY_M).
CLEAR_VISIBILITY_M = 80000.0
#: Thresholds of the top estimate: model cloud cover by level (%) and relative humidity (%).
TOP_CLOUD_PCT = 50.0
TOP_RH_PCT = 90.0
#: Precipitation rate by kind and intensity (light, moderate, heavy), mm/h (plan 01, derive.js RATE).
RATE = {"drizzle": (0.2, 0.5, 1.0), "rain": (1.0, 4.0, 10.0), "snow": (0.5, 1.5, 4.0), "hail": (5.0, 15.0, 40.0)}
PRECIP = {"DZ": "drizzle", "RA": "rain", "SN": "snow", "GR": "hail", "GS": "hail", "PL": "rain", "UP": "rain"}
#: Wind badge: sustained or gusting at least this, kt.
WIND_KT, GUST_KT = 15.0, 20.0
#: The levels asked for (hPa): everything GFS has from the airport's surface to the top of the weather.
LEVELS_HPA = (1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150)
SURFACE_VARS = ("precipitation", "rain", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
                "visibility", "freezing_level_height")
OPEN_METEO = "https://historical-forecast-api.open-meteo.com/v1/forecast"


# --- fetching (the bake's online path only) -----------------------------------------------------------------------

def aloft_params(lat, lon, day):
    v = []
    for lev in LEVELS_HPA:
        v += [f"geopotential_height_{lev}hPa", f"temperature_{lev}hPa", f"relative_humidity_{lev}hPa",
              f"cloud_cover_{lev}hPa"]
    return {"latitude": round(lat, 3), "longitude": round(lon, 3), "start_date": day, "end_date": day,
            "hourly": ",".join(v + list(SURFACE_VARS)), "models": "gfs_seamless", "timezone": "GMT"}


def fetch_aloft(lat, lon, day, raw_dir: Path):
    """The day's GFS column with humidity and cloud cover by level (dict), and its URL; cached under raw_dir."""
    import json
    from lib import flight_net
    from lib.fetch import cached_get
    flight_net.apply()
    url = OPEN_METEO + "?" + urlencode(aloft_params(lat, lon, day))
    cache = Path(raw_dir) / f"gfs-clouds-{round(lat, 3)}_{round(lon, 3)}-{day}.json"
    _, body = cached_get(url, cache)
    return json.loads(body), url


# --- reports -------------------------------------------------------------------------------------------------------

def _num(r, k):
    v = r.get(k)
    if v in (None, "", "M", "T"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _iso_min(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _precip_of(codes):
    """The precipitation at the station among present-weather codes: {kind, intensity, code} or None."""
    best = None
    for c in codes:
        if c.startswith("VC") or "VIRGA" in c:
            continue
        inten = "heavy" if c.startswith("+") else "light" if c.startswith("-") else "moderate"
        body = c.lstrip("+-")
        for i in range(0, len(body) - 1, 2):
            kind = PRECIP.get(body[i:i + 2])
            if kind:
                rate = RATE[kind][("light", "moderate", "heavy").index(inten)]
                if best is None or rate > best[0]:
                    best = (rate, {"kind": kind, "intensity": inten, "code": c})
    return best[1] if best else None


_TEMP_BODY = re.compile(r"\s(M?\d{2})/(M?\d{2})?\s")
_TEMP_RMK = re.compile(r"\sT([01])(\d{3})([01])(\d{3})\b")
_REMARK_EVENTS = re.compile(r"\b((?:(?:SH|FZ)?(?:DZ|RA|SN|GR|GS|PL|UP))(?:[BE]\d{2,4})+)+")


def _remark_events(metar, epoch):
    """Begin and end times of precipitation in a report's remarks: [(epoch, kind, on)]."""
    if " RMK " not in metar:
        return []
    rmk = metar.split(" RMK ", 1)[1]
    out = []
    base = datetime.fromtimestamp(epoch, timezone.utc)
    for tok in rmk.split():
        for m in re.finditer(r"((?:SH|FZ)?(DZ|RA|SN|GR|GS|PL|UP))((?:[BE]\d{2,4})+)", tok):
            kind = PRECIP[m.group(2)]
            for be, hhmm in re.findall(r"([BE])(\d{4}|\d{2})", m.group(3)):
                if len(hhmm) == 4:
                    t = base.replace(hour=int(hhmm[:2]), minute=int(hhmm[2:]), second=0).timestamp()
                else:
                    t = base.replace(minute=int(hhmm), second=0).timestamp()
                    if t > epoch:
                        t -= 3600
                if t > epoch:
                    t -= 86400
                out.append((t, kind, be == "B"))
    return out


def parse_report(r, station_elev):
    """One IEM ASOS row (as cached) as the record's report: times, temperature and dew point (the T group's tenths
    when the report has one), wind, visibility, altimeter, layers (amount, base ft above the aerodrome) and present
    weather; `precipitation` is what falls at the station, or None."""
    metar = r.get("metar", "") or ""
    epoch = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
    temp = dew = None
    m = _TEMP_RMK.search(" " + metar + " ")
    if m:
        temp = (-1 if m.group(1) == "1" else 1) * int(m.group(2)) / 10
        dew = (-1 if m.group(3) == "1" else 1) * int(m.group(4)) / 10
    else:
        b = _TEMP_BODY.search(" " + metar.split(" RMK ")[0] + " ")
        if b:
            temp = int(b.group(1).replace("M", "-"))
            dew = int(b.group(2).replace("M", "-")) if b.group(2) else None
    if temp is None and _num(r, "tmpf") is not None:
        temp = round((_num(r, "tmpf") - 32) / 1.8, 2)
    layers = []
    for i in (1, 2, 3):
        c = r.get(f"skyc{i}")
        if c in COVER and _num(r, f"skyl{i}") is not None:
            layers.append({"cover": c, "baseFtAgl": int(round(_num(r, f"skyl{i}")))})
    codes = [c for c in (r.get("wxcodes") or "").split() if c not in ("M",)]
    vis_mi = _num(r, "vsby")
    return {
        "epoch": epoch, "valid": _iso_min(epoch), "metar": metar,
        "tempC": temp, "dewPointC": dew,
        "windDir": _num(r, "drct"), "windKt": _num(r, "sknt"), "gustKt": _num(r, "gust"),
        "visibilityMi": vis_mi, "visibilityM": None if vis_mi is None else round(vis_mi * SM, 1),
        "visibilityCensored": vis_mi is not None and vis_mi >= 10,
        "altimeterInHg": _num(r, "alti"),
        "layers": layers, "wx": codes, "precipitation": _precip_of(codes),
        "events": _remark_events(metar, epoch),
    }


def reports_in_window(reports, start_epoch, td_epoch):
    """The reports from an hour before the recording starts to an hour after touchdown, oldest first."""
    return sorted((r for r in reports if start_epoch - 3600 <= r["epoch"] <= td_epoch + 3600), key=lambda r: r["epoch"])


def _around(reports, epoch):
    reps = sorted(reports, key=lambda r: r["epoch"])
    before = [r for r in reps if r["epoch"] <= epoch]
    after = [r for r in reps if r["epoch"] > epoch]
    b = before[-1] if before else None
    a = after[0] if after else None
    nearest = min((x for x in (b, a) if x), key=lambda r: abs(r["epoch"] - epoch))
    return b, a, nearest


def surface_at(reports, epoch, station_elev):
    """The surface at an instant: the two reports around it interpolated, gust and present weather the nearest's."""
    b, a, n = _around(reports, epoch)
    f = 0.0 if not (b and a) else (epoch - b["epoch"]) / (a["epoch"] - b["epoch"])

    def lerp(k):
        if b and a and b.get(k) is not None and a.get(k) is not None:
            return b[k] + (a[k] - b[k]) * f
        return n.get(k)
    # wind as a vector (toward east, north), so a calm or a veer interpolates sensibly
    def vec(r):
        if r.get("windKt") is None:
            return None
        d = math.radians(r.get("windDir") or 0.0)
        return np.array([-r["windKt"] * math.sin(d), -r["windKt"] * math.cos(d)])
    vb, va = (vec(b) if b else None), (vec(a) if a else None)
    v = vb + (va - vb) * f if vb is not None and va is not None else (vec(n) if vec(n) is not None else np.zeros(2))
    kt = float(np.hypot(*v))
    wdir = (math.degrees(math.atan2(-v[0], -v[1])) % 360) if kt > 0.05 else 0.0
    temp, dew, alti = lerp("tempC"), lerp("dewPointC"), lerp("altimeterInHg")
    vis = lerp("visibilityM")
    censored = bool((b or n)["visibilityCensored"] and (a or n)["visibilityCensored"])
    p_station = None if alti is None else station_pressure(alti * INHG_HPA, station_elev)
    return {
        "tempC": _r(temp, 2), "dewPointC": _r(dew, 2),
        "rh": None if temp is None or dew is None else round(rh_from(temp, dew), 3),
        "windDir": round(wdir, 1), "windKt": round(kt, 1), "gustKt": n.get("gustKt"),
        "visibilityM": _r(vis, 1), "visibilityCensored": censored,
        "altimeterInHg": _r(alti, 3), "pressureHPa": _r(p_station, 2), "wx": n["wx"],
        "from": [x["valid"] for x in (b, a) if x] if (b and a) else [n["valid"]],
    }


def _r(v, n):
    return None if v is None else round(float(v), n)


def station_pressure(altimeter_hpa, elevation_m):
    """Station pressure from an altimeter setting and the station's height (NOAA's formula; plan 01 derive.js)."""
    return (altimeter_hpa ** 0.190263 - 8.417286e-5 * elevation_m) ** (1 / 0.190263)


def rh_from(temp_c, dew_c):
    """Relative humidity (0..1) over water (Magnus; plan 01 schema.js rhFrom)."""
    e = lambda c: math.exp(17.625 * c / (243.04 + c))  # noqa: E731
    return min(1.0, max(0.0, e(dew_c) / e(temp_c)))


# --- the column ----------------------------------------------------------------------------------------------------

def column_at(resp, epoch, station_elev, surface=None):
    """The GFS column at an instant: rows [height m above sea level, pressure hPa, temperature C, relative humidity
    %, cloud cover %], levels above the station only, interpolated between the hours; the surface (from the reports)
    first when given."""
    h = resp["hourly"]
    times = np.array([datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() for s in h["time"]])
    rows = []
    if surface and surface.get("pressureHPa") is not None:
        rh = rh_from(surface["tempC"], surface["dewPointC"]) * 100 if surface.get("dewPointC") is not None else None
        rows.append([station_elev, round(surface["pressureHPa"], 2), round(surface["tempC"], 2),
                     None if rh is None else round(rh, 2), None])
    for lev in LEVELS_HPA:
        keys = [f"geopotential_height_{lev}hPa", f"temperature_{lev}hPa", f"relative_humidity_{lev}hPa",
                f"cloud_cover_{lev}hPa"]
        if not all(k in h for k in keys):
            continue
        cols = [np.array([np.nan if v is None else v for v in h[k]], dtype=float) for k in keys]
        ok = np.all([np.isfinite(c) for c in cols], axis=0)
        if ok.sum() < 1:
            continue
        z, t, rh, cc = (float(np.interp(epoch, times[ok], c[ok])) for c in cols)
        if z <= station_elev + 1:
            continue
        rows.append([round(z, 1), lev, round(t, 2), round(rh, 1), round(cc, 1)])
    rows.sort(key=lambda r: r[0])
    return rows


def surface_model_at(resp, epoch):
    """The model's surface precipitation (mm in the hour), cloud cover (%) and visibility (m) at an instant."""
    h = resp["hourly"]
    times = np.array([datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() for s in h["time"]])
    out = {}
    for k in SURFACE_VARS:
        if k not in h:
            continue
        c = np.array([np.nan if v is None else v for v in h[k]], dtype=float)
        ok = np.isfinite(c)
        out[k] = round(float(np.interp(epoch, times[ok], c[ok])), 2) if ok.any() else None
    return out


def _profile(col, idx):
    pts = [(r[0], r[idx]) for r in col if r[idx] is not None]
    return pts


def _value_at(pts, z):
    if not pts:
        return None
    if z <= pts[0][0]:
        return pts[0][1]
    for (z0, v0), (z1, v1) in zip(pts, pts[1:]):
        if z <= z1:
            return v0 + (v1 - v0) * (z - z0) / (z1 - z0)
    return pts[-1][1]


def _falls_below(pts, z_from, threshold):
    """The first height above z_from where the profile falls below threshold (interpolated), or None. The profile
    must be at or above it at z_from."""
    v_from = _value_at(pts, z_from)
    if v_from is None or v_from < threshold:
        return None
    z0, v0 = z_from, v_from
    for z1, v1 in pts:
        if z1 <= z_from:
            continue
        if v1 < threshold:
            return z0 + (z1 - z0) * (v0 - threshold) / (v0 - v1)
        z0, v0 = z1, v1
    return None


# --- layers --------------------------------------------------------------------------------------------------------

def genus_for(fraction, agl):
    """Plan 01's genus for a reported layer (derive.js genusFor, not convective)."""
    if agl < 2000:
        return "st" if agl < 300 and fraction >= 0.75 else "sc" if fraction >= 0.6 else "cu"
    if agl < 6000:
        return "as" if fraction >= 0.75 else "ac"
    return "cs" if fraction >= 0.75 else "ci"


def depth_for(genus):
    """Plan 01's assumed depth of a layer, m (derive.js topFor without a freezing level)."""
    return {"st": 300, "sc": 600, "cu": 1000, "ac": 500, "as": 2000, "cs": 1500}.get(genus, 1000)


def _top(base, genus, col):
    cc, rh = _profile(col, 4), _profile(col, 3)
    z = _falls_below(cc, base, TOP_CLOUD_PCT)
    if z is not None:
        return z, "estimated: where the GFS cloud cover by level falls below 50 %"
    z = _falls_below(rh, base, TOP_RH_PCT)
    if z is not None:
        return z, "estimated: where the GFS relative humidity falls below 90 %"
    return base + depth_for(genus), "estimated: plan 01's depth for the genus (the model column does not show it)"


def layers_at(reports, epoch, col, station_elev):
    """The cloud layers at an instant: the nearest report's, with observed bases and estimated tops (module notes)."""
    _, _, n = _around(reports, epoch)
    out = []
    for L in n["layers"]:
        frac = COVER[L["cover"]]
        agl = L["baseFtAgl"] * FT
        g = genus_for(frac, agl)
        base = station_elev + agl
        top, how = _top(base, g, col)
        out.append({"cover": L["cover"], "fraction": frac, "genus": g, "baseM": round(base, 1), "topM": round(top, 1),
                    "base": "observed", "top": how, "source": f"METAR {n['valid']}"})
    out.sort(key=lambda L: L["baseM"])
    # a layer never reaches into the one above it
    for lo, hi in zip(out, out[1:]):
        if lo["topM"] > hi["baseM"]:
            lo["topM"] = hi["baseM"]
            lo["top"] += "; cut at the base of the layer above"
    # above an overcast the observer sees nothing: the model's own cloud there, marked so
    if out and out[-1]["fraction"] >= 1.0:
        cc = _profile(col, 4)
        z = out[-1]["topM"]
        above = [(zz, v) for zz, v in cc if zz > z]
        i = 0
        while i < len(above):
            if above[i][1] >= TOP_CLOUD_PCT:
                j = i
                while j + 1 < len(above) and above[j + 1][1] >= TOP_CLOUD_PCT:
                    j += 1
                base, top = above[i][0], (above[j + 1][0] if j + 1 < len(above) else above[j][0] + 500)
                frac = max(v for _, v in above[i:j + 1]) / 100
                g = genus_for(frac, base - station_elev)
                out.append({"cover": "BKN" if frac < 1 else "OVC", "fraction": round(frac, 2), "genus": g,
                            "baseM": round(base, 1), "topM": round(top, 1),
                            "base": "estimated: GFS cloud cover by level (hidden from the observer by the overcast)",
                            "top": "estimated: GFS cloud cover by level", "source": "GFS"})
                i = j + 1
            i += 1
    return out


# --- precipitation -------------------------------------------------------------------------------------------------

def precipitation_over(reports, t0, t1):
    """What fell between t0 and t1 (epoch s), from the reports alone: {rateMmH, kind, intensity, from}. Each report
    says what falls at its time (present weather) and when precipitation began or ended (remarks); the latest of these
    before an instant holds until the next."""
    events = []
    for r in reports:
        kinds_now = {r["precipitation"]["kind"]: r["precipitation"]} if r["precipitation"] else {}
        for kind in RATE:
            events.append((r["epoch"], kind, kind in kinds_now, kinds_now.get(kind), r["valid"]))
        for t, kind, on in r["events"]:
            events.append((t, kind, on, None, r["valid"] + " remarks"))
    events.sort(key=lambda e: (e[0], 0 if e[3] is None else 1))
    state, best, crossed = {}, None, False

    def consider(kind, info):
        nonlocal best
        inten = info["intensity"] if info else "light"
        rate = RATE[kind][("light", "moderate", "heavy").index(inten)]
        if best is None or rate > best["rateMmH"]:
            best = {"rateMmH": rate, "kind": kind, "intensity": inten, "from": info["code"] if info else "remarks"}

    def falling_now():
        for kind, (on, info) in state.items():
            if on:
                consider(kind, info)
    for t, kind, on, info, _src in events:
        if t > t1:
            break
        if not crossed and t >= t0:
            crossed = True
            falling_now()               # what was already falling when the window opened
        if t >= t0 and on:
            consider(kind, info or state.get(kind, (False, None))[1])
        state[kind] = (on, info if on else None)
    if not crossed:
        falling_now()
    return best or {"rateMmH": 0.0, "kind": "none", "intensity": None, "from": None}


# --- at the aircraft -----------------------------------------------------------------------------------------------

def layer_at(alt, layers):
    for L in layers:
        if L["baseM"] <= alt <= L["topM"]:
            return L
    return None


def in_cloud(alt, layers):
    L = layer_at(alt, layers)
    return bool(L and L["fraction"] >= IN_CLOUD_COVER)


def visibility_at(alt, layers, surface_visibility_m, censored=False):
    L = layer_at(alt, layers)
    if L and L["fraction"] >= IN_CLOUD_COVER:
        return IN_CLOUD_VISIBILITY_M.get(L["genus"], 110.0)
    low = min((x["baseM"] for x in layers), default=math.inf)
    if alt < low and surface_visibility_m and not censored:
        return float(surface_visibility_m)
    return CLEAR_VISIBILITY_M


def _rain_top(layers):
    thick = [L for L in layers if L["fraction"] >= IN_CLOUD_COVER]
    return thick[0]["topM"] if thick else (layers[0]["topM"] if layers else math.inf)


def rain_at(alt, layers, precip):
    if not precip or precip.get("rateMmH", 0) <= 0 or precip.get("kind") not in ("rain", "drizzle"):
        return 0.0
    return float(precip["rateMmH"]) if alt <= _rain_top(layers) else 0.0


def in_cloud_intervals(t, h, layers):
    """Runs of samples in cloud: [[t from, t to]] in the track's seconds."""
    inside = np.array([in_cloud(float(x), layers) for x in h])
    out, i = [], 0
    while i < len(inside):
        if inside[i]:
            j = i
            while j + 1 < len(inside) and inside[j + 1]:
                j += 1
            out.append([round(float(t[i]), 1), round(float(t[j]), 1)])
            i = j + 1
        else:
            i += 1
    return out


# --- the badge -----------------------------------------------------------------------------------------------------

def badge(layers, precip, surface):
    """Section 4.2's weather word: rain, overcast, wind, scattered, clear (in that order)."""
    if precip and precip.get("rateMmH", 0) > 0:
        return "rain"
    top = max((L["fraction"] for L in layers), default=0.0)
    if top >= COVER["BKN"]:
        return "overcast"
    if (surface.get("windKt") or 0) >= WIND_KT or (surface.get("gustKt") or 0) >= GUST_KT:
        return "wind"
    if top >= COVER["SCT"]:
        return "scattered"
    return "clear"


# --- the record ----------------------------------------------------------------------------------------------------

def record(asos, aloft, *, start_epoch, td_epoch, end_epoch, t, h, station_elev, station):
    """The header's `weather`: everything above for one flight. asos and aloft are the cached sections of the
    weather inputs ({source, url, fetched, rows | response}); t and h the track's seconds and heights (m above sea
    level, the wheels)."""
    reports_all = [parse_report(r, station_elev) for r in asos["rows"]]
    reps = reports_in_window(reports_all, start_epoch, td_epoch)
    surf = surface_at(reps or reports_all, td_epoch, station_elev)
    col = column_at(aloft["response"], td_epoch, station_elev, surface=surf)
    layers = layers_at(reps or reports_all, td_epoch, col, station_elev)
    precip = precipitation_over(reports_all, start_epoch, end_epoch)
    vis_below = surf["visibilityM"]
    return {
        "format": FORMAT,
        "about": "The weather this flight was flown in, from the airport's reports and the GFS column at the airport "
                 "(scripts/lib/flight_weather.py). Layer bases, visibility, present weather and the surface are "
                 "observed; layer tops, the column and the visibility inside cloud are estimated. The layers are "
                 "taken as the same over the whole track.",
        "station": station, "stationElevationM": station_elev,
        "window": [_iso_min(start_epoch - 3600), _iso_min(td_epoch + 3600)],
        "reports": [{"t": round(r["epoch"] - start_epoch), "valid": r["valid"], "metar": r["metar"],
                     "tempC": r["tempC"], "dewPointC": r["dewPointC"], "windDir": r["windDir"], "windKt": r["windKt"],
                     "gustKt": r["gustKt"], "visibilityM": r["visibilityM"],
                     "visibilityCensored": r["visibilityCensored"], "altimeterInHg": r["altimeterInHg"],
                     "layers": r["layers"], "wx": r["wx"]} for r in reps],
        "surface": surf,
        "layers": layers,
        "precipitation": precip,
        "visibility": {"belowBaseM": vis_below, "belowBaseCensored": surf["visibilityCensored"],
                       "inCloudM": IN_CLOUD_VISIBILITY_M, "clearM": CLEAR_VISIBILITY_M,
                       "note": "below the lowest base the report's (10 miles or more counts as clear); inside a "
                               "broken or overcast layer an estimate by genus (Gultepe et al. 2006); clear elsewhere"},
        "inCloudCover": IN_CLOUD_COVER,
        "inCloud": in_cloud_intervals(t, h, layers),
        "aloft": col,
        "aloftNote": "height m above sea level, pressure hPa, temperature C, relative humidity %, cloud cover % "
                     "(GFS by level at touchdown, interpolated between the hours; the first row is the surface report)",
        "model": surface_model_at(aloft["response"], td_epoch),
        "badge": badge(layers, precip, surf),
        "sources": [
            {"what": "surface reports", "source": asos["source"], "url": asos["url"], "fetched": asos["fetched"]},
            {"what": "the column by level", "source": aloft["source"], "url": aloft["url"],
             "fetched": aloft["fetched"]},
        ],
    }
