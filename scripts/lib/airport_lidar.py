"""Heights of the airport's buildings from the USGS 3DEP LiDAR survey, the way scripts/build_buildings.py measures the
city's: the roof is a percentile of the highest returns inside the footprint (the 90th on footprints over 600 m², so a
taller block on a low hall sets the height; the median on smaller ones, so a tree or a mast does not), the ground the
10th percentile of the ground returns around it, within 22 m.

The city's grid (scripts/fetch_lidar.py, data/raw/<city>/lidar_grid.npz) covers its building box, which stops north of
most of the airport, so the airport's buildings are read here from the same public Entwine (EPT) copy of the survey,
only over boxes around the footprints and the runway ends, and rasterised on the fly to the same 1.5 m grid in the
survey's own EPSG:3857 (zmax: highest return that is not noise; zgnd: lowest ground return). Only that grid is kept
(data/raw/airport/<faa>/lidar.npz); the point tiles are read and dropped.

    from lib import airport_lidar as lid
    r = lid.fetch_raster(lid.boxes_for(polys, frame), dataset, max_depth, cache, cell_m)
    s = lid.sample(r, polygon_in_map_metres, frame); h, h_max = lid.building_height(s, polygon.area)
"""
import io
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely import contains_xy
from shapely.geometry import Polygon

R = 6378137.0
EPT = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{dataset}"
PAD_M = 22.0  # the ground ring around a footprint (15 cells of 1.5 m, as the city's)


# ------------------------------------------------------------------ frames
def to_mercator(frame, x, y):
    lat, lon = frame.to_geodetic(np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64))
    return R * np.radians(lon), R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def to_local(frame, mx, my):
    lon = np.degrees(np.asarray(mx, dtype=np.float64) / R)
    lat = np.degrees(2 * np.arctan(np.exp(np.asarray(my, dtype=np.float64) / R)) - np.pi / 2)
    return frame.to_local(lat, lon)


def mercator_scale(frame, y):
    """Mercator units per true metre at map northing y."""
    lat, _ = frame.to_geodetic(0.0, float(y))
    return 1 / math.cos(math.radians(float(lat)))


# ------------------------------------------------------------------ the grid
@dataclass
class Raster:
    zmax: np.ndarray  # (ny, nx) highest non-noise return, NaN where none; row 0 = south
    zgnd: np.ndarray  # (ny, nx) lowest ground return, NaN where none
    x0: float  # EPSG:3857 of the south-west corner
    y0: float
    cell: float  # EPSG:3857 units

    def centres(self):
        ny, nx = self.zmax.shape
        return np.meshgrid(self.x0 + (np.arange(nx) + 0.5) * self.cell, self.y0 + (np.arange(ny) + 0.5) * self.cell)

    def window(self, mx0, my0, mx1, my1):
        """(row slice, column slice) of the cells overlapping a box, or None if the box leaves the grid."""
        ny, nx = self.zmax.shape
        c0, c1 = int(math.floor((mx0 - self.x0) / self.cell)), int(math.ceil((mx1 - self.x0) / self.cell))
        r0, r1 = int(math.floor((my0 - self.y0) / self.cell)), int(math.ceil((my1 - self.y0) / self.cell))
        if c0 < 0 or r0 < 0 or c1 > nx or r1 > ny:
            return None
        return slice(r0, r1), slice(c0, c1)


def sample(raster, poly, frame, pad_m=PAD_M):
    """(roof p50, roof p90, ground p10, roof p99) in the survey's heights for a footprint in map metres, or None when
    it is not inside the grid or too few returns fall on or around it."""
    ext = np.asarray(poly.exterior.coords)
    mx, my = to_mercator(frame, ext[:, 0], ext[:, 1])
    mpoly = Polygon(np.column_stack([mx, my]), [np.column_stack(to_mercator(frame, *np.asarray(h.coords).T))
                                                for h in poly.interiors])
    pad = pad_m * mercator_scale(frame, ext[:, 1].mean())
    win = raster.window(mx.min() - pad, my.min() - pad, mx.max() + pad, my.max() + pad)
    if win is None:
        return None
    rs, cs = win
    cx = raster.x0 + (np.arange(cs.start, cs.stop) + 0.5) * raster.cell
    cy = raster.y0 + (np.arange(rs.start, rs.stop) + 0.5) * raster.cell
    gx, gy = np.meshgrid(cx, cy)
    inside = contains_xy(mpoly, gx, gy)
    zm, zg = raster.zmax[rs, cs], raster.zgnd[rs, cs]
    roof = zm[inside & np.isfinite(zm)]
    gnd = zg[~inside & np.isfinite(zg)]
    if len(roof) < 4 or len(gnd) < 4:
        return None
    return (float(np.percentile(roof, 50)), float(np.percentile(roof, 90)), float(np.percentile(gnd, 10)),
            float(np.percentile(roof, 99)))


def building_height(s, area):
    """(height, highest point) above the ground from a sample(); (None, None) without one."""
    if s is None:
        return None, None
    p50, p90, gnd, p99 = s
    return (p90 if area > 600 else p50) - gnd, p99 - gnd


def datum_offset(raster, frame, pts):
    """Median of (surveyed elevation - LiDAR ground) at points [[x, y, z], ...] in map metres: how far the LiDAR's
    heights sit below the survey's (NASR's runway ends). The ground at a point is the median of the 5 x 5 cells
    around it."""
    pts = np.asarray(pts, dtype=np.float64)
    mx, my = to_mercator(frame, pts[:, 0], pts[:, 1])
    d = []
    for x, y, z in zip(mx, my, pts[:, 2]):
        c, r = int((x - raster.x0) / raster.cell), int((y - raster.y0) / raster.cell)
        g = raster.zgnd[max(r - 2, 0):r + 3, max(c - 2, 0):c + 3]
        g = g[np.isfinite(g)]
        if len(g):
            d.append(z - float(np.median(g)))
    return float(np.median(d)) if d else None


def boxes_for(polys, frame, pad=40.0):
    """EPSG:3857 boxes (x0, y0, x1, y1) around each footprint (map metres) with `pad` metres to spare."""
    out = []
    for p in polys:
        x0, y0, x1, y1 = p.bounds
        mx, my = to_mercator(frame, np.array([x0 - pad, x1 + pad]), np.array([y0 - pad, y1 + pad]))
        out.append((float(mx[0]), float(my[0]), float(mx[1]), float(my[1])))
    return out


# ------------------------------------------------------------------ the download
def fetch_raster(boxes, dataset, max_depth, cache: Path, cell_m, lat, threads=6):
    """The survey's zmax and zgnd over the union of `boxes` (EPSG:3857), from the EPT nodes that touch any box down
    to `max_depth`; cached in `cache` (npz). `lat` sets the 3857 cell for `cell_m` true metres."""
    cache = Path(cache)
    if cache.exists():
        z = np.load(cache)
        return Raster(z["zmax"], z["zgnd"], float(z["x0"]), float(z["y0"]), float(z["cell"]))
    from concurrent.futures import ThreadPoolExecutor

    import laspy
    import requests

    from .fetch import UA

    base = EPT.format(dataset=dataset)
    ses = requests.Session()
    ses.headers.update(UA)

    def get(url):
        for attempt in range(5):
            try:
                r = ses.get(url, timeout=120)
                if r.status_code == 200:
                    return r.content
            except requests.RequestException:
                pass
        raise RuntimeError(f"failed {url}")

    import json
    ept = json.loads(get(f"{base}/ept.json"))
    bx0, by0, _, bx1, _, _ = ept["bounds"]
    size = bx1 - bx0

    def touches(d, x, y):
        s = size / (1 << d)
        a0, b0 = bx0 + x * s, by0 + y * s
        return any(a0 < c and a0 + s > a and b0 < e and b0 + s > b for a, b, c, e in boxes)

    hier = json.loads(get(f"{base}/ept-hierarchy/0-0-0-0.json"))
    keys, stack = [], [(0, 0, 0, 0)]
    while stack:
        d, x, y, z = stack.pop()
        k = f"{d}-{x}-{y}-{z}"
        n = hier.get(k)
        if n is None or not touches(d, x, y):
            continue
        if n == -1:
            hier.update(json.loads(get(f"{base}/ept-hierarchy/{k}.json")))
            n = hier[k]
        if n > 0:
            keys.append(k)
        if d < max_depth:
            stack += [(d + 1, 2 * x + i, 2 * y + j, 2 * z + m) for i in (0, 1) for j in (0, 1) for m in (0, 1)]

    cell = cell_m / math.cos(math.radians(lat))
    X0, Y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    X1, Y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    nx, ny = int(math.ceil((X1 - X0) / cell)), int(math.ceil((Y1 - Y0) / cell))
    zmax = np.full((ny, nx), -np.inf, dtype=np.float32)
    zgnd = np.full((ny, nx), np.inf, dtype=np.float32)
    print(f"  LiDAR: {len(keys)} tiles of {dataset} to depth {max_depth}, grid {nx} x {ny}", flush=True)

    def read(k):
        las = laspy.read(io.BytesIO(get(f"{base}/ept-data/{k}.laz")))
        x, y = np.asarray(las.x), np.asarray(las.y)
        z, c = np.asarray(las.z, dtype=np.float32), np.asarray(las.classification)
        m = (x >= X0) & (x < X1) & (y >= Y0) & (y < Y1)
        return x[m], y[m], z[m], c[m]

    total = 0
    with ThreadPoolExecutor(threads) as ex:
        for i, (x, y, z, c) in enumerate(ex.map(read, keys)):
            ix, iy = ((x - X0) / cell).astype(np.int32), ((y - Y0) / cell).astype(np.int32)
            ok = (c != 7) & (c != 18)  # not noise
            np.maximum.at(zmax, (iy[ok], ix[ok]), z[ok])
            g = c == 2
            np.minimum.at(zgnd, (iy[g], ix[g]), z[g])
            total += len(z)
            if i % 50 == 0:
                print(f"    {i}/{len(keys)} tiles, {total:,} points", flush=True)
    zmax[~np.isfinite(zmax)] = np.nan
    zgnd[~np.isfinite(zgnd)] = np.nan
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, zmax=zmax, zgnd=zgnd, x0=X0, y0=Y0, cell=cell, dataset=dataset, depth=max_depth,
                        points=total)
    return Raster(zmax, zgnd, X0, Y0, cell)
