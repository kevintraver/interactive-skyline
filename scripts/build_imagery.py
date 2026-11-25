# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "requests", "scipy"]
# ///
"""Usage: build_imagery.py <city> [grid-or-patch ...]

Drape imagery for the terrain: USGS NAIP aerial photography (public domain),
resampled onto the same local-metre extents as the terrain grids. Every grid and
patch in terrain.json gets its image unless names are given.

The flight's nested grids (plan 03, F6.1: entries of cities.json with an "imagery" source) are draped from
regional mosaics instead, read once through a WMS in EPSG:4326 and cached under data/raw/ (lib/fetch.py:
one request at a time, a pause after each, a generic User-Agent):
- "bluemarble": NASA Blue Marble Next Generation (2004, 500 m) through GIBS, layer BlueMarble_NextGeneration,
  https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi (one request). NASA open data; credit: "We
  acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part
  of NASA's Earth Science Data and Information System (ESDIS)".
- "s2cloudless-2016": EOX Sentinel-2 cloudless, the 2016 edition (layer "s2cloudless"; the later editions are
  non-commercial and are not used), https://tiles.maps.eox.at/wms (four requests of under 4,096 px a side per
  grid, eight in all). CC BY 4.0; credit: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH
  (Contains modified Copernicus Sentinel data 2016 & 2017)". EOX asks that its imagery not be redistributed as
  a stand-alone dataset; draped ground images are not that. (ESA WorldCover's Sentinel-2 composite is the
  fallback the plan names if EOX refuses; it was not needed.)
Fetched on 2026-11-24. Each source image is resampled onto the grid's local-metre pixels through lib.frame,
after a Gaussian prefilter at the output pixel's footprint, and written as WebP.
Colour, down the chain from far (lib.grids.match_colour): each nested image is matched to the next finer
image inside it (valley to far's NAIP, approaches to valley, region to approaches) by each channel's mean and
spread over their overlap; then its seam with that finer image is feathered: the difference of their local
means is carried out past the finer image's edge and eased away over "featherM" metres, so the drawn ground
shows no colour step where one grid hands over to the next. The finer images are never changed, so name the
grids fine to coarse: valley approaches region. region's image also gives terrain.json its "edgeColor": the
mean colour of its outermost 16 pixels, for plan 1's virtual ground beyond it.

Output: public/data/<city>/ground-<grid>.jpg, ground-<patch>.jpg  (row 0 = north)
        public/data/<city>/ground-<nested>.webp, and the nested grids' "image" in terrain.json
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
ONLY = sys.argv[2:]
CFG = json.loads((ROOT / "data" / "cities.json").read_text())[CITY]
OUT = ROOT / "public" / "data" / CITY
CACHE = ROOT / "data" / "raw" / "naip"
CACHE.mkdir(parents=True, exist_ok=True)
URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"

meta = json.loads((OUT / "terrain.json").read_text())
to_merc = Transformer.from_crs(meta["projection"], "EPSG:3857", always_xy=True)
# the grids and the drive's patches (build_terrain.py), by name
CFG_GRIDS = {**{k: g for k, g in CFG["terrain"].items() if k != "patches"},
             **{p["id"]: p for p in CFG["terrain"].get("patches", [])}}
GRIDS = {**meta["grids"], **meta.get("patches", {})}
MPP = {k: g["mpp"] for k, g in CFG_GRIDS.items()}  # output metres per pixel
# JPEG quality per grid; the wide grid and the patches are squeezed to keep the drive's download small
QUALITY = {k: g.get("quality", 84) for k, g in CFG_GRIDS.items()}
if unknown := set(ONLY) - set(GRIDS):
    sys.exit(f"terrain.json for {CITY} has no grid {', '.join(sorted(unknown))}; build it with build_terrain.py first")
TILE = 2000


def chunk(name, bbox, w, h):
    p = CACHE / f"{CITY}_{name}_{'_'.join(str(round(v)) for v in bbox)}.jpg"
    if not p.exists():
        r = requests.get(URL, timeout=180, headers={"User-Agent": "road-pipeline/0.1"}, params={
            "bbox": ",".join(map(str, bbox)), "bboxSR": 3857, "imageSR": 3857,
            "size": f"{w},{h}", "format": "jpg", "f": "image"})
        r.raise_for_status()
        if not r.headers.get("content-type", "").startswith("image"):
            raise RuntimeError(r.text[:300])
        p.write_bytes(r.content)
    return np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"))


NESTED = [k for k, g in CFG_GRIDS.items() if g.get("imagery")]  # the flight's nested grids, coarse to fine

for name, g in GRIDS.items():
    if ONLY and name not in ONLY or name in NESTED:
        continue
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
    Image.fromarray(src[iy, ix]).save(OUT / f"ground-{name}.jpg", quality=QUALITY[name])
    print(f"{name}: {W}x{H} px at {mpp} m/px from {len(jobs)} requests")


# --- the flight's nested grids (plan 03, F6.1) -----------------------------------------------------------
sys.path.insert(0, str(ROOT / "scripts"))
from lib import grids as G  # noqa: E402
from lib.fetch import cached_get  # noqa: E402
from lib.frame import create_frame  # noqa: E402

FRAME = create_frame(CFG)
FETCHED = "2026-11-24"
SOURCES = {
    "bluemarble": {
        "url": "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
        "params": {"SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": "BlueMarble_NextGeneration",
                   "STYLES": "", "SRS": "EPSG:4326", "FORMAT": "image/jpeg"},
        "native_m": 463, "max_px": 8000, "cache": "gibs",
        "name": "NASA Blue Marble Next Generation (2004) through NASA GIBS, layer BlueMarble_NextGeneration",
        "licence": "NASA open data",
        "credit": "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services "
                  "(GIBS), part of NASA's Earth Science Data and Information System (ESDIS)",
    },
    "s2cloudless-2016": {
        "url": "https://tiles.maps.eox.at/wms",
        "params": {"service": "WMS", "version": "1.1.1", "request": "GetMap", "layers": "s2cloudless", "styles": "",
                   "srs": "EPSG:4326", "format": "image/jpeg"},
        "native_m": 10, "max_px": 4000, "cache": "eox",
        "name": "Sentinel-2 cloudless 2016 by EOX, WMS layer s2cloudless",
        "licence": "CC BY 4.0",
        "credit": "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH "
                  "(Contains modified Copernicus Sentinel data 2016 & 2017)",
    },
}


def extent(g):
    return g["x0"], g["y0"], g["x0"] + (g["nx"] - 1) * g["step"], g["y0"] + (g["ny"] - 1) * g["step"]


def pixel_centres(g, mpp, rows=None):
    """Map coordinates of an image's pixel centres (row 0 = north), all rows or a slice of them."""
    x0, y0, x1, y1 = extent(g)
    W, H = int(round((x1 - x0) / mpp)), int(round((y1 - y0) / mpp))
    r = np.arange(H)[rows] if rows is not None else np.arange(H)
    return np.meshgrid(x0 + (np.arange(W) + 0.5) * mpp, y1 - (r + 0.5) * mpp)


def source_mosaic(name, src, g, mpp):
    """The source imagery over a grid, in EPSG:4326: (image row 0 = north, lon0, lat1, dlon, dlat, urls)."""
    import hashlib
    from urllib.parse import urlencode

    x0, y0, x1, y1 = extent(g)
    t = np.linspace(0, 1, 400)
    ex = np.concatenate([x0 + (x1 - x0) * t, np.full_like(t, x1), x0 + (x1 - x0) * t, np.full_like(t, x0)])
    ey = np.concatenate([np.full_like(t, y0), y0 + (y1 - y0) * t, np.full_like(t, y1), y0 + (y1 - y0) * t])
    lat, lon = FRAME.to_geodetic(ex, ey)
    res_m = max(src["native_m"], 0.75 * mpp)  # a little finer than the output, never finer than the source
    dlat = res_m / 111000
    dlon = res_m / (111320 * math.cos(math.radians(CFG["origin"]["lat"])))
    lon0, lon1 = lon.min() - 4 * dlon, lon.max() + 4 * dlon
    lat0, lat1 = lat.min() - 4 * dlat, lat.max() + 4 * dlat
    W, H = int(math.ceil((lon1 - lon0) / dlon)), int(math.ceil((lat1 - lat0) / dlat))
    nxr, nyr = math.ceil(W / src["max_px"]), math.ceil(H / src["max_px"])
    W, H = math.ceil(W / nxr) * nxr, math.ceil(H / nyr) * nyr  # equal pieces
    lon1, lat0 = lon0 + W * dlon, lat1 - H * dlat
    pw, ph = W // nxr, H // nyr
    img = np.zeros((H, W, 3), dtype=np.uint8)
    urls = []
    for r in range(nyr):
        for c in range(nxr):
            bbox = (lon0 + c * pw * dlon, lat1 - (r + 1) * ph * dlat, lon0 + (c + 1) * pw * dlon, lat1 - r * ph * dlat)
            key = str.upper if "SRS" in src["params"] else str.lower  # each service's own spelling
            q = {**src["params"], key("bbox"): ",".join(f"{v:.6f}" for v in bbox), key("width"): pw, key("height"): ph}
            url = src["url"] + "?" + urlencode(q)
            tag = hashlib.sha1(url.encode()).hexdigest()[:10]  # a changed request never reads a stale copy
            cache = ROOT / "data" / "raw" / src["cache"] / f"{CITY}_{name}_{r}_{c}_{tag}.jpg"
            ctype, body = cached_get(url, cache)
            if not ctype.startswith("image"):
                cache.unlink()
                raise RuntimeError(f"{url}: {body[:300]!r}")
            img[r * ph:(r + 1) * ph, c * pw:(c + 1) * pw] = np.asarray(Image.open(io.BytesIO(body)).convert("RGB"))
            urls.append(url)
    print(f"{name}: {W}x{H} px of {src['name']} at {res_m:.0f} m from {len(urls)} requests")
    return img, lon0, lat1, dlon, dlat, urls


def bilinear(img, fx, fy):
    """Bilinear colour at fractional pixel coordinates (pixel centres at integers), clamped at the edge."""
    H, W = img.shape[:2]
    fx = np.clip(fx, 0, W - 1.001)
    fy = np.clip(fy, 0, H - 1.001)
    i, j = np.floor(fx).astype(np.intp), np.floor(fy).astype(np.intp)
    ax, ay = (fx - i)[..., None], (fy - j)[..., None]
    return ((1 - ay) * ((1 - ax) * img[j, i] + ax * img[j, i + 1]) + ay * ((1 - ax) * img[j + 1, i] + ax * img[j + 1, i + 1]))


def prefilter(img, ratio):
    """A Gaussian at an output pixel's footprint, `ratio` source pixels wide, before bilinear sampling."""
    from scipy.ndimage import gaussian_filter

    img = img.astype(np.float32)
    sigma = 0.45 * ratio
    if sigma < 0.3:
        return img
    return np.stack([gaussian_filter(img[..., c], sigma, mode="nearest") for c in range(3)], axis=-1)


def drape(name, src, g, mpp):
    """The grid's image from its source, in local metres: float (H, W, 3), row 0 = north. The resampled image is
    kept losslessly under data/raw/drape/, keyed by the requests and the grid, so a rerun (another quality, another
    colour match) skips the slow part."""
    import hashlib

    img, lon0, lat1, dlon, dlat, urls = source_mosaic(name, src, g, mpp)
    key = hashlib.sha1(json.dumps([urls, extent(g), mpp]).encode()).hexdigest()[:12]
    kept = ROOT / "data" / "raw" / "drape" / f"{CITY}_{name}_{key}.png"
    if kept.exists():
        return np.asarray(Image.open(kept).convert("RGB"), dtype=np.float32), urls
    res_m = dlat * 111000
    img = prefilter(img, mpp / res_m)
    x0, y0, x1, y1 = extent(g)
    H = int(round((y1 - y0) / mpp))
    out = np.zeros((H, int(round((x1 - x0) / mpp)), 3), dtype=np.float32)
    for r0 in range(0, H, 256):
        gx, gy = pixel_centres(g, mpp, slice(r0, min(H, r0 + 256)))
        lat, lon = FRAME.to_geodetic(gx, gy)
        out[r0:r0 + gx.shape[0]] = bilinear(img, (lon - lon0) / dlon - 0.5, (lat1 - lat) / dlat - 0.5)
    out = np.clip(np.round(out), 0, 255).astype(np.uint8)
    kept.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(kept)
    return out.astype(np.float32), urls


def on_pixels(child_img, cg, child_mpp, pg, mpp):
    """A finer image resampled onto a coarser grid's pixels: (image with NaN outside the finer one, inside mask)."""
    cx0, cy0, cx1, cy1 = extent(cg)
    gx, gy = pixel_centres(pg, mpp)
    inside = (gx > cx0) & (gx < cx1) & (gy > cy0) & (gy < cy1)
    img = prefilter(child_img, mpp / child_mpp)
    out = np.full(gx.shape + (3,), np.nan, dtype=np.float64)
    out[inside] = bilinear(img, (gx[inside] - cx0) / child_mpp - 0.5, (cy1 - gy[inside]) / child_mpp - 0.5)
    return out, inside


def finer_of(name):
    """The finer grid inside a nested one whose image it is matched to: the nested child, or the grid it conforms to."""
    kids = [k for k in NESTED if CFG_GRIDS[k].get("parent") == name]
    return kids[0] if kids else (CFG_GRIDS[name].get("conform") or [None])[0]


def load_image(name):
    e = GRIDS[name]
    f = e["image"]["file"] if isinstance(e.get("image"), dict) else f"ground-{name}.jpg"
    return np.asarray(Image.open(OUT / f).convert("RGB"), dtype=np.float32)


notes = {}
for name in reversed(NESTED):  # fine to coarse: each is matched to the finer one already built
    if ONLY and name not in ONLY:
        continue
    c, g = CFG_GRIDS[name], GRIDS[name]
    src = SOURCES[c["imagery"]]
    img, urls = drape(name, src, g, c["mpp"])
    note = {"file": f"ground-{name}.webp", "format": "webp", "mpp": c["mpp"], "width": img.shape[1],
            "height": img.shape[0], "quality": c["quality"], "rows": "row 0 = north",
            "source": src["name"], "licence": src["licence"], "credit": src["credit"], "fetched": FETCHED,
            "requests": urls}
    if fine := finer_of(name):
        fg = GRIDS[fine]
        child, inside = on_pixels(load_image(fine), fg, MPP[fine], g, c["mpp"])
        before = img.reshape(-1, 3)[inside.ravel()].mean(axis=0)
        img = G.match_colour(img, child, inside, feather_px=c["featherM"] / c["mpp"], blur_px=c["blurM"] / c["mpp"])
        note["colourMatch"] = {"to": fine, "featherM": c["featherM"], "blurM": c["blurM"],
                               "overlapMeanBefore": [round(float(v), 1) for v in before],
                               "overlapMeanFiner": [round(float(v), 1) for v in np.nanmean(child[inside], axis=0)]}
    out = np.clip(np.round(img), 0, 255).astype(np.uint8)
    Image.fromarray(out).save(OUT / f"ground-{name}.webp", "WEBP", quality=c["quality"], method=6)
    print(f"{name}: {out.shape[1]}x{out.shape[0]} px at {c['mpp']} m/px, "
          f"{(OUT / f'ground-{name}.webp').stat().st_size / 1e6:.2f} MB")
    notes[name] = {"image": note}
    if not c.get("parent"):  # the outermost grid: its edge's colour for plan 1's virtual ground
        ring = np.ones(out.shape[:2], dtype=bool)
        ring[16:-16, 16:-16] = False
        px = out[ring].astype(np.float64) / 255
        lin = np.where(px <= 0.04045, px / 12.92, ((px + 0.055) / 1.055) ** 2.4)
        notes[name]["edgeColor"] = {"srgb8": [int(round(v)) for v in out[ring].mean(axis=0)],
                                    "linear": [round(float(v), 4) for v in lin.mean(axis=0)],
                                    "ringPx": 16, "note": "mean colour of the image's outermost 16 pixels, for plan "
                                                          "1's virtual ground beyond the terrain (P1-f)"}

if notes:
    meta = json.loads((OUT / "terrain.json").read_text())
    for name, n in notes.items():
        meta["grids"][name].update(n)
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=1))
