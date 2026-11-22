# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "requests"]
# ///
"""Usage: build_billboards.py <city> [--refresh]

Billboards beside the three drive routes (plan 02, D7.4), from three sources:
  - OpenStreetMap: every `advertising` = billboard / board / screen / yes and `man_made` = advertising inside the routes'
    box, through the public Overpass API (by tags, never by id), with a generic User-Agent;
  - the City of Las Vegas billboard permits (an open ArcGIS layer: size 'h x w' and overall height in feet);
  - Clark County's billboard points (an open ArcGIS layer: position and status; only EXISTING ones stand).
Answers are cached under data/raw/<city>/ (billboards-osm.json, billboards-clv.geojson, billboards-clark.geojson);
a rerun with a warm cache makes no request (--refresh forces them). A source that cannot be fetched is reported and
left out.

Records within 30 m are one structure (lib/billboards.py dedupe; the legal spacing is 300 ft and more). Boards
within 300 m of a route's main or opposite carriageway (roadnet*.json + .bin) are kept, sized from the City's
fields or as a standard bulletin (14 x 48 ft), faced toward approaching traffic on the nearest carriageway (or as
OSM's `direction` or mapped panel line says), raised above a raised road, and pushed off any pavement (main lines,
ramps, streets of the three RoadNets) to POLE_CLEAR and PANEL_CLEAR. Digital where a source says so, else a hashed
DIGITAL_SHARE; two faces in a V where a source says so, else a hashed TWO_SIDED_SHARE.

Nothing textual is generated for the faces (their artwork is abstract and made at runtime, src/drive/screens/art.js);
the deny-list scan (data/sign_denylist.txt) still runs over everything the product carries, and must find nothing.

Output: public/data/<city>/billboards.json, data/derived/<city>/billboards_report.json
"""
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.billboards import (DIGITAL_SHARE, PANEL_CLEAR, POLE_CLEAR, TWO_SIDED_SHARE, RoadIndex, clark_records,  # noqa: E402
                            clv_records, dedupe, encode, osm_records, place)
from lib.crosssection import normalise_sections, pavement_edges  # noqa: E402
from lib.frame import create_frame  # noqa: E402
from lib.heights import load_heights  # noqa: E402
from lib.roadnet import decode_roadnet  # noqa: E402
from lib.roadside_legend import denied, load_denylist  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HEADERS = {"User-Agent": "road-pipeline/0.1"}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"]
ARCGIS = "https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/CLV_Billboards/FeatureServer"
LAYERS = {"clv": f"{ARCGIS}/3/query", "clark": f"{ARCGIS}/2/query"}
ROUTE_M = 300.0
PAD_DEG = 0.01
MAX_BYTES = 60_000


def overpass(query):
    last = None
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=200)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                return r.json()
            last = f"{url}: HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{url}: {e}"
        time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"Overpass failed: {last}")


def cached(path, fetch, refresh):
    if path.exists() and not refresh:
        return json.loads(path.read_text()), "cache"
    doc = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))
    return doc, "fetched"


def load_roads(data):
    """Every road of the three RoadNets, and the routes' main and opposite carriageways."""
    roads, seen = [], set()
    for f in sorted(data.glob("roadnet*.json")):
        doc = json.loads(f.read_text())
        for r in decode_roadnet(doc, f.with_suffix(".bin").read_bytes()):
            key = (r["id"], round(float(r["x"][0]), 1), round(float(r["y"][0]), 1))
            if key in seen:
                continue
            seen.add(key)
            r["secs"] = normalise_sections(r["sections"])
            roads.append(r)
    return roads


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    refresh = "--refresh" in sys.argv
    if not args:
        sys.exit(__doc__)
    city = args[0]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    frame = create_frame(cfg)
    data = ROOT / "public" / "data" / city
    raw = ROOT / "data" / "raw" / city

    roads = load_roads(data)
    edges = lambda r, s: pavement_edges(r["secs"], s)  # noqa: E731
    index = RoadIndex(roads, edges)
    mains = [r for r in roads if r["id"].endswith((".main", ".opp"))]
    route_index = RoadIndex(mains, edges)

    # the routes' box, for the requests
    lat, lon = frame.to_geodetic(np.concatenate([r["x"] for r in mains]), np.concatenate([r["y"] for r in mains]))
    box = (float(lat.min()) - PAD_DEG, float(lon.min()) - PAD_DEG, float(lat.max()) + PAD_DEG, float(lon.max()) + PAD_DEG)
    bbox = "({:.4f},{:.4f},{:.4f},{:.4f})".format(*box)

    sources, recs = {}, []
    q = (f'[out:json][timeout:180];(nwr["advertising"~"^(billboard|board|screen|yes)$"]{bbox};'
         f'nwr["man_made"="advertising"]{bbox};);out tags geom;')
    try:
        doc, how = cached(raw / "billboards-osm.json", lambda: overpass(q), refresh)
        r = osm_records(doc, frame.to_local)
        sources["osm"] = {"how": how, "snapshot": doc.get("osm3s", {}).get("timestamp_osm_base"), "records": len(r)}
        recs += r
    except Exception as e:  # noqa: BLE001
        sources["osm"] = {"error": str(e)}
    for name, reader in (("clv", clv_records), ("clark", clark_records)):
        def fetch(url=LAYERS[name]):
            r = requests.get(url, params={"where": "1=1", "outFields": "*", "f": "geojson"}, headers=HEADERS, timeout=120)
            r.raise_for_status()
            return r.json()
        try:
            doc, how = cached(raw / f"billboards-{name}.geojson", fetch, refresh)
            r = reader(doc, frame.to_local)
            sources[name] = {"how": how, "url": LAYERS[name], "records": len(r)}
            recs += r
        except Exception as e:  # noqa: BLE001
            sources[name] = {"error": str(e)}

    # only what is near enough to matter, before merging (the merge is quadratic in the worst case)
    near = [r for r in recs if route_index.nearest_main(r["x"], r["y"], ROUTE_M + 50) is not None]
    boards, groups = dedupe(near)
    try:
        heights = load_heights(city)
    except Exception:  # noqa: BLE001
        heights = None
    placed, rep = place(boards, index, route_index, heights, ROUTE_M)
    rows = encode(placed)

    product = {
        "version": 1,
        "source": {k: {kk: vv for kk, vv in v.items() if kk in ("snapshot", "url", "error")} for k, v in sources.items()},
        "attribution": "Billboard positions: © OpenStreetMap contributors (ODbL); City of Las Vegas; Clark County, Nevada.",
        "fields": ["x", "y", "facing", "facing2", "w", "h", "bottom", "digital", "sides", "seed", "sources"],
        "boards": rows,
    }
    text = json.dumps(product, separators=(",", ":"))
    # the deny-list scan: everything textual in the product (there is no legend; this must find nothing)
    terms = load_denylist(ROOT / "data" / "sign_denylist.txt")
    hits = denied(text, terms)

    by_src = Counter()
    for p in placed:
        for s in p["sources"]:
            by_src[s] += 1
    contributions = Counter("+".join(p["sources"]) for p in placed)
    report = {
        "method": "scripts/build_billboards.py", "route_m": ROUTE_M, "pole_clear_m": POLE_CLEAR, "panel_clear_m": PANEL_CLEAR,
        "assumed": {"digital_share_untagged": DIGITAL_SHARE, "two_sided_share_untagged": TWO_SIDED_SHARE},
        "sources": sources,
        "records_near_routes": dict(Counter(r["src"] for r in near)),
        "structures_after_merge": len(boards),
        "merged_groups": sum(1 for g in groups if len(g) > 1),
        "placed": len(placed), "placed_by_source": dict(by_src), "placed_by_sources": dict(contributions),
        "kinds": dict(Counter(("digital" if p["digital"] else "static") + " " + p["kind"] for p in placed)),
        "sides": dict(Counter(p["sides"] for p in placed)),
        "sizes_m": dict(Counter(f"{p['w']:.2f}x{p['h']:.2f}" for p in placed).most_common(8)),
        "moved_off_pavement": rep["moved"], "max_shift_m": max([p["shift"] for p in placed] or [0]),
        "dropped": rep["dropped"][:40], "dropped_count": len(rep["dropped"]),
        "dropped_by_reason": dict(Counter(d["why"] for d in rep["dropped"])),
        "denylist_hits": hits, "bytes": len(text),
    }
    data.joinpath("billboards.json").write_text(text)
    out = ROOT / "data" / "derived" / city
    out.mkdir(parents=True, exist_ok=True)
    out.joinpath("billboards_report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({k: report[k] for k in ("sources", "records_near_routes", "structures_after_merge", "placed",
                                              "placed_by_sources", "kinds", "sides", "sizes_m", "moved_off_pavement",
                                              "dropped_by_reason", "denylist_hits", "bytes")}, indent=1))
    if hits or len(text) > MAX_BYTES:
        sys.exit("deny-list terms found or the product is too large")


if __name__ == "__main__":
    main()
