# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Usage: uv run scripts/fetch_weather_fixtures.py [lv|slc|all] [--refresh]

Records the weather responses the unit and e2e tests read (plan 01, sections 6.1 and 8.2; task T5.2), one file per
city and day under tests/fixtures/weather/, named <city>-<day>.rec-<recording date>.json, plus one live window per
city (<city>-live.rec-<date>.json). Each file holds every upstream response for that day exactly as received:
Open-Meteo archive, historical forecast and air quality, the Iowa Environmental Mesonet's ASOS reports; for the
live window Open-Meteo forecast and air quality, aviationweather.gov and the NWS API.

The request templates mirror src/weather/sources.js (one day instead of one month). Requests go one at a time with a
pause, a generic User-Agent and nothing about the person running it (scripts/lib/fetch.py); responses are cached
under data/raw/weather/fixtures/<recording date>/, so a re-run on the same day sends nothing.

Decision 11 of plan 01 asks for fixtures recorded on or after 1 December 2026, once Open-Meteo has retired the HRRR
and NAM models. The first set was recorded on 22 November 2026, before that: record again after 1 December
(`uv run scripts/fetch_weather_fixtures.py all`), delete the older files, and re-run `pnpm test:unit`.
"""
import datetime as dt
import json
import sys
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.fetch import cached_get  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "weather"

MODEL_VARS = ["temperature_2m", "relative_humidity_2m", "dew_point_2m", "surface_pressure", "cloud_cover", "cloud_cover_low",
              "cloud_cover_mid", "cloud_cover_high", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation", "rain",
              "showers", "snowfall", "weather_code", "boundary_layer_height"]
LEVELS = [850, 700, 500, 300]
FORECAST_VARS = ["visibility", "cape", "lifted_index", "convective_inhibition", "freezing_level_height"] + [
    f"wind_{q}_{lvl}hPa" for lvl in LEVELS for q in ("speed", "direction")]
AIR_VARS = ["aerosol_optical_depth", "dust", "pm10", "pm2_5"]
FIRST = {"historicalForecast": "2021-07", "air": "2022-08-04"}

# The twelve recorded days of section 8.2 for Las Vegas, and a set for Salt Lake City. Found in the IEM archive.
DAYS = {
    "lv": {
        "2023-07-06": "clear: CLR all day, CAMS aerosols",
        "2020-09-08": "HZ: wildfire smoke, 5 to 6 SM, aerosols from climatology",
        "2022-10-23": "BLDU: gusts to 44 kt, 3 to 6 SM",
        "2023-08-20": "-RA BR with RAB/RAE remarks (Tropical Storm Hilary)",
        "2022-07-18": "+TSRA at 2156Z, LTG and CB remarks",
        "2021-07-31": "VCTS with VIRGA DSNT ALQDS, then -TSRA",
        "2024-01-23": "OVC003 to OVC050, BR, -DZ",
        "2019-12-07": "calm: 00000KT most of the day",
        "2024-05-20": "missing fields: a report without visibility or sky",
        "2023-09-30": "CLR under high cloud: the model has cirrus the automated station cannot see",
        "1975-07-14": "35SM, TCU DSNT in the remarks, no aerosol feed",
        "1940-01-15": "before the archive's observations begin (18 December 1948): model only",
    },
    "slc": {
        "2023-02-22": "SN: snow most of the day",
        "2023-02-04": "winter inversion: HZ and FG",
        "1975-07-14": "30SM, CB and VIRGA in the remarks",
        "1940-01-15": "model only",
    },
}


def q(base, params):
    return f"{base}?{urlencode(params, safe=',')}"


def coords(c):
    return {"latitude": f"{c['origin']['lat']:.4f}", "longitude": f"{c['origin']['lon']:.4f}"}


def day_requests(c, day):
    d = dt.date.fromisoformat(day)
    dates = {"start_date": day, "end_date": day}
    base = {**coords(c), **dates, "timeformat": "unixtime", "wind_speed_unit": "ms"}
    reqs = {"open-meteo": q("https://archive-api.open-meteo.com/v1/archive", {**base, "hourly": ",".join(MODEL_VARS)})}
    if day[:7] >= FIRST["historicalForecast"]:
        reqs["open-meteo-historical"] = q("https://historical-forecast-api.open-meteo.com/v1/forecast",
                                          {**base, "hourly": ",".join(FORECAST_VARS)})
    if day >= FIRST["air"]:
        reqs["open-meteo-air"] = q("https://air-quality-api.open-meteo.com/v1/air-quality",
                                   {**coords(c), **dates, "timeformat": "unixtime", "hourly": ",".join(AIR_VARS)})
    e = d + dt.timedelta(days=1)
    reqs["iem"] = q("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", {
        "station": c["iemStation"], "data": "all", "year1": d.year, "month1": d.month, "day1": d.day,
        "year2": e.year, "month2": e.month, "day2": e.day, "tz": "Etc/UTC", "format": "onlycomma", "latlon": "no",
        "elev": "no", "missing": "M", "trace": "T", "direct": "no"}) + "&report_type=3&report_type=4"
    return reqs


def live_requests(c):
    base = {**coords(c), "timeformat": "unixtime", "wind_speed_unit": "ms"}
    return {
        "open-meteo": q("https://api.open-meteo.com/v1/forecast",
                        {**base, "hourly": ",".join(MODEL_VARS + FORECAST_VARS), "past_days": "1", "forecast_days": "8"}),
        "open-meteo-air": q("https://air-quality-api.open-meteo.com/v1/air-quality",
                            {**coords(c), "timeformat": "unixtime", "hourly": ",".join(AIR_VARS), "past_days": "1", "forecast_days": "5"}),
        "aviationweather": f"https://aviationweather.gov/api/data/metar?ids={c['icao']}&format=json&hours=24",
        "nws": f"https://api.weather.gov/stations/{c['icao']}/observations?limit=40",
    }


def record(city, label, day, note, reqs, rec, refresh):
    responses = {}
    for source, url in reqs.items():
        print(f"  {city} {label} {source}", file=sys.stderr)
        ctype, body = cached_get(url, ROOT / "data" / "raw" / "weather" / "fixtures" / rec / f"{city}-{label}-{source}", refresh)
        text = body.decode("utf-8")
        responses[source] = {"url": url, "contentType": ctype, "body": json.loads(text) if "json" in ctype else text}
    doc = {"recorded": rec, "city": city, "label": label, "day": day, "note": note,
           "warning": "Recorded before Open-Meteo retired HRRR and NAM (end of November 2026): record again after 1 December 2026."
           if rec < "2026-12-01" else None, "responses": responses}
    path = OUT / f"{city}-{label}.rec-{rec}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} kB)", file=sys.stderr)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    refresh = "--refresh" in sys.argv
    which = args[0] if args else "all"
    cities = json.loads((ROOT / "data" / "cities.json").read_text())
    rec = dt.date.today().isoformat()
    for city in (["lv", "slc"] if which == "all" else [which]):
        c = cities[city]
        for day, note in DAYS[city].items():
            record(city, day, day, note, day_requests(c, day), rec, refresh)
        record(city, "live", rec, "the live window: a day back, a week ahead", live_requests(c), rec, refresh)


if __name__ == "__main__":
    main()
