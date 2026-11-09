# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "requests"]
# ///
"""Usage: build_imagery.py <city>

Drape imagery for the terrain: USGS NAIP aerial photography (public domain),
resampled onto the same local-metre extents as the two terrain grids.

Output: public/data/<city>/ground-{far,near}.jpg  (row 0 = north)
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
CITY = sys.argv[1]
CFG = json.loads((ROOT / "public" / "data" / "cities.json").read_text())[CITY]
OUT = ROOT / "public" / "data" / CITY
CACHE = ROOT / "data" / "raw" / "naip"
CACHE.mkdir(parents=True, exist_ok=True)
URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"

meta = json.loads((OUT / "terrain.json").read_text())
to_merc = Transformer.from_crs(meta["projection"], "EPSG:3857", always_xy=True)
MPP = {k: g["mpp"] for k, g in CFG["terrain"].items()}  # output metres per pixel
TILE = 2000


def chunk(name, bbox, w, h):
    p = CACHE / f"{CITY}_{name}_{'_'.join(str(round(v)) for v in bbox)}.jpg"
    if not p.exists():
        r = requests.get(URL, timeout=180, params={
            "bbox": ",".join(map(str, bbox)), "bboxSR": 3857, "imageSR": 3857,
            "size": f"{w},{h}", "format": "jpg", "f": "image"})
        r.raise_for_status()
        if not r.headers.get("content-type", "").startswith("image"):
            raise RuntimeError(r.text[:300])
        p.write_bytes(r.content)
    return np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"))


for name, g in meta["grids"].items():
    mpp = MPP[name]
    x1 = g["x0"] + (g["nx"] - 1) * g["step"]
    y1 = g["y0"] + (g["ny"] - 1) * g["step"]
    W, H = int((x1 - g["x0"]) / mpp), int((y1 - g["y0"]) / mpp)
    gx, gy = np.meshgrid(g["x0"] + (np.arange(W) + 0.5) * mpp, y1 - (np.arange(H) + 0.5) * mpp)
    mx, my = to_merc.transform(gx, gy)
    # source mosaic in web mercator, a little finer than the output
    res = mpp / math.cos(math.radians(CFG["origin"]["lat"])) * 0.9
    sx0, sy1 = mx.min() - res * 2, my.max() + res * 2
    SW = int((mx.max() - sx0) / res) + 3
    SH = int((sy1 - my.min()) / res) + 3
    jobs = [(c, r, min(TILE, SW - c), min(TILE, SH - r)) for r in range(0, SH, TILE) for c in range(0, SW, TILE)]

    def get(j):
        c, r, w, h = j
        return chunk(name, (sx0 + c * res, sy1 - (r + h) * res, sx0 + (c + w) * res, sy1 - r * res), w, h)

    src = np.zeros((SH, SW, 3), dtype=np.uint8)
    with ThreadPoolExecutor(4) as ex:
        for (c, r, w, h), a in zip(jobs, ex.map(get, jobs)):
            src[r:r + h, c:c + w] = a
    ix = np.clip(((mx - sx0) / res).astype(int), 0, SW - 1)
    iy = np.clip(((sy1 - my) / res).astype(int), 0, SH - 1)
    Image.fromarray(src[iy, ix]).save(OUT / f"ground-{name}.jpg", quality=84)
    print(f"{name}: {W}x{H} px at {mpp} m/px from {len(jobs)} requests")
