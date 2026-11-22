# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "requests", "scipy", "shapely"]
# ///
"""Usage: build_terrain.py <city> [grid-or-patch ...]

Build the terrain height grids in local metres from AWS Terrarium tiles
(3DEP-derived in the US): a coarse one for the valley and its mountains, a
fine one for the built-up core, and for some cities a wide one for the drives.
Every grid listed under the city's "terrain" in cities.json is built unless
grid names are given; then only those are rebuilt and the other entries in
terrain.json are kept as they are.

Patches. A city's "terrain" may also list "patches": small finer grids inside
the wide grid for the places where its coarse posts lose the shape of the land
that the drive sees (Black Canyon at Hoover Dam). Each is built like a grid,
from the same tiles, and named by its id like a grid on the command line. A
patch's edges lie on the wide grid's posts and its step divides the wide
step, so the wide mesh can leave out exactly the cells it covers; within
`blend` metres of its edge its heights ease into the wide grid's, so that
along the edge the two surfaces are the same and no seam opens between them.
A patch is drive-only data: terrain.json lists it under "patches", apart from
the grids the map loads. A patch may name the OSM water (lakes, the river)
inside it: build_terrain.py fetches the outlines once from Overpass and writes
them with the level the patch's own heights give each body of water. A patch
may name routes to "carve": the elevation source predates part of the road, so
the road's cuts are carved into the patch along each carriageway's design
profile (scripts/lib/carve.py) from the plan of the route's RoadNet, before
the patch is eased into the wide grid; build the routes' roads after.

Output: public/data/<city>/terrain-<grid>.bin (uint16 decimetres, row 0 = south)
        public/data/<city>/terrain-<patch>.bin, water-<patch>.json
        public/data/<city>/terrain.json
        data/derived/<city>/terrain_patch-<patch>.json   (what was carved, the eased edge)
"""
import io
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
TILES = ROOT / "data" / "raw" / "terrarium"
CITY = sys.argv[1]
ONLY = sys.argv[2:]
CFG = json.loads((ROOT / "data" / "cities.json").read_text())[CITY]
OUT = ROOT / "public" / "data" / CITY
TILES.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

LAT0, LON0 = CFG["origin"]["lat"], CFG["origin"]["lon"]
LOCAL = f"+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
to_ll = Transformer.from_crs(LOCAL, "EPSG:4326", always_xy=True)

# name: (zoom, xmin, ymin, xmax, ymax, step)  -- local metres, east/north of the origin
GRIDS = {k: (g["zoom"], g["x0"], g["y0"], g["x1"], g["y1"], g["step"]) for k, g in CFG["terrain"].items()
         if k != "patches"}
PATCHES = {p["id"]: p for p in CFG["terrain"].get("patches", [])}
if unknown := set(ONLY) - set(GRIDS) - set(PATCHES):
    sys.exit(f"{CITY} has no terrain grid or patch {', '.join(sorted(unknown))}; it has {', '.join([*GRIDS, *PATCHES])}")


def tile(z, x, y):
    p = TILES / f"{z}_{x}_{y}.png"
    if not p.exists():
        r = requests.get(
            f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", timeout=60,
            headers={"User-Agent": "road-pipeline/0.1"},
        )
        r.raise_for_status()
        p.write_bytes(r.content)
    a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def sample_grid(name, z, xmin, ymin, xmax, ymax, step):
    """Heights in metres on the posts of a grid, (ny, nx), row 0 = south."""
    xs = np.arange(xmin, xmax + step, step, dtype=np.float64)
    ys = np.arange(ymin, ymax + step, step, dtype=np.float64)
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = to_ll.transform(gx, gy)
    n = 2**z
    px = (lon + 180) / 360 * n * 256
    py = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n * 256
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256) + 1
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256) + 1
    coords = [(z, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(16) as ex:
        tiles = list(ex.map(lambda c: tile(*c), coords))
    w = tx1 - tx0 + 1
    mosaic = np.block([[tiles[r * w + c] for c in range(w)] for r in range(ty1 - ty0 + 1)])
    fx = px - tx0 * 256 - 0.5
    fy = py - ty0 * 256 - 0.5
    ix = np.clip(np.floor(fx).astype(int), 0, mosaic.shape[1] - 2)
    iy = np.clip(np.floor(fy).astype(int), 0, mosaic.shape[0] - 2)
    ax, ay = fx - ix, fy - iy
    h = (
        mosaic[iy, ix] * (1 - ax) * (1 - ay)
        + mosaic[iy, ix + 1] * ax * (1 - ay)
        + mosaic[iy + 1, ix] * (1 - ax) * ay
        + mosaic[iy + 1, ix + 1] * ax * ay
    )
    print(f"{name}: {len(xs)}x{len(ys)} from {len(coords)} z{z} tiles, {h.min():.0f}..{h.max():.0f} m")
    return h


def build(name, z, xmin, ymin, xmax, ymax, step):
    h = sample_grid(name, z, xmin, ymin, xmax, ymax, step)
    np.round(h * 10).astype("<u2").tofile(OUT / f"terrain-{name}.bin")
    return {"file": f"terrain-{name}.bin", "nx": h.shape[1], "ny": h.shape[0],
            "x0": xmin, "y0": ymin, "step": step, "scale": 0.1}


def build_patch(p, wide_meta):
    """A patch: its own posts from the tiles, eased into the wide grid within `blend` metres of its edge."""
    from lib.heights import Grid
    from lib.water import fetch_water, water_levels

    pid, step = p["id"], p["step"]
    ws = wide_meta["step"]
    for k in ("x0", "x1"):
        if (p[k] - wide_meta["x0"]) % ws:
            sys.exit(f"patch {pid}: {k} must lie on the wide grid's posts ({ws} m from {wide_meta['x0']})")
    for k in ("y0", "y1"):
        if (p[k] - wide_meta["y0"]) % ws:
            sys.exit(f"patch {pid}: {k} must lie on the wide grid's posts ({ws} m from {wide_meta['y0']})")
    if ws % step:
        sys.exit(f"patch {pid}: its step must divide the wide grid's {ws} m")
    wide = Grid("wide", wide_meta, np.fromfile(OUT / wide_meta["file"], dtype="<u2"))
    if not (wide.x0 < p["x0"] and p["x1"] < wide.x1 and wide.y0 < p["y0"] and p["y1"] < wide.y1):
        sys.exit(f"patch {pid} must lie inside the wide grid")
    h = sample_grid(pid, p["zoom"], p["x0"], p["y0"], p["x1"], p["y1"], step)
    report = {"patch": pid, "posts": [int(h.shape[1]), int(h.shape[0])], "step": step}
    if p.get("carve"):
        from lib.carve import carriageways, carve

        routes = {r["id"]: r for r in json.loads((OUT / "routes.json").read_text())["routes"]}
        roads = []
        for rid in p["carve"]:
            rt = routes[rid]
            f = rt["files"]["roadnet"]
            doc = json.loads((OUT / f).read_text())
            blob = (OUT / (f[:-len(".json")] + ".bin")).read_bytes()
            roads += carriageways(doc, blob, [rt["road"], *([rt["opposite"]] if rt.get("opposite") else [])])
        g = {"x0": p["x0"], "y0": p["y0"], "step": step, "nx": h.shape[1], "ny": h.shape[0]}
        h, report["carve"] = carve(h, g, roads)
        for rid, c in report["carve"].items():
            print(f"  carved {rid}: design fill mean {c['design_fill_m']['mean']} m (max {c['design_fill_m']['max']}), "
                  f"cut mean {c['design_cut_m']['mean']} m (max {c['design_cut_m']['max']}), {c['posts_lowered']} posts lowered")
    xs = p["x0"] + np.arange(h.shape[1]) * step
    ys = p["y0"] + np.arange(h.shape[0]) * step
    gx, gy = np.meshgrid(xs.astype(np.float64), ys.astype(np.float64))
    band = float(p.get("blend", BLEND))
    edge = np.minimum.reduce([gx - p["x0"], p["x1"] - gx, gy - p["y0"], p["y1"] - gy])
    u = np.clip(edge / band, 0, 1)
    w = u * u * (3 - 2 * u)  # smoothstep: 0 on the edge, 1 from `band` inward
    hw = wide.sample(gx, gy)
    out = w * h + (1 - w) * hw
    print(f"{pid}: eased into wide within {band:.0f} m (largest change {np.abs(out - h).max():.0f} m, "
          f"wide differs inside by up to {np.abs(hw - h)[w == 1].max():.0f} m)")
    np.round(out * 10).astype("<u2").tofile(OUT / f"terrain-{pid}.bin")
    report["blend"] = {"band_m": band, "largest_change_m": round(float(np.abs(out - h).max()), 1)}
    derived = ROOT / "data" / "derived" / CITY
    derived.mkdir(parents=True, exist_ok=True)
    (derived / f"terrain_patch-{pid}.json").write_text(json.dumps(report, indent=1) + "\n")
    entry = {"file": f"terrain-{pid}.bin", "nx": h.shape[1], "ny": h.shape[0],
             "x0": p["x0"], "y0": p["y0"], "step": step, "scale": 0.1, "blend": band,
             "image": f"ground-{pid}.jpg"}
    if p.get("water", True):
        raw = fetch_water(CITY, pid, to_ll, (p["x0"], p["y0"], p["x1"], p["y1"]), ROOT)
        grid = Grid(pid, entry, np.round(out * 10).astype("<u2"))
        bodies = water_levels(raw, grid, LOCAL)
        if bodies:
            (OUT / f"water-{pid}.json").write_text(json.dumps(
                {"source": "OpenStreetMap (ODbL, (c) OpenStreetMap contributors); levels from the patch's heights",
                 "bodies": bodies}, separators=(",", ":")) + "\n")
            entry["water"] = f"water-{pid}.json"
            for b in bodies:
                print(f"  water: {b['name'] or b['kind']} at {b['level']} m, {sum(len(r) for r in b['rings'])} points")
    return entry


BLEND = 480.0  # m over which a patch eases into the wide grid at its edge (three wide cells)

meta = {"origin": {"lat": LAT0, "lon": LON0}, "projection": LOCAL,
        "source": "AWS Terrain Tiles (Terrarium), USGS 3DEP in the US",
        "grids": {}}
if ONLY:
    # rebuild some grids only: keep every other entry exactly as it was written
    meta = json.loads((OUT / "terrain.json").read_text())
    if meta["projection"] != LOCAL:
        sys.exit("terrain.json has another projection; rebuild every grid")
for k, v in GRIDS.items():
    if not ONLY or k in ONLY:
        meta["grids"][k] = build(k, *v)
if PATCHES:
    if "wide" not in meta["grids"]:
        sys.exit("patches lie in the wide grid: build it first")
    old = meta.pop("patches", {})
    meta["patches"] = {pid: (build_patch(p, meta["grids"]["wide"])
                             if not ONLY or pid in ONLY or "wide" in ONLY or pid not in old else old[pid])
                       for pid, p in PATCHES.items()}
else:
    meta.pop("patches", None)
(OUT / "terrain.json").write_text(json.dumps(meta, indent=1))
