#!/usr/bin/env python3
"""Ground truth for the ephemeris tests (plan 01, section 8.2; task T1.2), written to tests/fixtures/.

    python3 scripts/fetch_test_fixtures.py [--city lv|slc|all] [--only bodies|days|usno]

- JPL Horizons (DE441): azimuth and elevation of the Sun, the Moon and five planets seen from each city's origin,
  airless and (Sun and Moon) refracted, at fixed pseudo-random instants from 1940 to 2040; for the Moon also its
  illuminated fraction, apparent magnitude, angular diameter and sub-observer point.
- JPL Horizons again: the Sun's airless elevation every minute through a set of local days, from which the times
  it crosses -0.833 deg (sunrise and sunset), -6, -12 and -18 deg are interpolated.
- The US Naval Observatory's API: sunrise, sunset and civil twilight for the same days, as published (to the minute).

Run by hand, never by the tests (they read the committed files). Horizons is not to be called from a browser and
asks for one request at a time; this script waits between requests and sends a generic User-Agent with nothing
about the person running it. Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures")
USER_AGENT = "interactive-skyline-fixtures/1.0"
PAUSE_S = 1.5
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
USNO = "https://aa.usno.navy.mil/api/rstt/oneday"

BODIES = {"sun": "10", "moon": "301", "mercury": "199", "venus": "299", "mars": "499", "jupiter": "599", "saturn": "699"}
REFRACTED = ("sun", "moon")
# instants per city, and days per city for the event times
INSTANTS = {"lv": 500, "slc": 100}
BATCH = 50
STANDARD_OFFSET_H = {"lv": -8, "slc": -7}
DAYS = {
    "lv": ["1945-01-15", "1950-02-01", "1955-03-15", "1960-04-01", "1965-05-15", "1970-06-21", "1975-07-01",
           "1980-08-15", "1985-09-01", "1990-10-15", "1995-11-01", "2000-12-21", "2005-01-01", "2010-02-15",
           "2015-03-20", "2020-04-15", "2023-10-14", "2026-03-23", "2026-06-21", "2026-09-22", "2026-11-22",
           "2026-12-21", "2030-05-01", "2038-08-01"],
    "slc": ["1948-06-21", "1962-12-21", "1977-03-20", "1991-09-23", "2002-02-08", "2012-07-04", "2020-01-01",
            "2026-03-23", "2026-06-21", "2026-11-22", "2033-10-01", "2040-04-15"],
}
EVENTS = {"sunrise": (-0.833, "rising"), "sunset": (-0.833, "setting"), "civilDawn": (-6, "rising"),
          "civilDusk": (-6, "setting"), "nauticalDawn": (-12, "rising"), "nauticalDusk": (-12, "setting"),
          "astronomicalDawn": (-18, "rising"), "astronomicalDusk": (-18, "setting")}


def load_city(city: str) -> dict:
    with open(os.path.join(ROOT, "data", "cities.json"), encoding="utf-8") as f:
        c = json.load(f)[city]
    return {"lat": c["origin"]["lat"], "lon": c["origin"]["lon"], "elevationM": c["base"], "zone": c["tz"]}


_last = [0.0]


def get(url: str, params: dict) -> bytes:
    wait = _last[0] + PAUSE_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            _last[0] = time.monotonic()
            return body
        except OSError as err:  # includes HTTPError and timeouts
            print(f"  retry {attempt + 1}: {err}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f"giving up on {url}")


def horizons(command: str, obs: dict, extra: dict) -> list[list[str]]:
    params = {"format": "json", "COMMAND": f"'{command}'", "EPHEM_TYPE": "OBSERVER", "CENTER": "'coord@399'",
              "COORD_TYPE": "GEODETIC", "SITE_COORD": f"'{obs['lon']},{obs['lat']},{obs['elevationM'] / 1000}'",
              "TIME_TYPE": "UT", "ANG_FORMAT": "DEG", "CSV_FORMAT": "YES", "EXTRA_PREC": "YES",
              "MAKE_EPHEM": "YES", "OBJ_DATA": "NO", **extra}
    result = json.loads(get(HORIZONS, params))["result"]
    if "$$SOE" not in result:
        raise SystemExit(f"Horizons said:\n{result[:2000]}")
    rows = result[result.index("$$SOE") + 5:result.index("$$EOE")].strip().splitlines()
    return [[c.strip() for c in row.split(",")] for row in rows]


def num(s: str) -> float | None:
    try:
        return float(s)
    except ValueError:
        return None  # "n.a."


def fetch_bodies(city: str, obs: dict) -> dict:
    rng = random.Random(f"skyline-{city}")
    jd0, jd1 = 2429629.5, 2466519.5  # 1940-01-01 and 2041-01-01, 0h UT
    instants = sorted(round(rng.uniform(jd0, jd1), 6) for _ in range(INSTANTS[city]))
    bodies = {}
    for name, command in BODIES.items():
        entry = {}
        for apparent in ("AIRLESS", "REFRACTED") if name in REFRACTED else ("AIRLESS",):
            quantities = "4,9,10,13,14,20" if name == "moon" and apparent == "AIRLESS" else "4"
            rows = []
            for i in range(0, len(instants), BATCH):
                part = instants[i:i + BATCH]
                print(f"  {city} {name} {apparent.lower()} {i + 1}-{i + len(part)}", file=sys.stderr)
                got = horizons(command, obs, {"TLIST_TYPE": "JD", "TLIST": " ".join(f"'{jd}'" for jd in part),
                                              "QUANTITIES": f"'{quantities}'", "APPARENT": apparent})
                if len(got) != len(part):
                    raise SystemExit(f"{name}: asked for {len(part)} rows, got {len(got)}")
                for r in got:
                    if quantities == "4":
                        rows.append([num(r[3]), num(r[4])])
                    else:  # az, el, APmag, S-brt, Illu%, Ang-diam, ObsSub-LON, ObsSub-LAT, delta, deldot
                        rows.append([num(r[3]), num(r[4]), num(r[5]), num(r[7]), num(r[8]), num(r[9]), num(r[10]),
                                     num(r[11])])
            entry[apparent.lower()] = rows
        bodies[name] = entry
    return {
        "source": "JPL Horizons API (DE441), observer table, geodetic site at the city origin; TIME_TYPE=UT (UT1 before 1962)",
        "observer": obs,
        "columns": {"airless": "azimuth deg, elevation deg (Moon also: APmag, Illu %, Ang-diam arcsec, ObsSub-LON deg, ObsSub-LAT deg, delta au)",
                    "refracted": "azimuth deg, elevation deg, Horizons' standard refraction"},
        "instantsJdUt": instants,
        "bodies": bodies,
    }


def crossing(series: list[tuple[float, float]], alt: float, which: str) -> float | None:
    for (t0, a0), (t1, a1) in zip(series, series[1:]):
        if which == "rising" and a0 < alt <= a1 or which == "setting" and a0 >= alt > a1:
            return t0 + (alt - a0) / (a1 - a0) * (t1 - t0)
    return None


def fetch_days(city: str, obs: dict) -> dict:
    out = []
    tz = STANDARD_OFFSET_H[city]
    for day in DAYS[city]:
        d = dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc) - dt.timedelta(hours=tz)
        print(f"  {city} sun day {day}", file=sys.stderr)
        rows = horizons("10", obs, {"START_TIME": f"'{d:%Y-%m-%d %H:%M}'",
                                    "STOP_TIME": f"'{d + dt.timedelta(days=1):%Y-%m-%d %H:%M}'",
                                    "STEP_SIZE": "'1m'", "QUANTITIES": "'4'", "APPARENT": "AIRLESS"})
        series = []
        for r in rows:
            stamp = r[0] + (":00" if r[0].count(":") == 1 else "")
            t = dt.datetime.strptime(stamp.split(".")[0], "%Y-%b-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
            series.append((t.timestamp() * 1000, float(r[4])))
        events = {k: crossing(series, alt, which) for k, (alt, which) in EVENTS.items()}
        out.append({"date": day, "dayStartUtcMs": d.timestamp() * 1000,
                    "events": {k: (round(v) if v is not None else None) for k, v in events.items()}})
    return {"source": "JPL Horizons API: the Sun's airless elevation every minute over the local standard-time day, "
                      "crossings interpolated linearly at -0.833 (rise, set), -6, -12 and -18 deg",
            "observer": obs, "standardOffsetH": tz, "days": out}


def fetch_usno(city: str, obs: dict) -> dict:
    tz = STANDARD_OFFSET_H[city]
    names = {"Rise": "sunrise", "Set": "sunset", "Begin Civil Twilight": "civilDawn", "End Civil Twilight": "civilDusk"}
    out = []
    for day in DAYS[city]:
        print(f"  {city} usno {day}", file=sys.stderr)
        data = json.loads(get(USNO, {"date": day, "coords": f"{obs['lat']},{obs['lon']}", "tz": str(tz), "dst": "false"}))
        y, m, d = (int(x) for x in day.split("-"))
        events = {}
        for e in data["properties"]["data"]["sundata"]:
            if e["phen"] in names:
                hh, mm = (int(x) for x in e["time"][:5].split(":"))
                local = dt.datetime(y, m, d, hh, mm, tzinfo=dt.timezone(dt.timedelta(hours=tz)))
                events[names[e["phen"]]] = round(local.timestamp() * 1000)
        out.append({"date": day, "events": events})
    return {"source": "US Naval Observatory API, rstt/oneday, local standard time, published to the minute",
            "observer": obs, "standardOffsetH": tz, "days": out}


def write(name: str, doc: dict) -> None:
    doc = {"fetched": dt.date.today().isoformat(), **doc}
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.relpath(path, ROOT)}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--city", default="all", choices=["lv", "slc", "all"])
    ap.add_argument("--only", choices=["bodies", "days", "usno"])
    ap.add_argument("--skip", choices=["bodies", "days", "usno"], action="append", default=[])
    a = ap.parse_args()
    for city in (["lv", "slc"] if a.city == "all" else [a.city]):
        obs = load_city(city)
        if a.only in (None, "bodies") and "bodies" not in a.skip:
            write(f"horizons/{city}-bodies.json", fetch_bodies(city, obs))
        if a.only in (None, "days") and "days" not in a.skip:
            write(f"horizons/{city}-sun-days.json", fetch_days(city, obs))
        if a.only in (None, "usno") and "usno" not in a.skip:
            write(f"usno/{city}-sun-days.json", fetch_usno(city, obs))


if __name__ == "__main__":
    main()
