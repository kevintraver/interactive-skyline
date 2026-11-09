# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "laspy[lazrs]", "requests"]
# ///
"""Pull USGS 3DEP LiDAR for one city from the public Entwine (EPT) bucket and
rasterise it to surface and ground grids.

Usage: fetch_lidar.py <city>
Output: data/raw/<city>/lidar_grid.npz  (zmax = highest return, zgnd = lowest ground return)
"""
import io
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import laspy
import numpy as np
import requests

ROOT = Path(__file__).resolve().parent.parent
CITY = sys.argv[1]
CFG = json.loads((ROOT / "public" / "data" / "cities.json").read_text())[CITY]
RAW = ROOT / "data" / "raw" / CITY
CACHE = RAW / "ept"
CACHE.mkdir(parents=True, exist_ok=True)

DATASET = CFG["lidar"]["dataset"]
BASE = f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{DATASET}"
MAX_DEPTH = CFG["lidar"]["maxDepth"]  # octree depth that gives roughly one point per grid cell

# Building bbox plus a margin (lat/lon)
S, W, N, E = (v + d for v, d in zip(CFG["bbox"], (-0.001, -0.001, 0.001, 0.001)))
CELL = CFG["lidar"]["cell"] / math.cos(math.radians((S + N) / 2))  # true metres -> EPSG:3857 units


def to3857(lon, lat):
    x = lon * 20037508.342789244 / 180
    y = math.log(math.tan((90 + lat) * math.pi / 360)) * 20037508.342789244 / math.pi
    return x, y


X0, Y0 = to3857(W, S)
X1, Y1 = to3857(E, N)
NX = int(math.ceil((X1 - X0) / CELL))
NY = int(math.ceil((Y1 - Y0) / CELL))

session = requests.Session()


def get(url):
    for attempt in range(5):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 200:
                return r.content
        except requests.RequestException:
            pass
    raise RuntimeError(f"failed {url}")


ept = json.loads(get(f"{BASE}/ept.json"))
bx0, by0, bz0, bx1, by1, bz1 = ept["bounds"]
size = bx1 - bx0


def node_bounds(d, x, y):
    s = size / (1 << d)
    return bx0 + x * s, by0 + y * s, bx0 + (x + 1) * s, by0 + (y + 1) * s


def intersects(d, x, y):
    ax0, ay0, ax1, ay1 = node_bounds(d, x, y)
    return ax0 < X1 and ax1 > X0 and ay0 < Y1 and ay1 > Y0


hier = {}


def load_hier(key):
    return json.loads(get(f"{BASE}/ept-hierarchy/{key}.json"))


def walk():
    pending = ["0-0-0-0"]
    hier.update(load_hier("0-0-0-0"))
    out = []
    stack = [(0, 0, 0, 0)]
    while stack:
        d, x, y, z = stack.pop()
        key = f"{d}-{x}-{y}-{z}"
        n = hier.get(key)
        if n is None or not intersects(d, x, y):
            continue
        if n == -1:
            hier.update(load_hier(key))
            n = hier[key]
        if n > 0:
            out.append(key)
        if d < MAX_DEPTH:
            for dx in (0, 1):
                for dy in (0, 1):
                    for dz in (0, 1):
                        stack.append((d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz))
    return out


def fetch(key):
    p = CACHE / f"{key}.laz"
    if not p.exists():
        p.write_bytes(get(f"{BASE}/ept-data/{key}.laz"))
    las = laspy.read(io.BytesIO(p.read_bytes()))
    x = np.asarray(las.x)
    y = np.asarray(las.y)
    z = np.asarray(las.z, dtype=np.float32)
    c = np.asarray(las.classification)
    m = (x >= X0) & (x < X1) & (y >= Y0) & (y < Y1)
    return x[m], y[m], z[m], c[m]


def main():
    keys = walk()
    print(f"{len(keys)} nodes to read, grid {NX}x{NY}", flush=True)
    zmax = np.full((NY, NX), -np.inf, dtype=np.float32)
    zgnd = np.full((NY, NX), np.inf, dtype=np.float32)
    classes = {}
    total = 0
    with ThreadPoolExecutor(12) as ex:
        for i, (x, y, z, c) in enumerate(ex.map(fetch, keys)):
            total += len(z)
            for k, v in zip(*np.unique(c, return_counts=True)):
                classes[int(k)] = classes.get(int(k), 0) + int(v)
            ix = ((x - X0) / CELL).astype(np.int32)
            iy = ((y - Y0) / CELL).astype(np.int32)
            ok = (c != 7) & (c != 18)  # drop noise
            np.maximum.at(zmax, (iy[ok], ix[ok]), z[ok])
            g = c == 2
            np.minimum.at(zgnd, (iy[g], ix[g]), z[g])
            if i % 50 == 0:
                print(f"  {i}/{len(keys)}  {total:,} pts", flush=True)
    print(f"total points in bbox: {total:,}")
    print("classification counts:", classes)
    print("cells with a return: %.1f%%" % (100 * np.isfinite(zmax).mean()))
    print("cells with ground:   %.1f%%" % (100 * np.isfinite(zgnd).mean()))
    np.savez_compressed(
        RAW / "lidar_grid.npz",
        zmax=zmax, zgnd=zgnd, x0=X0, y0=Y0, cell=CELL, dataset=DATASET,
    )


if __name__ == "__main__":
    sys.exit(main())
