# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Usage: build_valley_traffic.py <city>

Traffic on the rest of the valley, as light ribbons (plan 02, D6.6; sections 5.8, 6.5, 7.10).
The driven routes have their own traffic (build_traffic.py); every other freeway and principal
arterial of the valley gets a daily volume per direction and an hour-of-week shape, which the
drive draws as a pair of glowing lines (src/drive/traffic/valley.js).

  1. OpenStreetMap, through the Overpass API, by tags: every way tagged highway = motorway, trunk,
     primary or secondary inside the city's far terrain grid. Cached under data/raw/<city>/.
  2. NDOT TRINA count stations inside the same box, with their 2025 AADT (cached, through
     build_traffic.trina_stations), and FHWA TMAS 2025 continuous counts (the cache of
     build_traffic.py) for the hour-of-week shapes.
  3. Ways joined into chains of one road (same name or ref, class, one-way-ness), with the driven
     routes' own carriageways cut out (public/data/<city>/roadnet*.json; they come back in step 5), split into pieces of at
     most PIECE_M, simplified (Douglas-Peucker, SIMPLIFY_M). Secondary roads are kept only where a
     count station sits on them.
  4. Each piece takes the AADT of the nearest TRINA station on the same road (by distance and
     road name, within STATION_REACH_M along the road's chain); roads without one take a class
     default (marked as assumed). Each piece takes the hour-of-week shape of the nearest
     continuous station of its kind (freeway or arterial) and heading (north/south or east/west).
  5. The driven routes' own carriageways, both directions, from their RoadNets, with the volumes and
     hour shapes of their traffic files (public/data/<city>/traffic/<route>.json), added as groups by
     route id: the drive hides the group of the route being driven, which has its own vehicles, so the
     other routes' freeways still carry light. A stretch two routes share is one group naming both.
  6. Write public/data/<city>/traffic/valley.json + valley.bin (the format is the comment at the
     top of scripts/lib/valley_traffic.py) and data/derived/<city>/valley_traffic_report.json.

A rerun with a warm cache makes no request.
"""
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_traffic as BT  # noqa: E402  (fetch and TRINA helpers; its main() is not run)
from lib import traffic as T  # noqa: E402
from lib import valley_traffic as V  # noqa: E402
from lib.frame import create_frame  # noqa: E402
from lib.roadnet import decode_roadnet  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
UA = "road-pipeline/0.1"
OVERPASS = "https://overpass-api.de/api/interpreter"
YEAR = BT.YEAR


def region(cfg):
    """The far terrain grid, as map-metre bounds and a lat/lon box (south, west, north, east)."""
    g = cfg["terrain"]["far"]
    frame = create_frame(cfg)
    xs = np.array([g["x0"], g["x1"], g["x0"], g["x1"]], dtype=np.float64)
    ys = np.array([g["y0"], g["y0"], g["y1"], g["y1"]], dtype=np.float64)
    lat, lon = frame.to_geodetic(xs, ys)
    return (g["x0"], g["y0"], g["x1"], g["y1"]), (float(lat.min()), float(lon.min()), float(lat.max()), float(lon.max()))


def fetch_osm(city, bbox):
    path = ROOT / "data" / "raw" / city / "osm-valley-roads.json"
    if path.exists() and path.stat().st_size > 0:
        return json.loads(path.read_text())
    s, w, n, e = (f"{v:.5f}" for v in bbox)
    q = f"""[out:json][timeout:600];
way["highway"~"^(motorway|trunk|primary|secondary)$"]({s},{w},{n},{e})->.w;
.w out body;
node(w.w);
out skel qt;"""
    print("fetching the valley's roads from Overpass")
    for i in range(4):
        try:
            req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=900) as r:
                body = r.read()
            doc = json.loads(body)
            break
        except Exception as ex:  # noqa: BLE001
            if i == 3:
                raise
            print(f"  retry {i + 1}: {ex}")
            time.sleep(30 * (i + 1))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(doc))
    tmp.rename(path)
    return doc


def driven_lines(city):
    """The driven routes' own carriageways (the roads their traffic files name), as (N, 2) arrays."""
    data = ROOT / "public" / "data" / city
    lines = []
    for route in json.loads((data / "routes.json").read_text())["routes"]:
        files = route.get("files", {})
        net = files.get("roadnet", "roadnet.json")
        tf = data / files.get("traffic", f"traffic/{route['id']}.json")
        if not tf.exists():
            continue
        tr = json.loads(tf.read_text())
        want = {d["road"] for d in tr["directions"].values()}
        doc = json.loads((data / net).read_text())
        for r in decode_roadnet(doc, (data / (net[:-len(".json")] + ".bin")).read_bytes()):
            if r["id"] in want:
                lines.append({"id": f"{route['id']}:{r['id']}", "xy": np.column_stack([r["x"], r["y"]])})
    return lines


def route_carriageways(city):
    """Both carriageways of every driven route (the roads its traffic file names, from the route's RoadNet),
    in their direction of travel, with the route's chainage of each point and the traffic file's segments."""
    data = ROOT / "public" / "data" / city
    out = []
    for route in json.loads((data / "routes.json").read_text())["routes"]:
        files = route.get("files", {})
        net = files.get("roadnet", "roadnet.json")
        tf = data / files.get("traffic", f"traffic/{route['id']}.json")
        if not tf.exists():
            continue
        tr = json.loads(tf.read_text())
        doc = json.loads((data / net).read_text())
        roads = {r["id"]: r for r in decode_roadnet(doc, (data / (net[:-len(".json")] + ".bin")).read_bytes())}
        main = roads[tr["directions"]["with"]["road"]]
        main_xy = np.column_stack([main["x"], main["y"]])
        main_s = np.arange(main["count"]) * main["spacing"]
        for d in ("with", "against"):
            spec = tr["directions"][d]
            r = roads[spec["road"]]
            xy = np.column_stack([r["x"], r["y"]])
            if d == "with":
                s = np.arange(r["count"]) * r["spacing"]
            else:  # the other carriageway: the route's chainage of the nearest point of the route's road
                s, _ = V.project_onto(main_xy, main_s, xy, 120.0)
            out.append({"route": route["id"], "label": route.get("label") or route["id"], "dir": d,
                        "xy": xy, "s": s, "segments": spec["segments"]})
    return out


def tmas_shapes(raw, frame, bounds):
    """Hour-of-week shapes of every TMAS continuous station inside bounds, both directions."""
    vol_txt, st_txt = BT.tmas_text(raw, BT.CITIES["lv"]["state"])
    tmas_st = T.parse_stations(st_txt.read_text().splitlines())
    inside = {}
    for (sid, d), st in tmas_st.items():
        if st["lat"] is None or st["lon"] is None:
            continue
        x, y = frame.to_local(st["lat"], st["lon"])
        if bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3]:
            inside[(sid, d)] = {**st, "x": float(x), "y": float(y)}
    keep = {sid for sid, _ in inside}
    with open(vol_txt) as fh:
        records = T.parse_volume(fh, keep)
    days, dropped = T.station_days(records, tmas_st)
    means = T.hour_of_week_means(days)
    return V.make_shapes(inside, means, T.season_weights(YEAR)), dropped


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    city = sys.argv[1]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    frame = create_frame(cfg)
    bounds, bbox = region(cfg)
    raw = ROOT / "data" / "raw" / city / "traffic"
    raw.mkdir(parents=True, exist_ok=True)

    osm = fetch_osm(city, bbox)
    corners = np.array([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], dtype=np.float64)
    trina = BT.trina_stations(raw, "valley", frame, corners, margin=0.0)
    shapes, dropped = tmas_shapes(raw, frame, bounds)
    driven = driven_lines(city)

    ways = V.osm_ways(osm, frame)
    stations = V.trina_points(trina, frame, YEAR)
    result = V.build(ways, stations, shapes, driven, bounds)
    result = V.with_routes(result, V.route_pieces(route_carriageways(city), T.season_weights(YEAR), len(shapes), bounds))

    out_dir = ROOT / "public" / "data" / city / "traffic"
    out_dir.mkdir(parents=True, exist_ok=True)
    doc, blob = V.encode(result, {
        "city": city, "year": YEAR, "tz": cfg["tz"],
        "sources": [
            {"id": "osm", "title": "OpenStreetMap contributors, ODbL: highway = motorway, trunk, primary, secondary",
             "url": "https://www.openstreetmap.org/copyright", "snapshot": osm.get("osm3s", {}).get("timestamp_osm_base", "")},
            {"id": "trina", "title": f"NDOT TRINA stations and AADT {YEAR}", "url": BT.TRINA, "retrieved": trina["retrieved"]},
            {"id": "tmas", "title": BT.NTAD["volume"]["title"], "url": BT.ITEM_PAGE.format(BT.NTAD["volume"]["item"])},
        ],
    })
    (out_dir / "valley.json").write_text(json.dumps(doc, separators=(",", ":")))
    (out_dir / "valley.bin").write_bytes(blob)
    report = V.report(result, dropped)
    report["generated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    report["bytes"] = {"json": (out_dir / "valley.json").stat().st_size, "bin": len(blob)}
    rp = ROOT / "data" / "derived" / city / "valley_traffic_report.json"
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(report, indent=1, default=float))
    print(f"{len(result['pieces'])} pieces, {report['km']['total']:.0f} km; "
          f"json {report['bytes']['json']} B, bin {len(blob)} B; wrote {rp.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
