# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Usage: uv run scripts/build_aerosol_climatology.py <city>

A monthly aerosol climatology for dates before the aerosol feed begins (plan 01, section 6.1, finding 2; task T5.4).

Source: Open-Meteo's air-quality API (CAMS global, 0.4 deg), hourly `aerosol_optical_depth` (550 nm, whole column),
`dust`, `pm10` and `pm2_5` at the city origin, from 4 August 2022 (the first non-null hour) to the end of the last
complete month. One request per year, one at a time, a generic User-Agent, cached under data/raw/weather/aerosol/.

Output: public/data/<city>/aerosol.json
    months[12]  { month, hours, aod550Median, aod550Mean, aod550P90, dustUgM3, pm10UgM3, pm25UgM3 }  (medians but the mean)
    seasons     { DJF, MAM, JJA, SON }: the mean optical depth
    period, source, attribution
The app reads it only when it needs a date the feed does not cover (src/weather/service.js).
"""
import datetime as dt
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.fetch import cached_get  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIRST = dt.date(2022, 8, 4)
AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"
VARS = "aerosol_optical_depth,dust,pm10,pm2_5"
SEASONS = {"DJF": (12, 1, 2), "MAM": (3, 4, 5), "JJA": (6, 7, 8), "SON": (9, 10, 11)}


def last_complete_month_end(today: dt.date) -> dt.date:
    return today.replace(day=1) - dt.timedelta(days=1)


def fetch_hours(city: dict, city_id: str, end: dt.date) -> list[dict]:
    hours = []
    start = FIRST
    while start <= end:
        stop = min(dt.date(start.year, 12, 31), end)
        url = (f"{AIR}?latitude={city['origin']['lat']:.4f}&longitude={city['origin']['lon']:.4f}"
               f"&start_date={start}&end_date={stop}&timeformat=unixtime&hourly={VARS}")
        print(f"  {city_id} {start} to {stop}", file=sys.stderr)
        _, body = cached_get(url, ROOT / "data" / "raw" / "weather" / "aerosol" / f"{city_id}-{start}-{stop}.json")
        h = json.loads(body)["hourly"]
        for i, t in enumerate(h["time"]):
            hours.append({"t": t, "aod": h["aerosol_optical_depth"][i], "dust": h["dust"][i], "pm10": h["pm10"][i], "pm25": h["pm2_5"][i]})
        start = stop + dt.timedelta(days=1)
    return hours


def quantile(values: list[float], q: float) -> float:
    s = sorted(values)
    i = (len(s) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def climatology(hours: list[dict]) -> dict:
    """Monthly statistics over every year: hours with no optical depth are skipped."""
    by_month = {m: [] for m in range(1, 13)}
    for h in hours:
        if h["aod"] is None:
            continue
        by_month[dt.datetime.fromtimestamp(h["t"], dt.timezone.utc).month].append(h)
    months = []
    for m, rows in by_month.items():
        if not rows:
            raise SystemExit(f"no aerosol data for month {m}")
        aod = [r["aod"] for r in rows]
        med = lambda k: round(statistics.median([r[k] for r in rows if r[k] is not None]), 1)
        months.append({"month": m, "hours": len(rows), "aod550Median": round(statistics.median(aod), 3),
                       "aod550Mean": round(statistics.fmean(aod), 3), "aod550P90": round(quantile(aod, 0.9), 3),
                       "dustUgM3": med("dust"), "pm10UgM3": med("pm10"), "pm25UgM3": med("pm25")})
    seasons = {}
    for name, ms in SEASONS.items():
        aod = [h["aod"] for m in ms for h in by_month[m]]
        seasons[name] = round(statistics.fmean(aod), 3)
    return {"months": months, "seasons": seasons}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    city_id = sys.argv[1]
    city = json.loads((ROOT / "data" / "cities.json").read_text())[city_id]
    end = last_complete_month_end(dt.date.today())
    hours = fetch_hours(city, city_id, end)
    doc = {"product": "monthly aerosol climatology", "city": city_id,
           "source": "Open-Meteo air-quality API (CAMS global, 0.4 deg), hourly at the city origin",
           "attribution": "Generated using Copernicus Atmosphere Monitoring Service information",
           "period": [FIRST.isoformat(), end.isoformat()], "built": dt.date.today().isoformat(),
           "units": {"aod550": "optical depth at 550 nm, whole column", "dustUgM3": "µg/m³ near the surface", "pm10UgM3": "µg/m³", "pm25UgM3": "µg/m³"},
           **climatology(hours)}
    out = ROOT / "public" / "data" / city_id / "aerosol.json"
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out.relative_to(ROOT)}: seasons {doc['seasons']}", file=sys.stderr)


if __name__ == "__main__":
    main()
