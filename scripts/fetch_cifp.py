# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Usage: fetch_cifp.py <city> [--zip URL_OR_PATH] [--fixture PATH]

The published instrument approaches of the city's airport from the FAA's Coded Instrument Flight Procedures (plan 03,
F2.6): for each approach its runway, type, final approach fix, final approach course, glide path angle and threshold
crossing height, for the procedure check of the baked flights (lib/qa.py) and the glide-path gate of the bake.

  Source  https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/ (FAA, public domain):
          the current cycle's zip (about 9 MB, FAACIFP18 inside, ARINC 424-18), cached under data/raw/cifp/
  Output  data/flights/<city>/cifp-<ICAO>.json   the approaches and runways, the cycle and when it was fetched
          --fixture PATH                          also the airport's records and the fixes they use, as text (the
                                                  tests' fixture)
"""
import argparse
import io
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import cifp  # noqa: E402
from lib import flight_net  # noqa: E402,F401  (the generic client name)

ROOT = Path(__file__).resolve().parents[1]
PAGE = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"
RAW = ROOT / "data" / "raw" / "cifp"


def current_zip_url():
    from lib.fetch import _get
    flight_net.apply()
    html = _get(PAGE).text
    urls = sorted(set(re.findall(r'https://aeronav\.faa\.gov/[^"]*CIFP_(\d{6})\.zip', html)))
    if not urls:
        raise SystemExit(f"no CIFP zip linked from {PAGE}")
    # the cycle in effect today: the latest whose date (YYMMDD) is not in the future
    today = date.today().strftime("%y%m%d")
    effective = [u for u in urls if u <= today] or urls[:1]
    yymmdd = effective[-1]
    return f"https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_{yymmdd}.zip"


def read_zip(src):
    if re.match(r"https?://", src):
        from lib.fetch import cached_get
        flight_net.apply()
        _, body = cached_get(src, RAW / src.rsplit("/", 1)[-1])
        return body
    return Path(src).read_bytes()


def build(lines, icao, cycle_note):
    own, fixes = cifp.airport_lines(lines, icao)
    apps, rwys = cifp.approaches(own, fixes)
    return own, fixes, apps, rwys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--zip")
    ap.add_argument("--fixture")
    a = ap.parse_args()
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    icao = city["icao"]
    src = a.zip or current_zip_url()
    body = read_zip(src)
    z = zipfile.ZipFile(io.BytesIO(body))
    name = next(n for n in z.namelist() if n.upper().startswith("FAACIFP"))
    lines = [ln.decode("latin-1").rstrip("\r\n") for ln in z.open(name)]
    header = next((ln for ln in lines if ln.startswith("HDR01")), "")
    cycle = re.search(r"(\d{4})", header[35:60] or "")
    own, fixes, apps, rwys = build(lines, icao, header)
    out = {
        "about": "The published instrument approaches of %s from the FAA's CIFP (plan 03, F2.6): final approach course "
                 "(true, from the fix before the runway to the threshold), glide path angle and threshold crossing "
                 "height. Read by scripts/lib/qa.py and bake_flight.py." % icao,
        "source": "FAA Coded Instrument Flight Procedures (public domain), " + PAGE,
        "zip": src if re.match(r"https?://", src) else Path(src).name, "file": name,
        "cycle": cycle.group(1) if cycle else None, "header": header.strip()[:120],
        "fetched": date.today().isoformat(),
        "approaches": apps, "runways": rwys,
    }
    dest = ROOT / "data" / "flights" / a.city / f"cifp-{icao}.json"
    dest.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{dest}: {len(apps)} approaches, {len(rwys)} runways (cycle {out['cycle']})")
    if a.fixture:
        used = {v["faf"] for v in apps.values()} | {v["lastFix"] for v in apps.values()}
        keep = own + [ln for ln in fixes if ln[13:18].strip() in used]
        Path(a.fixture).write_text("\n".join(keep) + "\n")
        print(f"{a.fixture}: {len(keep)} records")


if __name__ == "__main__":
    main()
