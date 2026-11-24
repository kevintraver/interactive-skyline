# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests"]
# ///
"""Usage: build_airport.py <city> [--faa LAS] [--cycle YYYY-MM-DD]

v0 of the airport (plan 03, F1.1): the runways of the city's airport in the app frame, from the FAA NASR airport
CSV bundle. For each runway end: its position and elevation, the landing threshold (displaced or not), true and
app-grid alignment, touchdown-zone elevation, the visual glide slope indicator (type, lights, side, angle, crossing
height), approach-light code, markings and lights; for each runway its length, width, surface and a linear
elevation profile from end to end through any displaced thresholds.

  Airport  data/cities.json, the city's "airport": {"faa": ...} block; --faa when the block is absent.
  Source   FAA NASR 28-day subscription, airport CSV bundle for the cycle in effect today (or --cycle):
           https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip (US government work).
           Built on 2026-11-23 from the cycle effective 2026-10-29. Cached under data/raw/nasr/.
  Frame    scripts/lib/frame.py (the transverse Mercator of src/world/frame.js). NASR positions are NAD 83, about
           a metre from WGS-84 here; the difference is ignored.
  Output   public/data/<city>/airport.json   heights in metres above sea level, x east and y north in metres
"""
import argparse
import json
import math
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import nasr  # noqa: E402
from lib.frame import create_frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FT = 0.3048


def _r(v, nd=2):
    return None if v is None else round(float(v), nd)


def _xy(frame, lat, lon):
    x, y = frame.to_local(lat, lon)
    return float(x), float(y)


def runway_elevation(rwy, s):
    """Elevation (m) at `s` metres along a runway from its first end, by its linear profile."""
    prof = rwy["profile"]
    if s <= prof[0][0]:
        return prof[0][1]
    for (s0, z0), (s1, z1) in zip(prof, prof[1:]):
        if s <= s1:
            return z0 + (z1 - z0) * (s - s0) / (s1 - s0) if s1 > s0 else z1
    return prof[-1][1]


def build_runways(rows, faa, frame):
    """The airport dict (without the build metadata) from NASR rows of one airport."""
    base = next(r for r in rows["APT_BASE"] if r["ARPT_ID"] == faa)
    rwys = [r for r in rows["APT_RWY"] if r["ARPT_ID"] == faa]
    ends_rows = [r for r in rows["APT_RWY_END"] if r["ARPT_ID"] == faa]
    lat, lon = float(base["LAT_DECIMAL"]), float(base["LONG_DECIMAL"])
    ax, ay = _xy(frame, lat, lon)
    ends = {}
    for e in ends_rows:
        name = nasr.end_name(e["RWY_END_ID"])
        elat, elon = float(e["LAT_DECIMAL"]), float(e["LONG_DECIMAL"])
        ex, ey = _xy(frame, elat, elon)
        z = nasr.num(e["RWY_END_ELEV"]) * FT
        disp_len = nasr.num(e["DISPLACED_THR_LEN"])
        if e["LAT_DISPLACED_THR_DECIMAL"].strip() and disp_len:
            tlat, tlon = float(e["LAT_DISPLACED_THR_DECIMAL"]), float(e["LONG_DISPLACED_THR_DECIMAL"])
            tx, ty = _xy(frame, tlat, tlon)
            tz = (nasr.num(e["DISPLACED_THR_ELEV"]) or nasr.num(e["RWY_END_ELEV"])) * FT
        else:
            tlat, tlon, tx, ty, tz = elat, elon, ex, ey, z
        papi = nasr.vgsi(e["VGSI_CODE"])
        if papi is not None:
            papi = {**papi, "angle": nasr.num(e["VISUAL_GLIDE_PATH_ANGLE"]),
                    "crossingHeightFt": int(nasr.num(e["THR_CROSSING_HGT"]) or 0) or None,
                    "code": e["VGSI_CODE"].strip()}
        tdz = nasr.num(e["TDZ_ELEV"])
        ends[name] = {
            "id": name, "nasrId": e["RWY_END_ID"].strip(), "runway": e["RWY_ID"].strip(),
            "lat": elat, "lon": elon, "end": [_r(ex), _r(ey), _r(z)],
            "thresholdLat": tlat, "thresholdLon": tlon, "threshold": [_r(tx), _r(ty), _r(tz)],
            "displacedM": _r((disp_len or 0) * FT),
            "trueHeading": nasr.num(e["TRUE_ALIGNMENT"]),
            "tdzElevation": _r(tdz * FT if tdz else None),
            "thresholdCrossingHeightFt": nasr.num(e["THR_CROSSING_HGT"]),
            "papi": papi,
            "approachLights": e["APCH_LGT_SYSTEM_CODE"].strip() or None,
            "ils": e["ILS_TYPE"].strip() or None,
            "marking": e["RWY_MARKING_TYPE_CODE"].strip() or None,
            "endIdentifierLights": nasr.flag(e["RWY_END_LGTS_FLAG"]),
            "centerlineLights": nasr.flag(e["CNTRLN_LGTS_AVBL_FLAG"]),
            "tdzLights": nasr.flag(e["TDZ_LGT_AVBL_FLAG"]),
            "landingDistanceFt": nasr.num(e["LNDG_DIST_AVBL"]),
        }
    runways = []
    for r in rwys:
        a, b = (nasr.end_name(p) for p in r["RWY_ID"].split("/"))
        ea, eb = ends[a], ends[b]
        dx, dy = eb["end"][0] - ea["end"][0], eb["end"][1] - ea["end"][1]
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        ea["gridHeading"] = _r(math.degrees(math.atan2(ux, uy)) % 360, 3)
        eb["gridHeading"] = _r(math.degrees(math.atan2(-ux, -uy)) % 360, 3)
        along = lambda p: (p[0] - ea["end"][0]) * ux + (p[1] - ea["end"][1]) * uy  # noqa: E731
        prof = {0.0: ea["end"][2], round(length, 2): eb["end"][2]}
        for e in (ea, eb):
            if e["displacedM"]:
                prof[round(along(e["threshold"]), 2)] = e["threshold"][2]
        runways.append({
            "id": r["RWY_ID"].strip(), "ends": [a, b],
            "length": _r((nasr.num(r["RWY_LEN"]) or 0) * FT), "surveyedLength": _r(length),
            "width": _r((nasr.num(r["RWY_WIDTH"]) or 0) * FT),
            "surface": r["SURFACE_TYPE_CODE"].strip(), "treatment": r["TREATMENT_CODE"].strip() or None,
            "edgeLights": r["RWY_LGT_CODE"].strip() or None,
            "direction": [_r(ux, 6), _r(uy, 6)],
            "profile": [[_r(s), _r(z)] for s, z in sorted(prof.items())],
        })
    runways.sort(key=lambda r: r["id"])
    return {
        "faa": faa, "icao": base["ICAO_ID"].strip() or None, "name": base["ARPT_NAME"].strip(),
        "arp": {"lat": lat, "lon": lon, "x": _r(ax), "y": _r(ay), "elevation": _r(nasr.num(base["ELEV"]) * FT)},
        "magneticVariation": (nasr.num(base["MAG_VARN"]) or 0) * (1 if base["MAG_HEMIS"].strip() == "E" else -1),
        "beacon": {"colors": base["BCN_LENS_COLOR"].strip() or None, "schedule": base["BCN_LGT_SKED"].strip() or None},
        "runways": runways,
        "ends": dict(sorted(ends.items())),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--faa")
    ap.add_argument("--cycle")
    a = ap.parse_args()
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    faa = (city.get("airport") or {}).get("faa") or a.faa
    if not faa:
        raise SystemExit("no airport: add an airport block to cities.json or pass --faa")
    from lib.fetch import cached_get  # requests is needed only to download

    cycle = date.fromisoformat(a.cycle) if a.cycle else nasr.cycle_for(date.today())
    url = nasr.zip_url(cycle)
    zpath = ROOT / "data" / "raw" / "nasr" / url.rsplit("/", 1)[-1]
    cached_get(url, zpath)
    rows = nasr.read_zip(zpath, faa)
    if not rows["APT_BASE"]:
        raise SystemExit(f"{faa} is not in {url}")
    out = {"format": "skyline-airport/0", "city": a.city, **build_runways(rows, faa, create_frame(city)),
           "source": {"nasr": url, "cycle": cycle.isoformat(), "licence": "US government work (FAA)",
                      "frame": "scripts/lib/frame.py", "datum": "NAD 83 taken as WGS-84; heights above sea level"}}
    dest = ROOT / "public" / "data" / a.city / "airport.json"
    dest.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{dest}: {len(out['runways'])} runways, {len(out['ends'])} ends ({dest.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
