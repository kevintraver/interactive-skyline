# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests"]
# ///
"""Usage: fetch_adsb_day.py <city> <YYYY-MM-DD> [--release TAG] [--types B738,B38M,B737,B739]
                           [--radius-km 12] [--below-ft 8000] [--near LAT,LON]
       fetch_adsb_day.py <city> --wind-days [--from YYYY-MM-DD] [--to YYYY-MM-DD]

Keep, from one UTC day of the adsb.lol archive, the traces of the listed aircraft types that come near the city's
airport, without storing the day. The day's GitHub release (two tar parts of 1.5 to 2 GB) is read as one HTTP
stream into tarfile's streaming mode; each member is looked at in memory and only those that pass the first filter
(a listed type, then a point within `radius-km` of the airport below `below-ft` or on the ground) are written.

  Source  adsb.lol globe_history, https://github.com/adsblol/globe_history_<year> (ODbL-1.0; see
          https://www.adsb.lol/docs/open-data/historical/). One release per UTC day and server, e.g.
          v2025.10.14-planes-readsb-staging-0 with .tar.aa and .tar.ab. Each repository's PREFERRED_RELEASES.txt
          names the better copy of a day; this script takes it unless --release is given.
  Where   The airport's reference point from public/data/<city>/airport.json (build_airport.py), or --near.
  Output  data/raw/adsb/<date>/<hex>.json.gz      one gzip member per kept aircraft, as in the archive
          data/raw/adsb/<date>/manifest.json      release, URLs, sizes, counts, what was kept, when
          (data/raw is git-ignored; this folder is kept under 1 GB and the run stops if the disk falls under 5 GB)

--wind-days ranks days by the hours of daylight wind that favours landing on runway 19 at Las Vegas (a tailwind
on 26 and a headwind on 19), from the Iowa Environmental Mesonet ASOS archive for the city's `iemStation`
(https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py), so that a day is chosen before anything is
downloaded. The response is cached under data/raw/iem/.
"""
import argparse
import csv
import io
import json
import math
import shutil
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import adsb, geodesy  # noqa: E402
from lib import flight_net  # noqa: E402,F401  (the generic client name)
from lib.fetch import UA, cached_get  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "adsb"
TYPES = ("B738", "B38M", "B737", "B739")
MIN_FREE = 5 * 1024**3
MIN_FREE_RUNNING = 1024**3
MAX_KEPT = 1024**3
API = "https://api.github.com/repos/adsblol/globe_history_{year}/releases/tags/{tag}"
PREFERRED = "https://raw.githubusercontent.com/adsblol/globe_history_{year}/main/PREFERRED_RELEASES.txt"


def free_bytes(path=ROOT):
    return shutil.disk_usage(path).free


def preferred_release(day: date):
    """The tag PREFERRED_RELEASES.txt names for a day (prod-0 if the day is not listed)."""
    url = PREFERRED.format(year=day.year)
    _, body = cached_get(url, RAW / f"PREFERRED_RELEASES_{day.year}.txt")
    stem = f"v{day:%Y.%m.%d}-planes-readsb-"
    for line in body.decode().splitlines():
        for part in line.split(","):
            name = part.rsplit("/", 1)[-1]
            if name.startswith(stem) and name.endswith(".tar.aa"):
                return name[: -len(".tar.aa")]
    return stem + "prod-0"


def release_assets(day: date, tag: str):
    """[(name, size, url)] of the tar parts of a release, in order."""
    cache = RAW / f"{day:%Y-%m-%d}" / "release.json"
    _, body = cached_get(API.format(year=day.year, tag=tag), cache)
    rel = json.loads(body)
    parts = sorted((a["name"], a["size"], a["browser_download_url"]) for a in rel.get("assets", [])
                   if ".tar." in a["name"])
    if not parts:
        raise SystemExit(f"release {tag} has no tar parts")
    return parts


def http_opener(url):
    def open_at(offset):
        r = requests.get(url, headers={**UA, "Range": f"bytes={offset}-"}, stream=True, timeout=(30, 300))
        if r.status_code not in (200, 206):
            r.close()
            raise ConnectionError(f"HTTP {r.status_code}")
        if offset and r.status_code != 206:
            r.close()
            raise ConnectionError("server ignored the range")
        r.raw.decode_content = False
        return r.raw
    return open_at


def airport_ref(city_id, near_arg):
    if near_arg:
        lat, lon = (float(v) for v in near_arg.split(","))
        return lat, lon
    path = ROOT / "public" / "data" / city_id / "airport.json"
    if not path.exists():
        raise SystemExit(f"{path} is missing: run build_airport.py {city_id} first, or pass --near LAT,LON")
    a = json.loads(path.read_text())
    return a["arp"]["lat"], a["arp"]["lon"]


def fetch_day(city_id, day: date, tag=None, types=TYPES, radius_km=12.0, below_ft=8000.0, near=None):
    out = RAW / f"{day:%Y-%m-%d}"
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text()).get("complete"):
        print(f"{day}: already fetched ({manifest_path})")
        return json.loads(manifest_path.read_text())
    if free_bytes() < MIN_FREE:
        raise SystemExit(f"only {free_bytes() / 1024**3:.1f} GB free; stopping before {day}")
    tag = tag or preferred_release(day)
    parts = release_assets(day, tag)
    lat, lon = airport_ref(city_id, near)
    ref = adsb.Near(lat=lat, lon=lon, radius_m=radius_km * 1000, below_ft=below_ft)
    print(f"{day}: {tag}, {len(parts)} parts, {sum(p[1] for p in parts) / 1e9:.2f} GB; keeping {','.join(types)} "
          f"within {radius_km} km of {lat:.4f},{lon:.4f} below {below_ft:.0f} ft", flush=True)
    t_start = time.time()
    stats = {"members": 0, "typed": 0, "kept": 0, "keptBytes": 0}
    kept = []

    def progress(pos, total):
        el = time.time() - t_start
        print(f"  {pos / 1e9:6.2f} / {total / 1e9:.2f} GB  {pos / 1e6 / max(el, 1):5.1f} MB/s  "
              f"{stats['members']} traces, {stats['typed']} of the types, {stats['kept']} kept  "
              f"free {free_bytes() / 1024**3:.1f} GB", flush=True)
        # The day is checked against 5 GB before it starts; while it runs this script writes only the kept
        # traces (tens of MB), and other work on the machine moves the free space by gigabytes, so the stream
        # stops only in an emergency.
        if free_bytes() < MIN_FREE_RUNNING:
            raise SystemExit("disk fell under 1 GB free; stopping")

    stream = adsb.ChainedStream([http_opener(u) for _, _, u in parts], [s for _, s, _ in parts], progress=progress)
    for hexid, blob in adsb.iter_trace_members(stream):
        stats["members"] += 1
        head = adsb.peek_header(blob)
        if head["t"] not in types:
            continue
        stats["typed"] += 1
        if not adsb.first_filter(blob, set(types), ref):
            continue
        (out / f"{hexid}.json.gz").write_bytes(blob)
        stats["kept"] += 1
        stats["keptBytes"] += len(blob)
        kept.append({"icao": hexid, "type": head["t"], "bytes": len(blob)})
        if stats["keptBytes"] > MAX_KEPT:
            raise SystemExit("kept more than 1 GB; tighten the filter")
    manifest = {
        "day": f"{day:%Y-%m-%d}", "release": tag, "parts": [{"name": n, "size": s, "url": u} for n, s, u in parts],
        "filter": {"types": list(types), "lat": lat, "lon": lon, "radiusKm": radius_km, "belowFt": below_ft},
        "stats": stats, "kept": kept, "complete": True, "seconds": round(time.time() - t_start),
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "licence": "ODbL-1.0 (adsb.lol)",
    }
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"{day}: done in {manifest['seconds']} s; {stats}", flush=True)
    return manifest


LIGHTS = {"day": (15.0, 90.0), "dusk": (-6.0, 2.0), "night": (-90.0, -12.0)}


def wind_days(city, start, end, light=None, evening=False):
    """Rank UTC days by hours whose wind gives a tailwind over 3 kt on runway 26 and a headwind over 3 kt on runway
    19 (the case where Las Vegas lands airliners on 19). Without `light`, the daylight hours 16Z to 23Z; with it,
    the reports whose sun elevation is in that light's band of section 6.2 (`evening`: only after local noon, so a
    dusk is a dusk and not a dawn). Reports are routine METARs (one an hour)."""
    station = city["iemStation"]
    url = ("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station={s}&data=drct&data=sknt&data=vsby"
           "&data=skyc1&data=skyl1&year1={a.year}&month1={a.month}&day1={a.day}&year2={b.year}&month2={b.month}"
           "&day2={b.day}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3"
           ).format(s=station, a=start, b=end)
    _, body = cached_get(url, ROOT / "data" / "raw" / "iem" / f"{station}-{start}-{end}-wind.csv")
    days = {}
    for r in csv.DictReader(io.StringIO(body.decode())):
        try:
            d, s = float(r["drct"]), float(r["sknt"])
        except ValueError:
            continue
        day, hm = r["valid"].split(" ")
        if light is None:
            if not 16 <= int(hm[:2]) <= 23:
                continue
        else:
            epoch = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
            sun = geodesy.sun_elevation(epoch, city["origin"]["lat"], city["origin"]["lon"])
            lo, hi = LIGHTS[light]
            if not lo <= sun <= hi:
                continue
            if evening and (int(hm[:2]) - 8) % 24 < 12:      # Pacific standard time: before local noon
                continue
        tail26 = -math.cos(math.radians(270 - d)) * s
        head19 = math.cos(math.radians(205 - d)) * s
        days.setdefault(day, []).append((tail26 > 3 and head19 > 3, f"{int(d):03d}/{int(s)}"))
    ranked = sorted(days.items(), key=lambda kv: -sum(ok for ok, _ in kv[1]))
    return [(day, sum(ok for ok, _ in obs), " ".join(w for _, w in obs)) for day, obs in ranked], url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("day", nargs="?")
    ap.add_argument("--release")
    ap.add_argument("--types", default=",".join(TYPES))
    ap.add_argument("--radius-km", type=float, default=12.0)
    ap.add_argument("--below-ft", type=float, default=8000.0)
    ap.add_argument("--near")
    ap.add_argument("--wind-days", action="store_true")
    ap.add_argument("--light", choices=sorted(LIGHTS))
    ap.add_argument("--evening", action="store_true")
    ap.add_argument("--from", dest="start", default="2025-01-01")
    ap.add_argument("--to", dest="end", default=date.today().isoformat())
    a = ap.parse_args()
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    if a.wind_days:
        ranked, url = wind_days(city, date.fromisoformat(a.start), date.fromisoformat(a.end), a.light, a.evening)
        print(f"source: {url}")
        for day, n, winds in ranked[:25]:
            print(f"{day}  {n} h  {winds}")
        return
    if not a.day:
        ap.error("a day is needed")
    fetch_day(a.city, date.fromisoformat(a.day), a.release, tuple(a.types.split(",")), a.radius_km, a.below_ft,
              a.near)


if __name__ == "__main__":
    main()
