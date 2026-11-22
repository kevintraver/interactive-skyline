# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests", "shapely", "duckdb"]
# ///
"""Usage: build_corridor.py <city> [--refresh] [--no-overture]

The buildings beyond the core along the drive (plan 02, D7.6). The core (the city's `bbox`, drawn
from public/data/<city>/buildings.json) is left out, so nothing is drawn twice.

Kept: every building within 400 m of the route (road `i15n.main` of roadnet.json) of 30 m2 or more;
from 400 m to 1.5 km those of 60 m2 or more or 8 m or taller (250 m2 in the plan; lowered, since the product is far under its 3 MB); anywhere in the drive region (the
`wide` terrain grid) every building of 20 m or more. The rules are RULES in lib/corridor.py.

Footprints come from OpenStreetMap through Overpass, by tags (two requests: the buildings within
1.6 km of the route, and the tagged-tall ones in the region), cached under data/raw/<city>/. The
heights take the ladder of build_buildings.py without LiDAR: OSM `height`, `building:levels`, then
Overture Maps' building height (its public GeoParquet release, read anonymously with DuckDB and
cached as data/raw/<city>/overture/heights.parquet; joined to OSM by Overture's source record),
then a guess by type and area. Overture's own buildings of 20 m or more that OSM lacks (Microsoft's
footprints) join the tall set.

A rerun with a warm cache makes no request and writes the same bytes. --refresh forces the requests;
--no-overture skips Overture.

The format is specified at the top of src/drive/corridor/format.js (writer: lib/corridor_format.py).

Output: public/data/<city>/corridor/index.json, c<i>_<j>.bin per 2 km cell, tall.bin
        data/derived/<city>/corridor_report.json
"""
import json
import math
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import requests
from shapely import STRtree, from_wkb
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.corridor import RULES, building_type, height_of, keep, tidy  # noqa: E402
from lib.corridor_format import RUNG, RUNGS, TYPE, TYPES, encode_cell  # noqa: E402
from lib.frame import create_frame  # noqa: E402
from lib.ladder import stitch  # noqa: E402
from lib.roadnet import decode_roadnet  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "road-pipeline/0.1"}
OVERTURE = "s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*"
OVERTURE_LIST = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/"
ROUTE_ROAD = "i15n.main"
CELL = 2000  # m
FETCH_M = 1600  # the corridor request reaches a little past the band
SIMPLIFY_M = 1.0
MIN_HOLE_M2 = 6.0
FORMAT_VERSION = 1


def overpass(q, tries=6):
    """POST one query, retrying with exponential backoff on rate limits, timeouts and server errors."""
    wait = 15
    for attempt in range(1, tries + 1):
        try:
            r = requests.post(ENDPOINT, data={"data": q}, headers=HEADERS, timeout=900)
            if r.status_code == 200:
                doc = r.json()
                if "remark" in doc and not doc.get("elements"):
                    raise RuntimeError(f"Overpass remark: {doc['remark']}")
                return doc
            err = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError, RuntimeError) as ex:
            err = str(ex)
        if attempt == tries:
            sys.exit(f"Overpass failed after {tries} tries: {err}")
        print(f"  {err}; retrying in {wait} s", file=sys.stderr)
        time.sleep(wait)
        wait *= 2


def cached(path, make, refresh):
    if path.exists() and not refresh:
        doc = json.loads(path.read_text())
        print(f"cached: {path.relative_to(ROOT)} (snapshot {doc['osm3s']['timestamp_osm_base']})")
        return doc
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = make()
    path.write_text(json.dumps(doc))
    print(f"fetched: {path.relative_to(ROOT)}, {len(doc['elements'])} elements, {path.stat().st_size / 1e6:.1f} MB")
    return doc


def corridor_query(lat, lon, radius):
    line = ",".join(f"{a:.6f},{b:.6f}" for a, b in zip(lat, lon))
    return (f"[out:json][timeout:900];(way[\"building\"](around:{radius},{line});"
            f"relation[\"building\"][\"type\"=\"multipolygon\"](around:{radius},{line}););out geom;")


def tall_query(bbox):
    s, w, n, e = (f"{v:.5f}" for v in bbox)
    tall_h = '"height"~"^ *([2-9][0-9]|[1-9][0-9][0-9]+)([.,][0-9]*)? *(m)? *$"'
    tall_lv = '"building:levels"~"^ *([6-9]|[1-9][0-9]+) *$"'
    parts = [f"{kind}[\"building\"][{t}]({s},{w},{n},{e});" for kind in ("way", "relation") for t in (tall_h, tall_lv)]
    return f"[out:json][timeout:900];({''.join(parts)});out geom;"


def overture_heights(path, bbox, refresh):
    """The Overture table (cached): every building in the region with a height or floor count."""
    if path.exists() and not refresh:
        print(f"cached: {path.relative_to(ROOT)}")
        return path
    import duckdb
    listing = requests.get(OVERTURE_LIST, headers=HEADERS, timeout=60).text
    releases = sorted(set(p.split("/")[1] for p in listing.split("<Prefix>")[1:] if p.startswith("release/2")))
    release = releases[-1]
    s, w, n, e = bbox
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET http_retries=5;")
    tmp = path.with_suffix(".part")
    con.execute(f"""COPY (
      SELECT id, height, num_floors, class, subtype, sources[1].dataset AS src_dataset, sources[1].record_id AS src_record,
             bbox.xmin AS xmin, bbox.ymin AS ymin, bbox.xmax AS xmax, bbox.ymax AS ymax, ST_AsWKB(geometry) AS wkb
      FROM read_parquet('{OVERTURE.format(release=release)}', hive_partitioning=0)
      WHERE bbox.xmin > {w} AND bbox.xmax < {e} AND bbox.ymin > {s} AND bbox.ymax < {n}
        AND (height IS NOT NULL OR num_floors IS NOT NULL)
      ORDER BY id) TO '{tmp}' (FORMAT PARQUET)""")
    tmp.rename(path)
    (path.parent / "release.txt").write_text(release + "\n")
    print(f"fetched: Overture {release}, {path.stat().st_size / 1e6:.1f} MB")
    return path


def main():
    args = sys.argv[1:]
    city = args[0]
    refresh, use_overture = "--refresh" in args, "--no-overture" not in args
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    frame = create_frame(cfg)
    raw = ROOT / "data" / "raw" / city
    out_dir = ROOT / "public" / "data" / city / "corridor"
    derived = ROOT / "data" / "derived" / city

    # ---------------------------------------------------------------- route, region, core
    doc = json.loads((ROOT / "public" / "data" / city / "roadnet.json").read_text())
    roads = decode_roadnet(doc, (ROOT / "public" / "data" / city / "roadnet.bin").read_bytes())
    road = next(r for r in roads if r["id"] == ROUTE_ROAD)
    route = LineString(np.c_[road["x"], road["y"]])
    g = cfg["terrain"]["wide"]
    region = box(g["x0"], g["y0"], g["x1"], g["y1"])
    lat_c, lon_c = frame.to_geodetic(np.array([g["x0"], g["x1"], g["x0"], g["x1"]], float),
                                     np.array([g["y0"], g["y0"], g["y1"], g["y1"]], float))
    bbox = (lat_c.min(), lon_c.min(), lat_c.max(), lon_c.max())
    s, w, n, e = cfg["bbox"]
    cx, cy = frame.to_local(np.array([s, s, n, n], float), np.array([w, e, e, w], float))
    core = Polygon(np.c_[cx, cy])
    core_ids = {b["id"] for b in json.loads((ROOT / "public" / "data" / city / "buildings.json").read_text())["buildings"]}

    # ---------------------------------------------------------------- fetch
    step = int(500 / road["spacing"])
    lat, lon = frame.to_geodetic(np.asarray(road["x"][::step]), np.asarray(road["y"][::step]))
    osm = cached(raw / "osm-corridor.json", lambda: overpass(corridor_query(lat, lon, FETCH_M)), refresh)
    osm_tall = cached(raw / "osm-corridor-tall.json", lambda: overpass(tall_query(bbox)), refresh)
    ov_path = None
    if use_overture:
        try:
            ov_path = overture_heights(raw / "overture" / "heights.parquet", bbox, refresh)
        except Exception as ex:  # noqa: BLE001  the rung is optional
            print(f"Overture not used: {ex}", file=sys.stderr)

    # ---------------------------------------------------------------- parse
    def project(geom):
        x, y = frame.to_local(np.array([p["lat"] for p in geom]), np.array([p["lon"] for p in geom]))
        return list(zip(x.tolist(), y.tolist()))

    def to_polys(el):
        if el["type"] == "way":
            pts = project(el.get("geometry", []))
            if len(pts) < 4 or pts[0] != pts[-1]:
                return []
            polys = [Polygon(pts)]
        else:
            outers = stitch([project(m["geometry"]) for m in el["members"]
                             if m["type"] == "way" and m.get("role") in ("outer", "") and "geometry" in m])
            inners = [Polygon(r) for r in stitch([project(m["geometry"]) for m in el["members"]
                                                  if m["type"] == "way" and m.get("role") == "inner" and "geometry" in m])]
            polys = []
            for o in outers:
                op = Polygon(o)
                holes = [i.exterior.coords for i in inners if i.is_valid and op.contains(i.representative_point())]
                polys.append(Polygon(o, holes))
        res = []
        for p in polys:
            if not p.is_valid:
                p = p.buffer(0)
            for q in (p.geoms if isinstance(p, MultiPolygon) else [p]):
                if isinstance(q, Polygon) and q.area > 4:
                    res.append(q)
        return res

    # the core's hand corrections (data/overrides.json "set" tags) apply here too
    overrides = json.loads((ROOT / "data" / "overrides.json").read_text())
    elements = {}
    for el in osm["elements"] + osm_tall["elements"]:
        key = f"{el['type'][0]}{el['id']}"
        t = el.setdefault("tags", {})
        t.update(overrides.get(key, {}).get("set", {}))
        if t.get("building") in (None, "no") or key in elements:
            continue
        elements[key] = el

    ov_by_osm, ov_tall, ov_osm_tall = {}, [], []
    ov_release = None
    if ov_path:
        import duckdb
        con = duckdb.connect()
        rows = con.execute(f"SELECT src_record, height, num_floors FROM '{ov_path}' WHERE src_dataset = 'OpenStreetMap'").fetchall()
        for rec, h, nf in rows:
            if rec and h is not None:
                ov_by_osm[rec.split("@")[0]] = float(h)
        # Overture's other footprints (Microsoft's, from imagery): the tall ones anywhere, and every one near the route
        lat_r, lon_r = frame.to_geodetic(*np.asarray(route.buffer(FETCH_M).envelope.exterior.coords).T)
        ov_tall = con.execute(f"""SELECT id, height, wkb FROM '{ov_path}' WHERE src_dataset <> 'OpenStreetMap' AND (height >= {RULES['tall']}
            OR (xmin > {lon_r.min()} AND xmax < {lon_r.max()} AND ymin > {lat_r.min()} AND ymax < {lat_r.max()})) ORDER BY id""").fetchall()
        # OSM's own buildings of 20 m or more by Overture's height, out past the corridor request: Overture
        # carries their OSM geometry, so they come from it, under their OSM ids
        ov_osm_tall = [(rec.split("@")[0], h, wkb) for rec, h, wkb in con.execute(
            f"SELECT src_record, height, wkb FROM '{ov_path}' WHERE src_dataset = 'OpenStreetMap' AND height >= {RULES['tall']} ORDER BY src_record").fetchall()
            if rec and rec.split("@")[0] not in elements]
        rel = ov_path.parent / "release.txt"
        ov_release = rel.read_text().strip() if rel.exists() else None
        print(f"Overture: {len(ov_by_osm):,} OSM buildings with a height, {len(ov_tall):,} others near the route or tall")

    # ---------------------------------------------------------------- choose
    stats = Counter()
    cand = []  # (id, poly, tags, overture height, source)
    for key, el in sorted(elements.items()):
        if key in core_ids:
            stats["core:by-id"] += 1
            continue
        for p in to_polys(el):
            cand.append((key, p, el.get("tags", {}), ov_by_osm.get(key), "osm"))
    osm_polys = [c[1] for c in cand]
    tree = STRtree(osm_polys) if osm_polys else None
    if ov_tall:
        import shapely
        geoms = from_wkb([bytes(r[2]) for r in ov_tall])
        hs = np.array([np.nan if r[1] is None else r[1] for r in ov_tall], dtype=float)
        cen = shapely.centroid(geoms)
        px, py = frame.to_local(shapely.get_y(cen), shapely.get_x(cen))
        near = shapely.contains_xy(route.buffer(FETCH_M), px, py)
        for k in np.flatnonzero(near | (hs >= RULES["tall"])):
            geom = geoms[k]
            for q in (geom.geoms if hasattr(geom, "geoms") else [geom]):
                if not isinstance(q, Polygon):
                    continue
                xy = np.asarray(q.exterior.coords)
                x, y = frame.to_local(xy[:, 1], xy[:, 0])
                p = Polygon(np.c_[x, y]).buffer(0)
                if not isinstance(p, Polygon) or p.area < 30:
                    continue
                if tree is not None and len(tree.query(p, predicate="intersects")):
                    continue  # OSM has it already
                cand.append((f"overture:{ov_tall[k][0]}", p, {"building": "yes"}, None if np.isnan(hs[k]) else float(hs[k]), "overture"))
    for oid, h, wkb in ov_osm_tall:
        if oid in core_ids:
            continue
        geom = from_wkb(bytes(wkb))
        for q in (geom.geoms if hasattr(geom, "geoms") else [geom]):
            if isinstance(q, Polygon):
                xy = np.asarray(q.exterior.coords)
                x, y = frame.to_local(xy[:, 1], xy[:, 0])
                holes = []
                for ring in q.interiors:
                    hxy = np.asarray(ring.coords)
                    hx, hy = frame.to_local(hxy[:, 1], hxy[:, 0])
                    holes.append(np.c_[hx, hy])
                p = Polygon(np.c_[x, y], holes).buffer(0)
                if isinstance(p, Polygon) and p.area > 4:
                    cand.append((oid, p, {"building": "yes"}, float(h), "overture-osm"))

    kept = []
    for key, p, tags, ovh, src in cand:
        c = p.centroid
        if core.contains(c):
            stats["core:inside"] += 1
            continue
        if not region.contains(c):
            stats["outside-region"] += 1
            continue
        area = p.area
        h, rung = height_of(tags, area, ovh)
        t = building_type(tags, area)
        d = p.distance(route)
        if not keep(d, area, h):
            stats["dropped:rule"] += 1
            continue
        rings = tidy(p, SIMPLIFY_M, MIN_HOLE_M2)
        if not rings:
            stats["dropped:degenerate"] += 1
            continue
        kept.append({"id": key, "rings": rings, "height": round(h, 1), "type": t, "rung": rung, "dist": d,
                     "area": area, "c": (c.x, c.y), "src": src})

    # ---------------------------------------------------------------- cells
    tall = [b for b in kept if b["height"] >= RULES["tall"]]
    low = [b for b in kept if b["height"] < RULES["tall"]]
    cells = defaultdict(list)
    for b in low:
        cells[(math.floor(b["c"][0] / CELL), math.floor(b["c"][1] / CELL))].append(b)
    out_dir.mkdir(parents=True, exist_ok=True)
    order = lambda b: (-b["height"], b["id"], b["c"])  # noqa: E731
    written, index_cells = set(), []

    def bounds(bs):
        xs = [x for b in bs for r in b["rings"][:1] for x, _ in r]
        ys = [y for b in bs for r in b["rings"][:1] for _, y in r]
        return [math.floor(min(xs)), math.floor(min(ys)), math.ceil(max(xs)), math.ceil(max(ys))]

    def write(name, blob):
        path = out_dir / name
        if not path.exists() or path.read_bytes() != blob:
            path.write_bytes(blob)
        written.add(name)
        return len(blob)

    for (i, j), bs in sorted(cells.items()):
        bs.sort(key=order)
        origin = (i * CELL + CELL // 2, j * CELL + CELL // 2)
        name = f"c{i}_{j}.bin"
        size = write(name, encode_cell({"origin": origin, "buildings": bs}))
        index_cells.append({"i": i, "j": j, "file": name, "count": len(bs), "bytes": size, "bounds": bounds(bs),
                            "maxHeight": max(b["height"] for b in bs)})
    tall.sort(key=order)
    tall_entry = None
    if tall:
        size = write("tall.bin", encode_cell({"origin": (0, 0), "wide": True, "buildings": tall}))
        tall_entry = {"file": "tall.bin", "count": len(tall), "bytes": size, "bounds": bounds(tall),
                      "maxHeight": max(b["height"] for b in tall)}
    for stale in out_dir.glob("*.bin"):
        if stale.name not in written:
            stale.unlink()

    snapshot = osm["osm3s"]["timestamp_osm_base"]
    index = {
        "version": FORMAT_VERSION, "cellSize": CELL, "tallFrom": RULES["tall"], "route": ROUTE_ROAD,
        "thresholds": {**RULES, "simplify": SIMPLIFY_M, "minHole": MIN_HOLE_M2},
        "types": list(TYPES), "rungs": list(RUNGS),
        "counts": {"buildings": len(kept), "cells": len(index_cells), "tall": len(tall)},
        "attribution": ["Building footprints © OpenStreetMap contributors (ODbL), snapshot " + snapshot]
                       + ([f"Building heights and some footprints: Overture Maps Foundation, release {ov_release} (ODbL, CDLA Permissive 2.0)"]
                          if ov_path else []),
        "cells": index_cells, "tall": tall_entry,
    }
    index_text = json.dumps(index, separators=(",", ":")) + "\n"
    ip = out_dir / "index.json"
    if not ip.exists() or ip.read_text() != index_text:
        ip.write_text(index_text)

    # ---------------------------------------------------------------- report
    total_bytes = sum(c["bytes"] for c in index_cells) + (tall_entry["bytes"] if tall_entry else 0) + len(index_text)
    band = lambda d: "0-400 m" if d <= RULES["near"] else "400 m-1.5 km" if d <= RULES["band"] else "beyond 1.5 km"  # noqa: E731
    per5 = []
    s_of = [route.project(Point(b["c"])) for b in kept]
    for k in range(0, int(math.ceil(route.length / 5000))):
        sel = [b for b, s_ in zip(kept, s_of) if k * 5000 <= s_ < (k + 1) * 5000 and b["dist"] <= RULES["band"]]
        mid = route.interpolate(min(route.length, k * 5000 + 2500))
        per5.append({"km": [k * 5, min((k + 1) * 5, round(route.length / 1000, 2))], "buildings": len(sel),
                     "within400": sum(b["dist"] <= RULES["near"] for b in sel),
                     "inCore": bool(core.contains(mid)),
                     "byRung": dict(sorted(Counter(RUNGS[b["rung"]] for b in sel).items()))})
    report = {
        "osmSnapshot": snapshot, "overtureRelease": ov_release, "thresholds": index["thresholds"],
        "kept": len(kept), "tall": len(tall), "cells": len(index_cells),
        "byBand": dict(Counter(band(b["dist"]) for b in kept)),
        "byRung": {RUNGS[k]: v for k, v in sorted(Counter(b["rung"] for b in kept).items())},
        "byType": {TYPES[k]: v for k, v in sorted(Counter(b["type"] for b in kept).items())},
        "bySource": dict(Counter(b["src"] for b in kept)),
        "skipped": dict(stats),
        "bytes": {"total": total_bytes, "index": len(index_text), "tall": tall_entry["bytes"] if tall_entry else 0,
                  "cells": sum(c["bytes"] for c in index_cells), "largestCell": max(c["bytes"] for c in index_cells)},
        "perFiveKm": per5,
        "tallList": [{"id": b["id"], "h": b["height"], "rung": RUNGS[b["rung"]], "c": [round(v) for v in b["c"]]} for b in tall],
        "heightCheck": [{"id": b["id"], "h": b["height"], "type": TYPES[b["type"]], "rung": RUNGS[b["rung"]], "area": round(b["area"])}
                        for b in kept if b["type"] in (TYPE["house"], TYPE["shed"]) and b["height"] > 12],
    }
    derived.mkdir(parents=True, exist_ok=True)
    (derived / "corridor_report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(f"kept {len(kept):,} buildings ({len(tall)} tall) in {len(index_cells)} cells, {total_bytes / 1e6:.2f} MB")
    print("by band:", report["byBand"])
    print("by rung:", report["byRung"])
    print("by type:", report["byType"])
    print("skipped:", report["skipped"])


if __name__ == "__main__":
    main()
