# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "requests"]
# ///
"""Usage: build_terrain.py <city>

Build two terrain height grids in local metres from AWS Terrarium tiles
(3DEP-derived in the US): a coarse one for the valley and its mountains, and a
fine one for the built-up core.

Output: public/data/<city>/terrain-{far,near}.bin (uint16 decimetres, row 0 = south)
        public/data/<city>/terrain.json
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
TILES = ROOT / "data" / "raw" / "terrarium"
CITY = sys.argv[1]
CFG = json.loads((ROOT / "public" / "data" / "cities.json").read_text())[CITY]
OUT = ROOT / "public" / "data" / CITY
TILES.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

LAT0, LON0 = CFG["origin"]["lat"], CFG["origin"]["lon"]
LOCAL = f"+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
to_ll = Transformer.from_crs(LOCAL, "EPSG:4326", always_xy=True)

# name: (zoom, xmin, ymin, xmax, ymax, step)  -- local metres, east/north of the origin
GRIDS = {k: (g["zoom"], g["x0"], g["y0"], g["x1"], g["y1"], g["step"]) for k, g in CFG["terrain"].items()}


def tile(z, x, y):
    p = TILES / f"{z}_{x}_{y}.png"
    if not p.exists():
        r = requests.get(
            f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", timeout=60
        )
        r.raise_for_status()
        p.write_bytes(r.content)
    a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def build(name, z, xmin, ymin, xmax, ymax, step):
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
    np.round(h * 10).astype("<u2").tofile(OUT / f"terrain-{name}.bin")
    print(f"{name}: {len(xs)}x{len(ys)} from {len(coords)} z{z} tiles, {h.min():.0f}..{h.max():.0f} m")
    return {"file": f"terrain-{name}.bin", "nx": len(xs), "ny": len(ys),
            "x0": xmin, "y0": ymin, "step": step, "scale": 0.1}


meta = {"origin": {"lat": LAT0, "lon": LON0}, "projection": LOCAL,
        "source": "AWS Terrain Tiles (Terrarium), USGS 3DEP in the US",
        "grids": {k: build(k, *v) for k, v in GRIDS.items()}}
(OUT / "terrain.json").write_text(json.dumps(meta, indent=1))
