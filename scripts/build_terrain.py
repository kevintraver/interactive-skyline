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
profile (scripts/lib/carve.py) from the plan of the route's RoadNet (its
carriageways and their lead-ins and lead-outs), before
the patch is eased into the wide grid; build the routes' roads after.

Nested grids (plan 03, F6.1). An entry with "encoding": "delta-gzip" is one of the flight's
nested grids (region, approaches, valley), built by build_nested():
- sampled from the tiles `supersample` x `supersample` times per post's footprint (a square of one post
  spacing centred on the post) and reduced to the post by the block mean ("downsample": "mean") or by the
  summit-preserving rule of lib.grids.keep_summits ("summits": summits and ridges keep the block maximum, valley
  floors and lakes the mean, so ranges keep their height on the skyline);
- the source despiked first (lib.grids.despike: Terrarium's low zooms hold single pixels thousands of metres
  off their neighbours, which a summit-preserving downsample would otherwise raise into needles);
- the sea set to 0 m (Terrarium carries bathymetry; lib.grids.flatten_sea);
- stitched to its "parent": its edges lie on the parent's posts, its step divides the parent's, and its outer
  eight posts ease into the parent's surface so the two agree along the edge (lib.grids.stitch_to_parent);
- bent to the existing grids it contains, listed in "conform" (far in valley), which are not rebuilt and do
  not sit on its posts (lib.grids.conform_to_child);
- written in the delta-gzip encoding of lib.grids.DELTA_GZIP_SPEC (heights with a -500 m offset, so Death
  Valley and the Salton Trough fit), the specification copied into the entry.
A parent is built before its children: name them coarse to fine, or name one whose parent is already in
terrain.json. Built only when named or when every grid is built; the existing grids are untouched when only
nested grids are named:  uv run scripts/build_terrain.py lv region approaches valley
Projection through lib.frame (the twin of the browser's frame). Tiles fetched on 2026-11-24: Terrarium z9
(region) and z11 (approaches, valley), 1,602 tiles, from
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png. Credit (tilezen/joerd attribution):
"United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological
Survey"; region also crosses Mexico: "INEGI, Continuo de Elevaciones Mexicano 3.0 (CEM 3.0)", and the sea
floor: "ETOPO1 courtesy of NOAA".

Output: public/data/<city>/terrain-<grid>.bin (uint16 decimetres, row 0 = south)
        public/data/<city>/terrain-<nested>.bin.gz (delta-gzip, row 0 = south)
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
         if k != "patches" and g.get("encoding") != "delta-gzip"}
# the flight's nested grids (plan 03), coarse to fine as cities.json lists them
NESTED = {k: g for k, g in CFG["terrain"].items() if k != "patches" and g.get("encoding") == "delta-gzip"}
PATCHES = {p["id"]: p for p in CFG["terrain"].get("patches", [])}
if unknown := set(ONLY) - set(GRIDS) - set(NESTED) - set(PATCHES):
    sys.exit(f"{CITY} has no terrain grid or patch {', '.join(sorted(unknown))}; it has {', '.join([*GRIDS, *NESTED, *PATCHES])}")


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
            cws = [rt["road"], *([rt["opposite"]] if rt.get("opposite") else [])]
            # and their lead-ins and lead-outs (build_roads.py: the same road on beyond the route's ends, as scenery)
            leads = [r["id"] for r in doc["roads"] if (r.get("lead") or {}).get("of") in cws]
            roads += carriageways(doc, blob, cws + leads)
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

# --- the flight's nested grids (plan 03, F6.1) -------------------------------------------------------------
OFFSET = -500.0  # m: a nested grid's heights are q * scale + OFFSET (lib.grids.DELTA_GZIP_SPEC)
STITCH = 8  # posts over which a nested grid's edge eases into its parent


from lib.grids import despike  # noqa: E402


class TileCache:
    """Decoded Terrarium tiles of one zoom, the most recent kept in memory."""

    def __init__(self, z, keep=600):
        self.z, self.keep, self.tiles = z, keep, {}

    def get(self, x, y):
        k = (x, y)
        if k not in self.tiles:
            if len(self.tiles) >= self.keep:
                self.tiles.pop(next(iter(self.tiles)))
            self.tiles[k] = tile(self.z, x, y).astype(np.float32)
        return self.tiles[k]

    def sample(self, lat, lon):
        """Bilinear heights at points in degrees, as sample_grid does."""
        n = 2**self.z
        px = (lon + 180) / 360 * n * 256 - 0.5
        py = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n * 256 - 0.5
        tx0, tx1 = int(px.min() // 256), int(px.max() // 256) + 1
        ty0, ty1 = int(py.min() // 256), int(py.max() // 256) + 1
        coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
        missing = [c for c in coords if not (TILES / f"{self.z}_{c[0]}_{c[1]}.png").exists()]
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(lambda c: tile(self.z, *c), missing))
        mosaic = np.block([[self.get(tx, ty) for tx in range(tx0, tx1 + 1)] for ty in range(ty0, ty1 + 1)])
        mosaic = despike(mosaic)  # Terrarium's single bad pixels, thousands of metres off
        fx, fy = px - tx0 * 256, py - ty0 * 256
        ix = np.clip(np.floor(fx).astype(np.intp), 0, mosaic.shape[1] - 2)
        iy = np.clip(np.floor(fy).astype(np.intp), 0, mosaic.shape[0] - 2)
        ax, ay = fx - ix, fy - iy
        return ((1 - ay) * ((1 - ax) * mosaic[iy, ix] + ax * mosaic[iy, ix + 1])
                + ay * ((1 - ax) * mosaic[iy + 1, ix] + ax * mosaic[iy + 1, ix + 1]))


def nested_surface(meta_entry):
    """A built grid's heights in metres as a lib.grids.Surface: a nested grid's delta-gzip file or a raw one."""
    from lib.grids import Surface, decode_delta_gzip

    g = meta_entry
    blob = (OUT / g["file"]).read_bytes()
    if g.get("encoding") == "delta-gzip":
        h = decode_delta_gzip(blob, g["nx"], g["ny"], g["scale"], g["offset"])
    else:
        h = np.frombuffer(blob, dtype="<u2").astype(np.float64).reshape(g["ny"], g["nx"]) * g["scale"]
    return Surface(h, g)


def build_nested(name, c, grids_meta):
    """One of the flight's nested grids (see the header); returns its terrain.json entry."""
    from lib import grids
    from lib.frame import create_frame

    frame = create_frame(CFG)
    step, k = c["step"], c["supersample"]
    nx = (c["x1"] - c["x0"]) // step + 1
    ny = (c["y1"] - c["y0"]) // step + 1
    cache = TileCache(c["zoom"])
    fx = c["x0"] - step / 2 + (np.arange(nx * k) + 0.5) * (step / k)
    m = np.empty((ny, nx))
    x = np.empty((ny, nx))
    rows = max(1, 2_000_000 // (nx * k * k))  # post rows per strip
    for j0 in range(0, ny, rows):
        j1 = min(ny, j0 + rows)
        fy = c["y0"] - step / 2 + (np.arange(j0 * k, j1 * k) + 0.5) * (step / k)
        gx, gy = np.meshgrid(fx, fy)
        lat, lon = frame.to_geodetic(gx, gy)
        m[j0:j1], x[j0:j1] = grids.block_stats(cache.sample(lat, lon), k)
        print(f"\r{name}: rows {j1}/{ny}", end="", flush=True)
    print()
    h = grids.keep_summits(m, x) if c["downsample"] == "summits" else m
    lifted = h - m
    h = grids.flatten_sea(h)
    g = {"x0": c["x0"], "y0": c["y0"], "step": step, "nx": nx, "ny": ny}
    notes = {}
    if c.get("parent"):
        if c["parent"] not in grids_meta:
            sys.exit(f"{name} is stitched to {c['parent']}: build that first")
        before = h
        h = grids.stitch_to_parent(h, g, nested_surface(grids_meta[c["parent"]]), band=STITCH)
        notes["stitched"] = {"to": c["parent"], "posts": STITCH,
                             "largestChangeM": round(float(np.abs(h - before).max()), 1)}
    for child in c.get("conform", []):
        before = h
        h = grids.conform_to_child(h, g, nested_surface(grids_meta[child]), band=STITCH)
        notes.setdefault("conformedTo", []).append(
            {"grid": child, "posts": STITCH, "largestChangeM": round(float(np.abs(h - before).max()), 1)})
    scale = c.get("scale", 0.1)  # m per step: coarse grids need no decimetres, and are smaller without them
    blob = grids.encode_delta_gzip(h, scale=scale, offset=OFFSET)
    (OUT / f"terrain-{name}.bin.gz").write_bytes(blob)
    print(f"{name}: {nx}x{ny} posts at {step} m from z{c['zoom']} x{k * k} samples each, {h.min():.0f}..{h.max():.0f} m, "
          f"summits lifted up to {lifted.max():.0f} m, {len(blob) / 1e6:.2f} MB")
    entry = {"file": f"terrain-{name}.bin.gz", "nx": int(nx), "ny": int(ny), "x0": c["x0"], "y0": c["y0"],
             "step": step, "scale": scale, "offset": OFFSET, "encoding": "delta-gzip",
             "encodingSpec": grids.DELTA_GZIP_SPEC, "priority": c["priority"],
             "priorityNote": "nesting rank, coarsest 0: where grids overlap the higher one is drawn and answers "
                             "heightAt, and the lower ones load first; far and near, which carry none, rank above",
             "parent": c.get("parent"), "conform": c.get("conform", []),
             "image": {"file": f"ground-{name}.webp", "format": "webp", "mpp": c["mpp"]},
             "source": {
                 "heights": f"AWS Terrain Tiles (Terrarium) zoom {c['zoom']}, "
                            "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png, fetched 2026-11-24",
                 "credit": "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the "
                           "U.S. Geological Survey" + ("; INEGI, Continuo de Elevaciones Mexicano 3.0; ETOPO1 courtesy "
                                                       "of NOAA" if name == "region" else ""),
                 "downsample": {"summits": "summit-preserving (lib/grids.py keep_summits): ridges and summits keep the "
                                           "highest of the post's footprint, valleys and lakes its mean",
                                "mean": "the mean of the post's footprint"}[c["downsample"]]
                               + f", {k}x{k} samples a post",
                 **notes}}
    return entry

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
for k, c in NESTED.items():
    if not ONLY or k in ONLY:
        old = meta["grids"].get(k) or {}
        meta["grids"][k] = build_nested(k, c, meta["grids"])
        # what build_imagery.py wrote about the image stays
        if isinstance(old.get("image"), dict) and old["image"].get("file") == meta["grids"][k]["image"]["file"]:
            meta["grids"][k]["image"] = old["image"]
        if "edgeColor" in old:
            meta["grids"][k]["edgeColor"] = old["edgeColor"]
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
