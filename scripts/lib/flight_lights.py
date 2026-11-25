"""Lights of the region's towns for the flight (plan 03, F6.4, section 7.11), shared by build_flight_lights.py and
its tests. Pure: no network, no files except data/lamp_types.json (through lib.lamps).

Coordinates are local metres (x east, y north) in the city's transverse Mercator frame (public/data/<city>/terrain.json).

The pieces:
  - where the satellite sees light: a lit mask on a local grid from NASA's Black Marble picture (lit_mask, which
    reads a picture sampled onto the grid and drops the bloom around bright towns by a threshold);
  - which lit cells the valley's lamp inventory already covers (covered_mask) and the towns outside it (clusters);
  - how much light a town gets: lumens per person, calibrated on the valley itself (the inventory's lumens over the
    people of the places inside it, both from the same sources), times the town's people from OpenStreetMap;
  - where its lamps stand: plan 02's rule along the town's OpenStreetMap roads (lib.lamps.place_rule, with the rule's
    parameters as tuned on the Las Vegas inventory), thinned or brightened to the town's lumens (fit_to_target);
  - the served file: the drive's lamp pack layout (scripts/pack_lamps.py, src/drive/lights/pack.js decodeLampPack)
    with a cell size and quantum of its own (encode_pack, decode_pack).
"""
import math
import zlib

import numpy as np

PACK_VERSION = 1
TYPE_BITS, ENCLOSED, RULE, AIM_KNOWN = 7, 1 << 3, 1 << 4, 1 << 5


def stable_hash(*parts):
    """Uniform in [0, 1), the same on every machine and run."""
    return zlib.crc32("|".join(map(str, parts)).encode()) / 2**32


# ---------------------------------------------------------------- the grid
def grid_spec(half_m, cell_m):
    """A square grid centred on the origin: {x0, y0, cell, nx, ny} (row 0 south, column 0 west)."""
    n = int(math.ceil(2 * half_m / cell_m))
    return {"x0": -n * cell_m / 2, "y0": -n * cell_m / 2, "cell": float(cell_m), "nx": n, "ny": n}


def cell_centres(g):
    """(ny, nx) arrays of the cells' centre x and y."""
    xs = g["x0"] + (np.arange(g["nx"]) + 0.5) * g["cell"]
    ys = g["y0"] + (np.arange(g["ny"]) + 0.5) * g["cell"]
    return np.meshgrid(xs, ys)


def cell_index(g, x, y):
    """Row-major cell index of map points, -1 outside."""
    cx = np.floor((np.asarray(x) - g["x0"]) / g["cell"]).astype(np.int64)
    cy = np.floor((np.asarray(y) - g["y0"]) / g["cell"]).astype(np.int64)
    ok = (cx >= 0) & (cy >= 0) & (cx < g["nx"]) & (cy < g["ny"])
    return np.where(ok, cy * g["nx"] + cx, -1)


def sample_picture(rgb, bbox_ll, lon, lat):
    """Nearest pixel of a north-up equirectangular picture (h, w, 3) covering bbox_ll (west, south, east, north) at
    the given longitudes and latitudes (arrays of one shape); 0 outside it."""
    w0, s0, e0, n0 = bbox_ll
    h, w = rgb.shape[:2]
    col = np.floor((np.asarray(lon) - w0) / (e0 - w0) * w).astype(np.int64)
    row = np.floor((n0 - np.asarray(lat)) / (n0 - s0) * h).astype(np.int64)
    ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
    out = np.zeros(np.shape(lon) + (rgb.shape[2],), dtype=rgb.dtype)
    out[ok] = rgb[row[ok], col[ok]]
    return out


# ---------------------------------------------------------------- where the satellite sees light
def light_level(rgb):
    """How lit a Black Marble pixel is, 0 (the dark land of its background) to 1 (saturated): the red channel above
    the background's, over its range. The picture is a display product, stretched and saturating, so this is an
    order, not a radiance."""
    r = np.asarray(rgb)[..., 0].astype(float)
    return np.clip((r - BACKGROUND_RED) / (255.0 - BACKGROUND_RED), 0.0, 1.0)


# The red of the picture's unlit land (its 90th percentile over the region is 33; ASSUMED from that) and the level
# above which a pixel counts as lit. The picture blooms: a town's glow spreads several pixels past its streets at a
# few tens of red levels; 0.35 (red about 110) keeps the streets and drops most of the bloom (checked against the
# valley, where the inventory says which cells have lamps: see lit_mask_agreement).
BACKGROUND_RED = 33.0
LIT_LEVEL = 0.35


def lit_mask(level, threshold=LIT_LEVEL):
    return np.asarray(level) >= threshold


def lit_mask_agreement(mask, lamp_cells):
    """How a lit mask agrees with the cells that hold inventory lamps (both bool, one shape): the share of lamp cells
    it marks lit (recall) and the share of its lit cells that hold lamps (precision)."""
    m, c = np.asarray(mask, bool), np.asarray(lamp_cells, bool)
    tp = float((m & c).sum())
    return {"recall": tp / max(1.0, float(c.sum())), "precision": tp / max(1.0, float(m.sum()))}


def covered_mask(g, xy, radius_m):
    """Cells whose centre lies within radius_m of any point of xy (the inventory's lamps): a town there is the
    inventory's, not this script's."""
    out = np.zeros((g["ny"], g["nx"]), dtype=bool)
    if not len(xy):
        return out
    from scipy.spatial import cKDTree
    cx, cy = cell_centres(g)
    d, _ = cKDTree(np.asarray(xy)).query(np.column_stack([cx.ravel(), cy.ravel()]), k=1, distance_upper_bound=radius_m)
    out.ravel()[:] = np.isfinite(d)
    return out


def clusters(mask, min_cells=1):
    """Connected groups of lit cells (8-neighbour): a list of {label, cells (k, 2) as (row, col), bbox (r0, c0, r1, c1)}
    with at least min_cells cells, largest first."""
    from scipy import ndimage
    lab, n = ndimage.label(np.asarray(mask, bool), structure=np.ones((3, 3), int))
    out = []
    for k, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        rr, cc = np.nonzero(lab[sl] == k)
        if len(rr) < min_cells:
            continue
        cells = np.column_stack([rr + sl[0].start, cc + sl[1].start])
        out.append({"label": k, "cells": cells, "bbox": (sl[0].start, sl[1].start, sl[0].stop - 1, sl[1].stop - 1)})
    out.sort(key=lambda c: (-len(c["cells"]), c["bbox"]))
    return out


# ---------------------------------------------------------------- how much light
def lumens_per_person(inventory_lumens, people):
    """The valley's calibration: its inventory's lumens over the people of the places inside it."""
    if not people > 0:
        raise ValueError("no people inside the inventory: cannot calibrate")
    return inventory_lumens / people


def place_people(places, cluster_xy, radius_m):
    """People of the places (dicts with x, y, population) within radius_m of any cell of a cluster (its cells' centres
    as (k, 2)); each place counts once, for the nearest cluster, decided by the caller passing its clusters in order."""
    if not len(places) or not len(cluster_xy):
        return 0.0, []
    from scipy.spatial import cKDTree
    t = cKDTree(np.asarray(cluster_xy, float))
    taken, total = [], 0.0
    for p in places:
        d, _ = t.query([p["x"], p["y"]], k=1)
        if d <= radius_m:
            taken.append(p)
            total += p["population"]
    return total, taken


def fit_to_target(lumens, target, ids, seed, max_boost=3.0):
    """Thin or brighten a town's rule lamps to its target lumens. Lamps are dropped in a fixed order (a hash of their
    id) until what is left sums to no more than the target; if the rule placed too few, each lamp is brightened, by at
    most max_boost. Returns (keep mask, scale applied to the kept lamps' lumens)."""
    lm = np.asarray(lumens, float)
    n = len(lm)
    if n == 0 or not target > 0:
        return np.zeros(n, bool), 1.0
    total = lm.sum()
    if total <= target:
        return np.ones(n, bool), float(min(max_boost, target / total))
    order = np.argsort([stable_hash(seed, i) for i in ids], kind="stable")
    cum = np.cumsum(lm[order])
    m = int(np.searchsorted(cum, target, side="right"))
    keep = np.zeros(n, bool)
    keep[order[:max(1, m)]] = True
    return keep, 1.0


def cell_points(cxy, level, cell_m, target, seed, block=1, lumens_each=8000.0, max_per_block=8):
    """Points for a town drawn without its roads: its lit cells (centres cxy (k, 2), Black Marble level per cell)
    grouped into blocks of block x block cells; each block takes the town's target lumens in proportion to its cells'
    summed level, as round(lumens / lumens_each) points (1 to max_per_block), each in one of the block's lit cells at a
    hashed position. Returns (xy (n, 2), lumens (n,)), summing to the target."""
    cxy, level = np.asarray(cxy, float), np.asarray(level, float)
    size = cell_m * block
    keys = [tuple(k) for k in np.floor(cxy / size).astype(np.int64).tolist()]
    blocks = {}
    for i, k in enumerate(keys):
        blocks.setdefault(k, []).append(i)
    total = float(level.sum())
    xy, lm = [], []
    for k in sorted(blocks):
        cells = blocks[k]
        share = target * float(level[cells].sum()) / total if total > 0 else target / len(blocks)
        n = int(min(max_per_block, max(1, math.floor(share / lumens_each + 0.5))))
        for j in range(n):
            c = cells[int(stable_hash(seed, "cell", k, j) * len(cells))]
            u, v = stable_hash(seed, "u", k, j) - 0.5, stable_hash(seed, "v", k, j) - 0.5
            xy.append((cxy[c, 0] + u * cell_m, cxy[c, 1] + v * cell_m))
            lm.append(share / n)
    return np.array(xy, float).reshape(-1, 2), np.array(lm, float)


# ---------------------------------------------------------------- the served file
def encode_pack(x, y, mount, type_id, rule, lumens, region, cell, q, mount_q=8, file="lights-region.bin"):
    """The drive's lamp pack layout (version 1; scripts/pack_lamps.py) with this cell size and quantum: lamps sorted
    into cells (row-major from the south-west), within a cell by a hash of their position (the flight draws a cell's
    first k lamps when it thins it, so the order is random); arrays cellStart u32, qx u16, qy u16, mount u8, kind u8,
    flux u16 (lumens / 10), aim u8, lift u8, each on a 4-byte boundary. Returns (bytes, meta)."""
    rx0, ry0, rx1, ry1 = region
    if cell * q > 65536:
        raise ValueError("cell x q must fit uint16")
    nx = int(math.ceil((rx1 - rx0) / cell))
    ny = int(math.ceil((ry1 - ry0) / cell))
    x, y = np.asarray(x, float), np.asarray(y, float)
    inside = (x >= rx0) & (x < rx0 + nx * cell) & (y >= ry0) & (y < ry0 + ny * cell)
    idx = np.nonzero(inside)[0]
    cx = np.floor((x[idx] - rx0) / cell).astype(np.int64)
    cy = np.floor((y[idx] - ry0) / cell).astype(np.int64)
    c = cy * nx + cx
    qx = np.minimum(cell * q - 1, np.round((x[idx] - rx0 - cx * cell) * q)).astype(np.int64)
    qy = np.minimum(cell * q - 1, np.round((y[idx] - ry0 - cy * cell) * q)).astype(np.int64)
    h = np.array([zlib.crc32(f"{a}|{b}".encode()) for a, b in zip(qx, qy)], dtype=np.int64)
    order = np.lexsort((qx, qy, h, c))
    idx, c, qx, qy = idx[order], c[order], qx[order], qy[order]
    start = np.zeros(nx * ny + 1, dtype=np.uint32)
    np.add.at(start, c + 1, 1)
    start = np.cumsum(start).astype(np.uint32)
    mount_a = np.clip(np.round(np.asarray(mount, float)[idx] * mount_q), 1, 255).astype(np.uint8)
    kind = (np.asarray(type_id, int)[idx] & TYPE_BITS) | np.where(np.asarray(rule, bool)[idx], RULE, 0)
    flux = np.clip(np.round(np.asarray(lumens, float)[idx] / 10), 0, 0xFFFF).astype(np.uint16)
    arrays = [("cellStart", start, "uint32"), ("qx", qx.astype(np.uint16), "uint16"), ("qy", qy.astype(np.uint16), "uint16"),
              ("mount", mount_a, "uint8"), ("kind", kind.astype(np.uint8), "uint8"), ("flux", flux, "uint16"),
              ("aim", np.zeros(len(idx), np.uint8), "uint8"), ("lift", np.zeros(len(idx), np.uint8), "uint8")]
    parts, desc, offset = [], [], 0
    for name, arr, kind_name in arrays:
        b = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
        pad = (-len(b)) % 4
        desc.append({"name": name, "type": kind_name, "offset": offset, "length": int(len(arr))})
        parts.append(b + b"\0" * pad)
        offset += len(b) + pad
    meta = {
        "version": PACK_VERSION, "file": file, "count": int(len(idx)), "enclosed": 0, "cell": cell,
        "x0": rx0, "y0": ry0, "nx": nx, "ny": ny, "region": [rx0, ry0, rx1, ry1], "q": q, "mountQ": mount_q,
        "bits": {"type": TYPE_BITS, "enclosed": ENCLOSED, "rule": RULE, "aimKnown": AIM_KNOWN},
        "arrays": desc, "bytes": offset,
    }
    return b"".join(parts), meta, idx


_TYPED = {"uint32": "<u4", "uint16": "<u2", "uint8": "u1"}


def decode_pack(meta, data):
    """Python twin of src/drive/lights/pack.js decodeLampPack, for the tests: x, y, mount, type, rule, lumens."""
    if len(data) != meta["bytes"]:
        raise ValueError("size")
    a = {d["name"]: np.frombuffer(data, dtype=_TYPED[d["type"]], count=d["length"], offset=d["offset"]) for d in meta["arrays"]}
    n, cell, q, nx = meta["count"], meta["cell"], meta["q"], meta["nx"]
    x, y = np.zeros(n), np.zeros(n)
    s = a["cellStart"]
    for c in np.nonzero(s[1:] > s[:-1])[0]:
        i0, i1 = s[c], s[c + 1]
        x[i0:i1] = meta["x0"] + (c % nx) * cell + a["qx"][i0:i1] / q
        y[i0:i1] = meta["y0"] + (c // nx) * cell + a["qy"][i0:i1] / q
    k = a["kind"]
    return {"x": x, "y": y, "mount": a["mount"] / meta["mountQ"], "type": k & TYPE_BITS, "rule": (k & RULE) > 0,
            "lumens": a["flux"].astype(float) * 10, "cellStart": s}


def pack_cell_runs(meta, data):
    """(cell, first, count) of every non-empty cell."""
    s = np.frombuffer(data, dtype="<u4", count=meta["nx"] * meta["ny"] + 1, offset=0)
    nz = np.nonzero(s[1:] > s[:-1])[0]
    return [(int(c), int(s[c]), int(s[c + 1] - s[c])) for c in nz]

