"""Water inside a terrain patch, for build_terrain.py: OSM's water outlines (lakes, reservoirs and the
river's banks) clipped to the patch, each body of water flat at the level the patch's own heights give it.

The elevation source flattens water to its surface on the day it was surveyed, so the level of a body
is the median height of the patch's posts well inside its outline. The runtime draws each body as a
flat sheet at that level (src/world/terrain/water.js), over the ground that already lies about there.
Where the source's flat water is not at one level across a body (below Hoover Dam it has the river
about 20 m higher near the dam than further down, where two surveys meet), the body also carries
`levels`: the median in each PIECE_M square it covers, which the runtime blends between.

    raw = fetch_water(city, patch_id, to_ll, (x0, y0, x1, y1), root)   # cached Overpass JSON
    bodies = water_levels(raw, grid, projection)                          # [{name, kind, level, rings}]
"""
import json
import time
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

ENDPOINT = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "road-pipeline/0.1"}
SIMPLIFY_M = 6.0  # outline tolerance: under a third of a 20 m post
MIN_AREA_M2 = 20000.0  # ponds and tanks smaller than this are left out
INSET_M = 40.0  # the level is read this far inside the shore
PIECE_M = 400.0  # squares in which a body's level is read again, where it is not one level
SPREAD_M = 1.0  # a body whose pieces differ by more than this carries their levels


def fetch_water(city, pid, to_ll, bbox, root, refresh=False):
    """Overpass JSON of the water areas that touch the patch's (x0, y0, x1, y1), cached in data/raw/<city>/."""
    path = Path(root) / "data" / "raw" / city / f"osm-water-{pid}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    x0, y0, x1, y1 = bbox
    lon, lat = to_ll.transform(np.array([x0, x1, x0, x1], float), np.array([y0, y0, y1, y1], float))
    s, w, n, e = (f"{v:.5f}" for v in (lat.min(), lon.min(), lat.max(), lon.max()))
    q = f"""[out:json][timeout:300];
(way["natural"="water"]({s},{w},{n},{e});rel["natural"="water"]({s},{w},{n},{e});
 way["waterway"="riverbank"]({s},{w},{n},{e});rel["waterway"="riverbank"]({s},{w},{n},{e});
 way["landuse"="reservoir"]({s},{w},{n},{e});rel["landuse"="reservoir"]({s},{w},{n},{e}););
out geom;"""
    for attempt in range(4):
        r = requests.post(ENDPOINT, data={"data": q}, headers=HEADERS, timeout=400)
        if r.status_code in (429, 504) and attempt < 3:
            time.sleep(30 * (attempt + 1))
            continue
        r.raise_for_status()
        break
    doc = r.json()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))
    return doc


def _polygons(doc, to_local):
    """(name, kind, shapely polygon) for every closed water way and multipolygon relation."""
    def line(geom):
        lon = np.array([p["lon"] for p in geom], float)
        lat = np.array([p["lat"] for p in geom], float)
        x, y = to_local.transform(lon, lat)
        return list(zip(x.tolist(), y.tolist()))

    out = []
    for el in doc.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name", "")
        kind = tags.get("water") or tags.get("waterway") or tags.get("landuse") or "water"
        if el["type"] == "way":
            pts = line(el.get("geometry", []))
            if len(pts) >= 4 and pts[0] == pts[-1]:
                out.append((name, kind, Polygon(pts).buffer(0)))
        elif el["type"] == "relation" and tags.get("type") == "multipolygon":
            rings = {"outer": [], "inner": []}
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("geometry"):
                    rings["inner" if m.get("role") == "inner" else "outer"].append(LineString(line(m["geometry"])))
            outer = unary_union(list(polygonize(linemerge(rings["outer"])))) if rings["outer"] else None
            if outer is None or outer.is_empty:
                continue
            if rings["inner"]:
                inner = unary_union(list(polygonize(linemerge(rings["inner"]))))
                outer = outer.difference(inner)
            out.append((name, kind, outer.buffer(0)))
    return out


def water_levels(doc, grid, projection):
    """Bodies of water inside the patch: [{name, kind, level, rings: [outer, *holes]}], rings as [[x, y], ...]
    in map metres rounded to 0.1 m, counter-clockwise outers; level in metres above sea level."""
    to_local = Transformer.from_crs("EPSG:4326", projection, always_xy=True)
    frame = box(grid.x0, grid.y0, grid.x1, grid.y1)
    xs = grid.x0 + np.arange(grid.nx) * grid.step
    ys = grid.y0 + np.arange(grid.ny) * grid.step
    gx, gy = np.meshgrid(xs.astype(float), ys.astype(float))
    h = grid.raw.astype(float) * grid.scale
    from shapely import contains_xy

    bodies = []
    for name, kind, poly in _polygons(doc, to_local):
        clipped = poly.intersection(frame)
        parts = clipped.geoms if isinstance(clipped, MultiPolygon) else [clipped]
        for part in parts:
            if not isinstance(part, Polygon) or part.area < MIN_AREA_M2:
                continue
            core = part.buffer(-INSET_M)
            probe = core if not core.is_empty and core.area > 4 * grid.step**2 else part
            inside = contains_xy(probe, gx, gy)
            if inside.sum() < 4:
                continue
            level = float(np.median(h[inside]))
            levels = []
            x0, y0, x1, y1 = part.bounds
            for px in np.arange(np.floor(x0 / PIECE_M) * PIECE_M, x1, PIECE_M):
                for py in np.arange(np.floor(y0 / PIECE_M) * PIECE_M, y1, PIECE_M):
                    m = inside & (gx >= px) & (gx < px + PIECE_M) & (gy >= py) & (gy < py + PIECE_M)
                    if m.sum() >= 4:
                        levels.append([round(float(gx[m].mean()), 1), round(float(gy[m].mean()), 1),
                                       round(float(np.median(h[m])), 1)])
            if levels and np.ptp([v[2] for v in levels]) <= SPREAD_M:
                levels = []
            simple = part.simplify(SIMPLIFY_M, preserve_topology=True)
            if simple.is_empty or not isinstance(simple, Polygon):
                continue
            from shapely.geometry.polygon import orient
            simple = orient(simple, 1.0)
            ring = lambda r: [[round(x, 1), round(y, 1)] for x, y in list(r.coords)[:-1]]  # noqa: E731
            body = {"name": name, "kind": kind, "level": round(level, 1), "area_km2": round(part.area / 1e6, 3),
                    "rings": [ring(simple.exterior), *[ring(i) for i in simple.interiors]]}
            if levels:
                body["levels"] = levels
            bodies.append(body)
    bodies.sort(key=lambda b: -b["area_km2"])
    return bodies
