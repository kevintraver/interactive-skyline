# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "h5py", "pyproj", "requests"]
# ///
"""Usage: build_nightlights.py <city> [--raw DIR ...] [--years 2023,2024,2025]

The satellite's view of the city at night (plan 01, section 6.2, "build_nightlights.py in detail"; T4.4).

NASA Black Marble VNP46A4 (collection 2, archive set 5200): yearly, moonlight- and atmosphere-corrected
radiance in the VIIRS Day/Night Band, on 10 degree tiles of 15 arc-second cells.

1. Tiles: h = floor((lon + 180) / 10), v = floor((90 - lat) / 10); every tile the region grid touches.
2. NearNadir_Composite_Snow_Free as R and OffNadir_Composite_Snow_Free as R40-60, each with its _Quality;
   where near-nadir is poor, gap-filled or missing, AllAngle_Composite_Snow_Free. The median of the three
   most recent full years.
3. Resampled onto local-metre grids in the transverse Mercator frame of public/data/<city>/terrain.json, by
   averaging 4 x 4 samples per cell (area-weighted, so the total is kept).
4. uint16, square-root curve: R = (v / 256)^2 nW cm-2 sr-1.
5. A uint8 plane: off-nadir over near-nadir, clipped to 0..4, stored as ratio x 64 (1.0 where R < 0.5).
6. Sidecar public/data/<city>/nightlights.json; 7. data/derived/<city>/nightlights.npy + .json for plan 02.

Tiles are read from data/raw/nightlights/ and any --raw directory (read only). A missing tile is downloaded
from LAADS with the Earthdata bearer token in EARTHDATA_TOKEN, which is read only then and never written
anywhere.

Output: public/data/<city>/nightlights-metro.bin, nightlights-region.bin, nightlights.json
        data/derived/<city>/nightlights.npy, nightlights.json; the `nightlights` block in data/cities.json
"""
import argparse
import json
import math
import os
import re
import sys
import time
import warnings
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nightlights"
LAADS = "https://ladsweb.modaps.eosdis.nasa.gov/archive/allData/5200/VNP46A4"
UA = {"User-Agent": "interactive-skyline-data/1.0"}
FIELDS = "HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/"
LAYERS = ("NearNadir_Composite_Snow_Free", "OffNadir_Composite_Snow_Free", "AllAngle_Composite_Snow_Free")
FILL = -999.9
QUALITY_GOOD = 0  # 0 good, 1 poor, 2 gap-filled, 255 fill
TILE_DEG = 10.0
SUPERSAMPLE = 4
RATIO_SCALE = 64  # uint8 ratio = round(ratio x 64), so 0 .. 3.98
RATIO_FLOOR = 0.5  # below this near-nadir radiance the ratio means nothing and is stored as 1.0
CITATION = ("Román, M.O., Wang, Z., Sun, Q., Kalb, V., Miller, S.D., Molthan, A., Schultz, L., Bell, J., Stokes, E.C., "
            "Pandey, B. and Seto, K.C. et al. (2018). NASA's Black Marble nighttime lights product suite. Remote Sensing "
            "of Environment 210, 113-143. Data: VNP46A4, doi:10.5067/VIIRS/VNP46A4.002")


# ---------------------------------------------------------------- tiles
def tile_of(lat, lon):
    return int(math.floor((lon + 180) / TILE_DEG)), int(math.floor((90 - lat) / TILE_DEG))


def tiles_for(lat_min, lon_min, lat_max, lon_max):
    h0, v1 = tile_of(lat_min, lon_min)
    h1, v0 = tile_of(lat_max, lon_max)
    return [(h, v) for v in range(v0, v1 + 1) for h in range(h0, h1 + 1)]


def tile_name(h, v):
    return f"h{h:02d}v{v:02d}"


def find_tile(year, h, v, dirs):
    pat = re.compile(rf"VNP46A4\.A{year}001\.{tile_name(h, v)}\.002\.\d+\.h5$")
    for d in dirs:
        if d.exists():
            for p in sorted(d.iterdir()):
                if pat.match(p.name):
                    return p
    return None


def laads_years():
    import requests
    r = requests.get(LAADS + ".json", headers=UA, timeout=60)
    r.raise_for_status()
    time.sleep(1)
    return sorted(int(x["name"]) for x in r.json()["content"] if x["name"].isdigit())


def download_tile(year, h, v):
    """Fetch one tile into data/raw/nightlights/. The token is read here and only here."""
    import requests
    token = os.environ.get("EARTHDATA_TOKEN")
    r = requests.get(f"{LAADS}/{year}/001.json", headers=UA, timeout=60)
    r.raise_for_status()
    time.sleep(1)
    names = [x["name"] for x in r.json()["content"] if f".{tile_name(h, v)}." in x["name"]]
    if not names:
        raise SystemExit(f"LAADS lists no VNP46A4 {year} tile {tile_name(h, v)}")
    if not token:
        raise SystemExit(f"tile {names[0]} is not in the cache and EARTHDATA_TOKEN is not set; "
                         f"place it in {RAW} or set the token (see the script's docstring)")
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / names[0]
    part = dest.with_suffix(".part")
    with requests.get(f"{LAADS}/{year}/001/{names[0]}", headers={**UA, "Authorization": f"Bearer {token}"},
                      timeout=900, stream=True) as resp:
        resp.raise_for_status()
        if "html" in resp.headers.get("content-type", ""):
            raise SystemExit("LAADS answered with a web page instead of the file: the token was refused")
        with open(part, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
    part.rename(dest)
    time.sleep(2)
    return dest


# ---------------------------------------------------------------- reading
def read_layer(f, name):
    """A composite layer as float64 radiance with NaN where filled, honouring scale and offset attributes."""
    ds = f[FIELDS + name]
    a = ds[()].astype(np.float64)
    fill = ds.attrs.get("_FillValue", FILL)
    fill = float(np.asarray(fill).ravel()[0])
    scale = float(np.asarray(ds.attrs.get("scale_factor", 1.0)).ravel()[0])
    offset = float(np.asarray(ds.attrs.get("add_offset", 0.0)).ravel()[0])
    bad = np.isclose(a, fill) | (a < -900)
    a = a * scale + offset
    a[bad] = np.nan
    return a


def read_quality(f, name):
    ds = f[FIELDS + name + "_Quality"]
    return ds[()].astype(np.int32)


def read_tile(path):
    """(near-nadir R with all-angle fallback, off-nadir R40-60), NaN where nothing usable."""
    import h5py
    with h5py.File(path, "r") as f:
        near, off, allang = (read_layer(f, n) for n in LAYERS)
        qn, qo, qa = (read_quality(f, n) for n in LAYERS)
    use_all = (qn != QUALITY_GOOD) | ~np.isfinite(near)
    r = np.where(use_all, np.where(np.isfinite(allang) & (qa != 255), allang, np.nan), near)
    r40 = np.where((qo == 255) | ~np.isfinite(off), np.nan, off)
    return r, r40, int(use_all.sum())


def mosaic(per_tile, tiles):
    """Join tiles into one lat/lon array. Returns (array, lat of row 0's north edge, lon of column 0's west edge, cell degrees)."""
    hs = sorted({h for h, _ in tiles})
    vs = sorted({v for _, v in tiles})
    n = next(iter(per_tile.values())).shape[0]
    out = np.full((n * len(vs), n * len(hs)), np.nan)
    for (h, v), a in per_tile.items():
        i, j = vs.index(v), hs.index(h)
        out[i * n:(i + 1) * n, j * n:(j + 1) * n] = a
    return out, 90 - TILE_DEG * vs[0], -180 + TILE_DEG * hs[0], TILE_DEG / n


def resample(src, north, west, deg, grid, to_ll):
    """Mean of SUPERSAMPLE^2 nearest-cell samples over each local-metre cell. Row 0 = south."""
    nx, ny, cell = grid["nx"], grid["ny"], grid["cell"]
    off = (np.arange(SUPERSAMPLE) + 0.5) / SUPERSAMPLE
    out = np.zeros((ny, nx))
    xs = grid["x0"] + (np.arange(nx)[:, None] + off[None, :]).ravel() * cell
    for r in range(ny):
        acc = np.zeros(nx)
        for oy in off:
            y = np.full(xs.shape, grid["y0"] + (r + oy) * cell)
            lon, lat = to_ll.transform(xs, y)
            ci = np.floor((np.asarray(lon) - west) / deg).astype(int)
            ri = np.floor((north - np.asarray(lat)) / deg).astype(int)
            ok = (ci >= 0) & (ri >= 0) & (ci < src.shape[1]) & (ri < src.shape[0])
            v = np.zeros(xs.shape)
            v[ok] = src[ri[ok], ci[ok]]
            acc += np.nan_to_num(v).reshape(nx, SUPERSAMPLE).sum(axis=1)
        out[r] = acc / SUPERSAMPLE**2
    return out


# ---------------------------------------------------------------- encoding
def encode_radiance(r):
    return np.clip(np.round(np.sqrt(np.clip(r, 0, None)) * 256), 0, 65535).astype("<u2")


def decode_radiance(v):
    return (np.asarray(v, dtype=np.float64) / 256) ** 2


def encode_ratio(r, r40):
    ratio = np.where(r >= RATIO_FLOOR, r40 / np.maximum(r, 1e-9), 1.0)
    return np.clip(np.round(np.clip(ratio, 0, 4) * RATIO_SCALE), 0, 255).astype(np.uint8)


def grid_of(spec):
    g = dict(spec)
    g["nx"] = round((g["x1"] - g["x0"]) / g["cell"])
    g["ny"] = round((g["y1"] - g["y0"]) / g["cell"])
    return g


def latlon_bounds(grid, to_ll):
    xs = np.linspace(grid["x0"], grid["x1"], 41)
    ys = np.linspace(grid["y0"], grid["y1"], 41)
    edge = [(x, grid["y0"]) for x in xs] + [(x, grid["y1"]) for x in xs] + [(grid["x0"], y) for y in ys] + [(grid["x1"], y) for y in ys]
    lon, lat = to_ll.transform([p[0] for p in edge], [p[1] for p in edge])
    return min(lat), min(lon), max(lat), max(lon)


def build(city, raw_dirs, years=None, write=True, cities_path=None):
    from pyproj import Transformer
    cities_path = cities_path or ROOT / "data" / "cities.json"
    cities = json.loads(cities_path.read_text())
    cfg = cities[city]
    proj = json.loads((ROOT / "public" / "data" / city / "terrain.json").read_text())["projection"]
    to_ll = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    grids = {k: grid_of(cfg["nightlights"][k]) for k in ("metro", "region")}
    bounds = latlon_bounds(grids["region"], to_ll)
    tiles = tiles_for(*bounds)
    dirs = [RAW, *raw_dirs]
    if years is None:
        try:
            years = laads_years()[-3:]
        except Exception as e:  # offline: the newest three years present in the cache
            found = sorted({int(m.group(1)) for d in dirs if d.exists() for p in d.iterdir()
                            if (m := re.match(r"VNP46A4\.A(\d{4})001\.", p.name))})
            if len(found) < 3:
                raise SystemExit(f"cannot list LAADS ({e.__class__.__name__}) and fewer than three years are cached")
            years = found[-3:]
    print(f"{city}: tiles {[tile_name(*t) for t in tiles]}, years {years}")

    stacks, stacks40, files, fallback = [], [], [], 0
    for y in years:
        per, per40 = {}, {}
        for h, v in tiles:
            p = find_tile(y, h, v, dirs) or download_tile(y, h, v)
            r, r40, fb = read_tile(p)
            per[(h, v)], per40[(h, v)] = r, r40
            fallback += fb
            files.append(p.name)
        m, north0, west0, deg = mosaic(per, tiles)
        m40, *_ = mosaic(per40, tiles)
        # keep only the rows and columns the region grid can sample (Salt Lake City's four tiles are 4800 x 4800)
        r0 = max(0, int((north0 - (bounds[2] + 0.1)) / deg))
        r1 = min(m.shape[0], int((north0 - (bounds[0] - 0.1)) / deg) + 1)
        c0 = max(0, int((bounds[1] - 0.1 - west0) / deg))
        c1 = min(m.shape[1], int((bounds[3] + 0.1 - west0) / deg) + 1)
        north, west = north0 - r0 * deg, west0 + c0 * deg
        stacks.append(m[r0:r1, c0:c1])
        stacks40.append(m40[r0:r1, c0:c1])
        del per, per40, m, m40
    with warnings.catch_warnings():  # cells filled in every year stay NaN, then 0
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(np.stack(stacks), axis=0)
        med40 = np.nanmedian(np.stack(stacks40), axis=0)
    med = np.nan_to_num(med)
    med40 = np.nan_to_num(med40)

    out_pub = ROOT / "public" / "data" / city
    out_der = ROOT / "data" / "derived" / city
    result = {"tiles": [tile_name(*t) for t in tiles], "years": years, "files": files, "grids": {}}
    planes = {}
    for k, g in grids.items():
        r = resample(med, north, west, deg, g, to_ll)
        r40 = resample(med40, north, west, deg, g, to_ll)
        planes[k] = (r, r40)
        v, q = encode_radiance(r), encode_ratio(r, r40)
        result["grids"][k] = {"file": f"nightlights-{k}.bin", "x0": g["x0"], "y0": g["y0"], "z0": -g["y0"],
                              "step": g["cell"], "nx": g["nx"], "ny": g["ny"],
                              "planes": [{"name": "radiance", "type": "uint16", "offset": 0, "decode": "R = (v / 256)^2"},
                                         {"name": "offNadirRatio", "type": "uint8", "offset": 2 * g["nx"] * g["ny"],
                                          "decode": f"ratio = v / {RATIO_SCALE}"}],
                              "maxRadiance": float(r.max()), "sumRadiance": float(r.sum())}
        if write:
            out_pub.mkdir(parents=True, exist_ok=True)
            with open(out_pub / f"nightlights-{k}.bin", "wb") as f:
                f.write(v.tobytes())
                f.write(q.tobytes())
    result["fallbackCells"] = fallback

    today = date.today().isoformat()
    meta = {
        "product": "VNP46A4", "collection": "002 (archive set 5200)",
        "productName": "VIIRS/NPP Lunar BRDF-Adjusted Nighttime Lights Yearly L3 Global 15 arc second Linear Lat Lon Grid",
        "years": years, "combine": "median of the years, cell by cell", "tiles": result["tiles"], "files": files,
        "layers": {"radiance": "NearNadir_Composite_Snow_Free (view zenith 0-20 deg); where its _Quality is not 0 (good), AllAngle_Composite_Snow_Free",
                   "offNadir": "OffNadir_Composite_Snow_Free (view zenith 40-60 deg)"},
        "units": "nW cm-2 sr-1", "band": "VIIRS Day/Night Band, 0.5-0.9 um", "overpassLocal": "01:30",
        "frame": f"local metres of public/data/{city}/terrain.json (x east, y north); row 0 = south, column 0 = west; world z = -y",
        "projection": proj, "resample": f"mean of {SUPERSAMPLE}x{SUPERSAMPLE} nearest-cell samples per cell",
        "encoding": {"radiance": "uint16 little-endian, R = (v / 256)^2", "offNadirRatio": f"uint8, ratio = v / {RATIO_SCALE}, clipped to 0..4; 1.0 where R < {RATIO_FLOOR}"},
        "grids": result["grids"],
        "calibration": {"k": None, "kNote": "nW cm-2 sr-1 per cd/m2 toward the zenith; fitted by calibrate_skyglow.py (T4.7). Published values run from about 260 to 714; Otus 3 fits 278 and 371 (plan 01, 7.8)",
                        "G": 0.15, "F": "per cell, 0.05 to 0.20 from offNadirRatio, for everything but street lamps (plan 01, 7.8)"},
        "source": {"url": LAADS + "/<year>/001/<file>", "listing": LAADS + ".json", "retrieved": today,
                   "licence": "CC0: \"data provided from a NASA-led mission are licensed as Creative Commons Zero\"",
                   "doi": "10.5067/VIIRS/VNP46A4.002", "citation": CITATION,
                   "credit": "NASA Black Marble (VNP46A4), doi:10.5067/VIIRS/VNP46A4.002"},
        "nearNadirFallbackCells": fallback,
    }
    if write:
        (out_pub / "nightlights.json").write_text(json.dumps(meta, indent=1))
        out_der.mkdir(parents=True, exist_ok=True)
        g = grids["metro"]
        np.save(out_der / "nightlights.npy", planes["metro"][0].astype(np.float32))
        (out_der / "nightlights.json").write_text(json.dumps({
            "product": "VNP46A4", "year": years, "units": "nW cm-2 sr-1", "x0": g["x0"], "y0": g["y0"],
            "cell": g["cell"], "nx": g["nx"], "ny": g["ny"],
            "frame": f"local metres, {proj}; rows south to north, columns west to east; x0, y0 the south-west corner",
            "overpassLocal": "01:30", "band": "VIIRS Day/Night Band, 0.5-0.9 um",
            "source": f"public/data/{city}/nightlights-metro.bin, near-nadir radiance before encoding"}, indent=1))
        block = cfg["nightlights"]
        block.update({"product": "VNP46A4.002", "years": years, "tiles": result["tiles"],
                      "files": {"metro": "nightlights-metro.bin", "region": "nightlights-region.bin", "meta": "nightlights.json"}})
        cities_path.write_text(json.dumps(cities, indent=2, ensure_ascii=False) + "\n")
    return result, planes, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--raw", action="append", default=[], type=Path, help="another directory holding VNP46A4 tiles (read only)")
    ap.add_argument("--years", help="comma-separated years instead of the three most recent on LAADS")
    a = ap.parse_args()
    years = [int(y) for y in a.years.split(",")] if a.years else None
    result, planes, _ = build(a.city, a.raw, years)
    r = planes["metro"][0]
    order = np.argsort(r.ravel())[::-1][:5]
    g = result["grids"]["metro"]
    print("brightest metro cells (x, y km from the origin, radiance):")
    for i in order:
        row, col = divmod(int(i), g["nx"])
        print(f"  {(g['x0'] + (col + 0.5) * g['step']) / 1000:7.2f} {(g['y0'] + (row + 0.5) * g['step']) / 1000:7.2f}  {r.ravel()[i]:9.1f}")


if __name__ == "__main__":
    main()
