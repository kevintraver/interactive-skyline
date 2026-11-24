# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "requests"]
# ///
"""Usage: find_arrivals.py <city> <YYYY-MM-DD> [--extract ICAO --id FLIGHT_ID --touchdown ISO]

Turn the traces fetch_adsb_day.py kept for one UTC day into a list of candidate arrivals at the city's airport,
with the runway of each and the metrics of plan 03 section 6.2's selection criteria, so that a person (or the
orchestrating session) can pick flights against them.

  Input   data/raw/adsb/<date>/*.json.gz (fetch_adsb_day.py), with the previous and next day's folders if present
          (a flight that crosses 00:00Z is stitched from two files); public/data/<city>/airport.json; the day's
          METAR reports from the Iowa Environmental Mesonet ASOS archive (cached under data/raw/iem/).
  Output  data/flights/<city>/candidates-<date>.csv, one row per landing, best first.

Metrics, per landing: runway end and lateral offset, go-around before it, sun elevation and light at touchdown,
minutes of trace before touchdown, altitude 24 minutes out, share of ADS-B positions, share of airborne points
with geometric altitude, the longest gaps above 18,000 ft, below 10,000 ft and in the last 5 km, seconds of
surface positions after touchdown, where the aircraft came from, and the METAR. `qualifies` is true when every
criterion of 6.2 that one flight can meet is met (aircraft, completeness, position source, gaps, ground, approach).

--extract writes data/flights/<city>/raw/<id>.trace.json.gz: the aircraft's trace_full file(s) for the day, as a
JSON list, so that bake_flight.py can run without the archive.
"""
import argparse
import csv
import gzip
import json
import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import adsb, geodesy  # noqa: E402
from lib.frame import create_frame  # noqa: E402

import bake_flight  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "adsb"
FT = 0.3048
PREFERRED_TYPE = "B738"
ACCEPTABLE = ("B738", "B38M", "B737", "B739")


def _gaps(t):
    return float(np.diff(t).max()) if len(t) > 1 else float("inf")


def metrics(p, landing, airport, frame, metar_rows, station_elev):
    td = landing["t"]
    i = landing["index"]
    x, n = (np.asarray(v) for v in frame.to_local(p.lat, p.lon))
    prev = np.flatnonzero(p.ground & (p.t < td - 120))
    leg_start = p.t[prev[-1]] if len(prev) else p.t[0]
    win = (p.t >= max(td - 1800, leg_start)) & (p.t <= td + 600)
    share = adsb.adsb_share(p.take(win))
    pf = adsb.filter_sources(p.take(win & (p.t <= td + 1800)))
    air = ~pf.ground & (pf.t < td)
    geom_share = float(np.isfinite(pf.alt_geom_ft[air]).mean()) if air.any() else 0.0
    alt = np.where(np.isfinite(pf.alt_geom_ft), pf.alt_geom_ft, pf.alt_baro_ft)
    hi = air & (alt > 18000)
    lo = air & (alt < 10000)
    fx, fn = (np.asarray(v) for v in frame.to_local(pf.lat, pf.lon))
    last5 = air & (np.hypot(fx - landing["x"], fn - landing["n"]) < 5000) & (pf.t > td - 300)
    # the gap that straddles touchdown counts in the last 5 km as well (the first surface position after a gap is
    # flagged stale and filtered out, so the touchdown instant itself closes the series)
    t_last5 = np.concatenate([pf.t[last5], [td]])
    j = i
    while j + 1 < len(p) and p.ground[j + 1] and p.t[j + 1] - p.t[j] < 120:
        j += 1
    ground_s = float(p.t[j] - p.t[i]) if landing["surface"] else 0.0
    a24 = np.flatnonzero(air & (np.abs(pf.t - (td - 1440)) < 60))
    alt24 = float(np.interp(td - 1440, pf.t[air], alt[air])) if len(a24) else float("nan")
    k24 = int(np.argmin(np.abs(p.t - (td - 1440))))
    from_deg = math.degrees(math.atan2(x[k24] - airport["arp"]["x"], n[k24] - airport["arp"]["y"])) % 360
    sun = geodesy.sun_elevation(td, airport["arp"]["lat"], airport["arp"]["lon"])
    m = bake_flight.metar_near(metar_rows, td, station_elev) if metar_rows else {}
    row = {
        "touchdown": datetime.fromtimestamp(td, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "runway": landing["runway"], "surface": landing["surface"], "lateralM": landing["lateral"],
        "goAround": landing["goAround"],
        "sunDeg": round(sun, 1), "light": geodesy.light_of(sun),
        "traceMin": round((td - leg_start) / 60, 1), "alt24Ft": None if math.isnan(alt24) else int(alt24),
        "adsbShare": round(share, 4), "geomShare": round(geom_share, 4),
        "gapAbove18kS": round(_gaps(pf.t[hi]), 1) if hi.sum() > 1 else None,
        "gapBelow10kS": round(_gaps(pf.t[lo]), 1) if lo.sum() > 1 else None,
        "gapLast5kmS": round(_gaps(t_last5), 1) if len(t_last5) > 1 else None,
        "groundS": round(ground_s, 1), "fromDeg": round(from_deg), "from": bake_flight._bearing_name(from_deg),
        "windDir": m.get("windDir"), "windKt": m.get("windKt"), "visibilityMi": m.get("visibilityMi"),
        "ceilingFt": m.get("ceilingFt"), "wx": m.get("wx"),
    }
    checks = {
        "complete": row["traceMin"] >= 26 and (row["alt24Ft"] or 0) >= 30000,
        "source": share >= 0.98 and geom_share >= 0.95,
        "gaps": ((row["gapAbove18kS"] or 0) <= 30 and (row["gapBelow10kS"] or 1e9) <= 15
                 and (row["gapLast5kmS"] or 1e9) <= 10),
        "ground": ground_s >= 60,
        "approach": not landing["goAround"] and landing["runway"] in ("19L", "19R", "26L", "26R"),
    }
    row["fails"] = ",".join(k for k, ok in checks.items() if not ok)
    row["qualifies"] = all(checks.values())
    return row


def load_day(day):
    """{icao: [trace dicts]} for the day, with the neighbouring days' files of the same aircraft if present."""
    out = {}
    for f in sorted((RAW / f"{day:%Y-%m-%d}").glob("*.json.gz")):
        out[f.name[:-8]] = [adsb.load(f)]
    for other in (day - timedelta(days=1), day + timedelta(days=1)):
        d = RAW / f"{other:%Y-%m-%d}"
        for icao in out:
            f = d / f"{icao}.json.gz"
            if f.exists():
                out[icao].append(adsb.load(f))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("day")
    ap.add_argument("--extract")
    ap.add_argument("--id")
    a = ap.parse_args()
    day = date.fromisoformat(a.day)
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    frame = create_frame(city)
    airport = json.loads((ROOT / "public" / "data" / a.city / "airport.json").read_text())
    out_dir = ROOT / "data" / "flights" / a.city
    out_dir.mkdir(parents=True, exist_ok=True)
    if a.extract:
        traces = load_day(day)[a.extract]
        dest = out_dir / "raw" / f"{a.id}.trace.json.gz"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(gzip.compress(json.dumps(traces, separators=(",", ":")).encode(), mtime=0))
        print(f"{dest}: {dest.stat().st_size} bytes, {len(traces)} file(s)")
        return
    rows_metar, url = bake_flight.iem_day(city, day)
    station_elev = city.get("stationElevationM", airport["arp"]["elevation"])
    tz = ZoneInfo(city["tz"])
    rows = []
    for icao, traces in load_day(day).items():
        p = adsb.stitch(*[adsb.points(t) for t in traces])
        typ = traces[0].get("t")
        for landing in adsb.find_landings(p, airport, frame):
            if not (day.isoformat() <= datetime.fromtimestamp(landing["t"], timezone.utc).date().isoformat()
                    <= day.isoformat()):
                continue
            r = metrics(p, landing, airport, frame, rows_metar, station_elev)
            local = datetime.fromtimestamp(landing["t"], tz)
            rows.append({"icao": icao, "type": typ, "localTime": local.strftime("%H:%M"), **r})
    rows.sort(key=lambda r: (not r["qualifies"], r["type"] != PREFERRED_TYPE, r["touchdown"]))
    dest = out_dir / f"candidates-{day:%Y-%m-%d}.csv"
    with dest.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    by_rwy = {}
    for r in rows:
        by_rwy[r["runway"]] = by_rwy.get(r["runway"], 0) + 1
    print(f"{dest}: {len(rows)} landings {by_rwy}; {sum(r['qualifies'] for r in rows)} qualify; METAR {url}")


if __name__ == "__main__":
    main()
