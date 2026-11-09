# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "shapely"]
# ///
"""Usage: build_buildings.py <city>

Turn raw OSM buildings + the LiDAR grids into the model the viewer loads.

Height for each volume, in order of trust:
  osm-height   an explicit OSM `height` tag
  lidar        roof minus ground from the USGS 3DEP point cloud
  osm-levels   `building:levels` x 3.2 m (used when LiDAR is missing or predates the building)
  guess        nothing known: 4 m

Output: public/data/<city>/buildings.json, data/height_report-<city>.json
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
CITY = sys.argv[1]
CFG = json.loads((ROOT / "public" / "data" / "cities.json").read_text())[CITY]
RAW = ROOT / "data" / "raw" / CITY
OUT = ROOT / "public" / "data" / CITY

TALL_M = 35.0  # buildings at or above this are individually clickable
LEVEL_M = 3.2
GUESS_M = 4.0

terrain_meta = json.loads((OUT / "terrain.json").read_text())
LOCAL = terrain_meta["projection"]
ll_to_local = Transformer.from_crs("EPSG:4326", LOCAL, always_xy=True)
local_to_merc = Transformer.from_crs(LOCAL, "EPSG:3857", always_xy=True)

# ---------------------------------------------------------------- terrain
g = terrain_meta["grids"]["near"]
TERR = np.fromfile(OUT / g["file"], dtype="<u2").reshape(g["ny"], g["nx"]) * g["scale"]


def terrain_at(x, y):
    fx = np.clip((np.asarray(x) - g["x0"]) / g["step"], 0, g["nx"] - 1.001)
    fy = np.clip((np.asarray(y) - g["y0"]) / g["step"], 0, g["ny"] - 1.001)
    ix, iy = fx.astype(int), fy.astype(int)
    ax, ay = fx - ix, fy - iy
    return (TERR[iy, ix] * (1 - ax) * (1 - ay) + TERR[iy, ix + 1] * ax * (1 - ay)
            + TERR[iy + 1, ix] * (1 - ax) * ay + TERR[iy + 1, ix + 1] * ax * ay)


# ---------------------------------------------------------------- lidar
L = np.load(RAW / "lidar_grid.npz")
ZMAX, ZGND = L["zmax"], L["zgnd"]
LX0, LY0, LCELL = float(L["x0"]), float(L["y0"]), float(L["cell"])
LNY, LNX = ZMAX.shape

# The point cloud and the terrain tiles sit on different vertical datums. Measure the
# offset on bare ground and shift LiDAR ground onto the terrain's datum.
_rng = np.random.default_rng(0)
_r, _c = _rng.integers(0, LNY, 60000), _rng.integers(0, LNX, 60000)
_ok = np.isfinite(ZGND[_r, _c])
_lx, _ly = Transformer.from_crs("EPSG:3857", LOCAL, always_xy=True).transform(
    LX0 + (_c[_ok] + 0.5) * LCELL, LY0 + (_r[_ok] + 0.5) * LCELL)
_d = terrain_at(_lx, _ly) - ZGND[_r[_ok], _c[_ok]]
DATUM = float(np.median(_d))
print(f"terrain minus LiDAR ground: median {DATUM:.2f} m, 5-95% {np.percentile(_d, 5):.2f}..{np.percentile(_d, 95):.2f}")


def lidar_sample(poly):
    """Return (roof_p50, roof_p90, ground, n_cells) for a local-metre polygon, or None."""
    def ring_px(ring):
        xs, ys = local_to_merc.transform(*np.asarray(ring.coords).T)
        return (np.asarray(xs) - LX0) / LCELL, (np.asarray(ys) - LY0) / LCELL

    ex, ey = ring_px(poly.exterior)
    pad = 15
    c0, c1 = int(math.floor(ex.min())) - pad, int(math.ceil(ex.max())) + pad
    r0, r1 = int(math.floor(ey.min())) - pad, int(math.ceil(ey.max())) + pad
    if c0 < 0 or r0 < 0 or c1 >= LNX or r1 >= LNY:
        return None
    w, h = c1 - c0 + 1, r1 - r0 + 1
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    d.polygon(list(zip(ex - c0, ey - r0)), fill=1)
    for hole in poly.interiors:
        hx, hy = ring_px(hole)
        d.polygon(list(zip(hx - c0, hy - r0)), fill=0)
    mask = np.asarray(img, dtype=bool)
    zm = ZMAX[r0:r1 + 1, c0:c1 + 1]
    zg = ZGND[r0:r1 + 1, c0:c1 + 1]
    roof = zm[mask & np.isfinite(zm)]
    gnd = zg[np.isfinite(zg) & ~mask]
    if len(roof) < 4 or len(gnd) < 4:
        return None
    return (float(np.percentile(roof, 50)), float(np.percentile(roof, 90)),
            float(np.percentile(gnd, 10)), float(np.percentile(roof, 99)))


# ---------------------------------------------------------------- osm parsing
def num(v):
    if v is None:
        return None
    s = str(v).strip().lower().replace(",", ".")
    try:
        if s.endswith("ft") or s.endswith("'"):
            return float(s.rstrip("ft'").strip()) * 0.3048
        return float(s.rstrip("m").strip())
    except ValueError:
        return None


def project(geom):
    xs, ys = ll_to_local.transform([p["lon"] for p in geom], [p["lat"] for p in geom])
    return list(zip(xs, ys))


def stitch(ways):
    """Join way fragments into closed rings."""
    rings, pool = [], [list(w) for w in ways if len(w) >= 2]
    while pool:
        cur = pool.pop()
        while cur[0] != cur[-1]:
            for i, w in enumerate(pool):
                if w[0] == cur[-1]:
                    cur += w[1:]; pool.pop(i); break
                if w[-1] == cur[-1]:
                    cur += w[-2::-1]; pool.pop(i); break
            else:
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def to_polys(el):
    if el["type"] == "way":
        pts = project(el.get("geometry", []))
        if len(pts) < 4 or pts[0] != pts[-1]:
            return []
        polys = [Polygon(pts)]
    else:
        outers = stitch([project(m["geometry"]) for m in el["members"]
                         if m["type"] == "way" and m.get("role") in ("outer", "") and "geometry" in m])
        inners = [Polygon(r) for r in stitch(
            [project(m["geometry"]) for m in el["members"]
             if m["type"] == "way" and m.get("role") == "inner" and "geometry" in m])]
        polys = []
        for o in outers:
            op = Polygon(o)
            holes = [i.exterior.coords for i in inners if i.is_valid and op.contains(i.representative_point())]
            polys.append(Polygon(o, holes))
    out = []
    for p in polys:
        if not p.is_valid:
            p = p.buffer(0)
        for q in (p.geoms if isinstance(p, MultiPolygon) else [p]):
            if isinstance(q, Polygon) and q.area > 4:
                out.append(q)
    return out


osm = json.loads((RAW / "osm-buildings.json").read_text())
overrides = json.loads((ROOT / "data" / "overrides.json").read_text())
outlines, parts = [], []
for el in osm["elements"]:
    t = el.get("tags", {})
    t.update(overrides.get(f"{el['type'][0]}{el['id']}", {}).get("set", {}))
    polys = to_polys(el)
    if not polys:
        continue
    rec = {"id": f"{el['type'][0]}{el['id']}", "tags": t, "polys": polys}
    if "building:part" in t and t["building:part"] != "no":
        parts.append(rec)
    elif t.get("building") not in (None, "no"):
        outlines.append(rec)

# attach each part to the outline that contains it
geoms, owner = [], []
for i, b in enumerate(outlines):
    for p in b["polys"]:
        geoms.append(p); owner.append(i)
tree = STRtree(geoms)
for b in outlines:
    b["parts"] = []
orphans = []
for part in parts:
    pt = part["polys"][0].representative_point()
    hits = [owner[j] for j in tree.query(pt, predicate="within")]
    if hits:
        outlines[min(hits, key=lambda i: sum(p.area for p in outlines[i]["polys"]))]["parts"].append(part)
    else:
        orphans.append(part)
for o in orphans:  # a part with no outline is its own building
    o["parts"] = []
    outlines.append(o)

# ---------------------------------------------------------------- heights
stats = Counter()
compare = []  # osm height vs lidar, for buildings that have both


def volume_height(tags, poly, allow_guess=True):
    """(height above ground, source, lidar sample)"""
    s = lidar_sample(poly)
    lid = None
    if s:
        p50, p90, gnd, _ = s
        # big footprints: p90 catches the tower on a podium. small ones: median resists overhanging trees
        lid = (p90 if poly.area > 600 else p50) - gnd
    h = num(tags.get("height"))
    lv = num(tags.get("building:levels"))
    if h and h > 0:
        return h, "osm-height", s
    if lv and lv > 0:
        est = lv * LEVEL_M + (num(tags.get("roof:levels")) or 0) * LEVEL_M
        if lid is None or lid < 0.6 * 3.0 * lv or lid > 1.8 * est + 4:
            return est, "osm-levels", s  # LiDAR missing, or it saw something else (pre-dates building, trees)
        return lid, "lidar", s
    if lid is not None and lid >= 2.5:
        return lid, "lidar", s
    return (GUESS_M, "guess", s) if allow_guess else (None, None, s)


def roof_of(tags, poly, wall_h):
    """Pyramid or dome on top of a volume: ["p" | "d", roof height], or None for a flat roof."""
    shape = tags.get("roof:shape")
    rh = num(tags.get("roof:height"))
    if shape in ("dome", "onion"):
        rh = rh or math.sqrt(poly.area / math.pi)  # untagged: a hemisphere on the footprint
        return ["d", round(min(rh, wall_h), 1)]
    if shape in ("pyramidal", "cone") and rh:
        return ["p", round(min(rh, wall_h), 1)]
    return None


def rings(poly):
    def flat(r):
        c = list(r.coords)[:-1]
        return [round(v, 2) for xy in c for v in xy]
    return {"o": flat(poly.exterior), "h": [flat(i) for i in poly.interiors]}


def name_of(t):
    if t.get("name"):
        return t["name"]
    if t.get("addr:housenumber") and t.get("addr:street"):
        return f"{t['addr:housenumber']} {t['addr:street']}"
    return None


buildings = []
for b in outlines:
    t = b["tags"]
    whole = unary_union(b["polys"])
    bx, by = np.asarray(whole.envelope.exterior.coords).T
    s_whole = lidar_sample(max(b["polys"], key=lambda p: p.area))
    terr = float(terrain_at(whole.centroid.x, whole.centroid.y))
    ground = s_whole[2] + DATUM if s_whole else terr
    vols, srcs, roofs = [], [], []
    if b["parts"]:
        covered = []
        for part in b["parts"]:
            pt = part["tags"]
            for poly in part["polys"]:
                h, src, _ = volume_height(pt, poly, allow_guess=False)
                if h is None:  # inherit from the outline
                    h, src = (num(t.get("height")), "osm-height") if num(t.get("height")) else (GUESS_M, "guess")
                mh = num(pt.get("min_height"))
                if mh is None and num(pt.get("building:min_level")):
                    mh = num(pt["building:min_level"]) * LEVEL_M
                mh = min(mh or 0, h - 0.5)
                vols.append((poly, mh, h)); srcs.append(src); roofs.append(roof_of(pt, poly, h - mh)); covered.append(poly)
        rest = whole.difference(unary_union(covered).buffer(0.2))
        for poly in (rest.geoms if hasattr(rest, "geoms") else [rest]):
            if isinstance(poly, Polygon) and poly.area > 60 and poly.area > 0.1 * whole.area:
                poly = poly.buffer(0)
                if not isinstance(poly, Polygon):
                    continue
                s = lidar_sample(poly)  # the outline's own height tag belongs to its tallest part, not this
                h = (s[1] - s[2]) if s and s[1] - s[2] >= 2.5 else GUESS_M
                h = min(h, max(v[2] for v in vols))
                vols.append((poly, 0, h)); srcs.append("lidar" if s else "guess"); roofs.append(None)
    else:
        for poly in b["polys"]:
            h, src, s = volume_height(t, poly)
            vols.append((poly, 0, h)); srcs.append(src); roofs.append(roof_of(t, poly, h))
            if src == "osm-height" and s and poly.area > 150:
                compare.append({"id": b["id"], "name": name_of(t), "osm": round(h, 1),
                                "lidar_p90": round(s[1] - s[2], 1), "lidar_p50": round(s[0] - s[2], 1)})
    tagged = num(t.get("height"))
    if b["parts"] and tagged and max(v[2] for v in vols) < 0.8 * tagged:
        # the parts stop well short of the outline's own height, so they don't describe the
        # whole building (a tower with only its base mapped). Use the outline as tagged.
        vols = [(poly, 0, tagged) for poly in b["polys"]]
        srcs = ["osm-height"] * len(vols)
        roofs = [roof_of(t, poly, tagged) for poly in b["polys"]]
    if not vols:
        continue
    hi = max(range(len(vols)), key=lambda i: vols[i][2])
    top = max(v[2] for v in vols)
    src = srcs[hi]
    if num(t.get("height")) and b["parts"]:
        src = "osm-height"
        if s_whole:
            compare.append({"id": b["id"], "name": name_of(t), "osm": round(num(t["height"]), 1),
                            "lidar_p90": round(s_whole[1] - s_whole[2], 1),
                            "lidar_p50": round(s_whole[0] - s_whole[2], 1)})
    # sink the base below the lowest terrain under the footprint so nothing floats on a slope
    foot = min(ground, float(terrain_at(bx, by).min())) - 2.0
    stats[src] += 1
    c = whole.centroid
    buildings.append({
        "id": b["id"], "name": name_of(t), "h": round(top, 1), "src": src,
        "levels": num(t.get("building:levels")), "ground": round(ground, 1),
        "c": [round(c.x, 1), round(c.y, 1)], "tall": top >= TALL_M,
        "v": [{**rings(p), **({"r": roof} if roof else {}), "b": round(foot if mh == 0 else ground + mh, 1), "t": round(ground + h, 1)}
              for (p, mh, h), roof in zip(vols, roofs)],
    })

buildings.sort(key=lambda b: -b["h"])
(OUT / "buildings.json").write_text(json.dumps({
    "tallCutoff": TALL_M, "osmTimestamp": osm["osm3s"]["timestamp_osm_base"],
    "lidar": str(L["dataset"]), "lidarYear": CFG["lidar"]["year"], "buildings": buildings}, separators=(",", ":")))

tall = [b for b in buildings if b["tall"]]
report = {"counts": dict(stats), "total": len(buildings), "tall": len(tall),
          "tall_list": [{k: b[k] for k in ("id", "name", "h", "src", "levels")} for b in tall],
          "osm_vs_lidar": compare,
          "overrides": {k: v for k, v in overrides.items() if not k.startswith("_")}}
(ROOT / "data" / f"height_report-{CITY}.json").write_text(json.dumps(report, indent=1))

print(f"{len(buildings)} buildings, {sum(len(b['v']) for b in buildings)} volumes")
print("height source:", dict(stats))
print(f"\n{len(tall)} buildings >= {TALL_M} m:")
for b in tall:
    print(f"  {b['h']:6.1f} m  {b['src']:10s} {b['id']:12s} {b['name']}")
print("\nOSM height tag vs LiDAR (independent check):")
for c in sorted(compare, key=lambda c: -c["osm"])[:40]:
    print(f"  {c['osm']:6.1f}  p90 {c['lidar_p90']:6.1f}  p50 {c['lidar_p50']:6.1f}  {c['name']}")
