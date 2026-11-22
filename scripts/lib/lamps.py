"""Street-lamp logic shared by build_lights.py and its tests (plan 02, D5.3; plan 01, T4.0).

Pure: no network, no files except data/lamp_types.json. Coordinates are local metres (x east, y north) in
the city's transverse Mercator frame (public/data/<city>/terrain.json)."""
import json
import math
import re
import zlib
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
TYPES = json.loads((ROOT / "data" / "lamp_types.json").read_text())
TYPE_BY_KEY = {t["key"]: t for t in TYPES["types"]}
CLASSES = ["sodium", "led", "other"]
FT = 0.3048

# road classes the rule knows, from OSM `highway`
ROAD_CLASS = {
    "motorway": "freeway", "trunk": "major", "primary": "major", "secondary": "collector", "tertiary": "collector",
    "unclassified": "local", "residential": "local", "living_street": "local",
    "motorway_link": "ramp", "trunk_link": "ramp", "primary_link": "ramp", "secondary_link": "ramp", "tertiary_link": "ramp",
}
SURFACE_CLASSES = ("local", "collector", "major")  # the ones whose density marks a built-up area

# record of the `lamps` layer (plan 02, 5.9: one 16-byte record per lamp)
LAMP_DTYPE = np.dtype([("x_mm", "<i4"), ("y_mm", "<i4"), ("mount_dm", "<u2"), ("type", "u1"), ("flags", "u1"),
                       ("flux_10lm", "<u2"), ("aim_cdeg", "<u2")])
AIM_UNKNOWN = 0xFFFF
FLAG_RULE = 1  # bit 0: placed by rule, not from an inventory; bits 1-3: source id (SOURCE_IDS)
FLAG_ENCLOSED = 16  # bit 4: under a bridge or in a tunnel: lights the road, sends nothing to the sky


def county_enclosed(supp_type, comments):
    """Clark County fixtures mounted under bridges (SUPP_TYPE UBL) or recorded as tunnel luminaires."""
    return (supp_type or "").strip().upper() == "UBL" or "TUNNEL" in (comments or "").upper()


def stable_hash(*parts):
    """A hash that is the same on every machine and run (Python's hash() is salted)."""
    return zlib.crc32("|".join(map(str, parts)).encode()) / 2**32


# ---------------------------------------------------------------- types and flux
def lumens(type_key, watts):
    """Initial lumens of one lamp of a type at a wattage, from data/lamp_types.json."""
    t = TYPE_BY_KEY[type_key]
    if watts is None or not watts > 0:
        watts = t["defaultWatts"]
    eff = t["lmPerW"]
    if isinstance(eff, dict):  # efficacy by wattage, interpolated in log(W)
        ws = sorted(float(k) for k in eff)
        es = [eff[str(int(w)) if float(int(w)) == w else str(w)] for w in ws]
        e = float(np.interp(math.log(watts), [math.log(w) for w in ws], es))
    else:
        e = float(eff)
    return watts * e


def lamp_class(type_key):
    return TYPE_BY_KEY[type_key]["class"]


def watts_of(text):
    """Total watts in a field such as '100', '2X250', '2X801X100' (2 x 80 + 1 x 100), '160/110', '72WLED'.

    Returns None when no wattage can be read."""
    if text is None:
        return None
    s = str(text).strip().upper()
    if not s:
        return None
    m = re.fullmatch(r"((?:\d+X\d+)+)", s)
    if m:  # groups of count X watts, run together: "2X801X100" = 2X80 + 1X100
        total, rest = 0, s
        while rest:
            g = re.match(r"(\d)X(\d+?)(?=\dX|$)", rest)
            if not g:
                return None
            total += int(g.group(1)) * int(g.group(2))
            rest = rest[g.end():]
        return float(total)
    m = re.match(r"(\d+(?:\.\d+)?)", s)
    if m and not re.fullmatch(r"\d+L", s):  # '26L' is not a wattage
        return float(m.group(1))
    return None


def county_type(fixture, lamp, supp_type):
    """Clark County fixture fields -> (type key, watts). FIXTURE holds the fitted luminaire; LAMP says
    LAMP2LED once a fixture was converted, so FIXTURE is read first."""
    f = (fixture or "").upper().strip()
    if not f or f == "PRIVATE":
        f = (lamp or "").upper().strip()
    if f in ("", "PRIVATE", "LAMP2LED"):
        return ("led_highmast" if supp_type == "HIMAST" else "unknown"), None
    w = watts_of(re.sub(r"^IND\s*", "", f))
    if "LED" in f:
        return ("led_highmast" if supp_type == "HIMAST" else "led_street"), w
    if "HPS" in f:
        return "hps", w
    if f.startswith("IND") or "IND" in f:
        return "induction", w
    if "MH" in f:
        return "metal_halide", w
    return "unknown", w


def clv_type(type_field, watt):
    """City of Las Vegas `TYPE` and `WATT` -> (type key, watts). The codes are the city's; their meaning is
    read from the values present (HPS..., LED..., MH..., MV..., FL flood, UP up-light)."""
    t = (type_field or "").upper().strip()
    w = watts_of(watt)
    if t.startswith("HPS"):
        return "hps", w
    if t.startswith("LED"):
        return "led_street", w
    if t.startswith("MH"):
        return "metal_halide", w
    if t.startswith("MV"):
        return "mercury_vapor", w
    if t == "FL":
        return "metal_halide", w  # floodlight of unrecorded type: assumed metal halide
    return "unknown", w


def henderson_type(fixture_type, wattage):
    f = (fixture_type or "").upper().strip()
    w = float(wattage) if wattage not in (None, "") else None
    if f == "HPS":
        return "hps", w
    if f == "INDUCTION":
        return "induction", w
    # LED, and the decorative community post-tops (ANTHEM, INSPIRADA, SEVEN HILLS, ...) of the LED programme
    return "led_street", w


def boulder_type(lamp_type, wattage):
    t = (lamp_type or "").upper().strip()
    w = watts_of(wattage)
    if w is not None and w < 20:  # '1', '4', '5': not a wattage
        w = None
    if t == "HPS":
        return "hps", w
    if t == "CP":
        return "unknown", w
    # LED, and blank: the layer records the city's dark-sky replacement of its lights with LEDs (assumed)
    return "led_street", w


def osm_type(tags):
    t = (tags.get("lamp_type") or tags.get("light:method") or "").lower()
    mount = (tags.get("lamp_mount") or tags.get("light:mount") or "").lower()
    if "led" in t:
        key = "led_highmast" if mount == "high_mast" else "led_street"
    elif "sodium" in t or t in ("hps", "high_pressure_sodium", "low_pressure_sodium"):
        key = "hps"
    elif "mercury" in t:
        key = "mercury_vapor"
    elif "halide" in t:
        key = "metal_halide"
    elif "fluorescent" in t:
        key = "fluorescent"
    elif mount == "high_mast":
        key = "led_highmast"
    else:
        key = "unknown"
    return key, watts_of(tags.get("light:power") or tags.get("lamp_power"))


def feet(text):
    """'30FT' -> 9.144 m; anything else -> None."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*FT\s*", str(text or "").upper())
    return float(m.group(1)) * FT if m else None


# ---------------------------------------------------------------- de-duplication
def dedupe(sources, radius=5.0):
    """Merge lamp sources in priority order. A lamp within `radius` metres of one already accepted from a
    higher-priority source is dropped. Lamps of the same source are never merged with each other (two heads
    on one pole are two lamps).

    sources: list of (name, xy array (n, 2)). Returns (list of keep-masks, dict of drops by source)."""
    accepted = np.zeros((0, 2))
    masks, drops = [], {}
    for name, xy in sources:
        xy = np.asarray(xy, dtype=float).reshape(-1, 2)
        if len(accepted) and len(xy):
            d, _ = cKDTree(accepted).query(xy, k=1, distance_upper_bound=radius)
            keep = ~np.isfinite(d)
        else:
            keep = np.ones(len(xy), dtype=bool)
        masks.append(keep)
        drops[name] = int((~keep).sum())
        accepted = np.vstack([accepted, xy[keep]])
    return masks, drops


def near_pairs_within(xy, radius=5.0):
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    return len(cKDTree(xy).query_pairs(radius)) if len(xy) > 1 else 0


# ---------------------------------------------------------------- roads and the rule
def densify(coords, step):
    """Points every `step` metres along a polyline, with the distance along it and the unit tangent."""
    c = np.asarray(coords, dtype=float)
    seg = np.diff(c, axis=0)
    ln = np.hypot(seg[:, 0], seg[:, 1])
    keep = ln > 1e-6
    c = np.vstack([c[:1], c[1:][keep]])
    seg, ln = seg[keep], ln[keep]
    if not len(ln):
        return np.zeros((0, 2)), np.zeros(0), np.zeros((0, 2)), 0.0
    cum = np.concatenate([[0], np.cumsum(ln)])
    total = float(cum[-1])
    return c, cum, seg / ln[:, None], total


def points_along(coords, spacing, start, offset=0.0, stagger=False):
    """Positions at `start`, `start + spacing`, ... along a polyline, pushed `offset` metres to the right of
    the direction of travel (left when negative). With `stagger`, every other point goes to the other side."""
    c, cum, tan, total = densify(coords, spacing)
    if total <= 0 or start > total:
        return np.zeros((0, 2))
    s = np.arange(start, total, spacing)
    i = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(tan) - 1)
    p = c[i] + tan[i] * (s - cum[i])[:, None]
    if offset:
        normal = np.stack([tan[i][:, 1], -tan[i][:, 0]], axis=1)  # right of travel
        side = np.where(np.arange(len(s)) % 2 == 1, -1.0, 1.0) if stagger else np.ones(len(s))
        p = p + normal * (offset * side)[:, None]
    return p


def sample_roads(roads, step=10.0):
    """Sample points every `step` metres along each road. roads: list of dicts with 'xy' (n, 2), 'cls'.

    Returns (points (m, 2), road index per point, metres represented by each point)."""
    pts, idx, wts = [], [], []
    for k, r in enumerate(roads):
        c, cum, tan, total = densify(r["xy"], step)
        if total <= 0:
            continue
        s = np.arange(step / 2, total, step) if total > step else np.array([total / 2])
        i = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(tan) - 1)
        pts.append(c[i] + tan[i] * (s - cum[i])[:, None])
        idx.append(np.full(len(s), k))
        wts.append(np.full(len(s), total / len(s)))
    if not pts:
        return np.zeros((0, 2)), np.zeros(0, dtype=int), np.zeros(0)
    return np.vstack(pts), np.concatenate(idx), np.concatenate(wts)


def grid_index(xy, grid):
    """Column and row of each point on a grid {x0, y0, cell, nx, ny}; -1 outside."""
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    c = np.floor((xy[:, 0] - grid["x0"]) / grid["cell"]).astype(int)
    r = np.floor((xy[:, 1] - grid["y0"]) / grid["cell"]).astype(int)
    out = (c < 0) | (r < 0) | (c >= grid["nx"]) | (r >= grid["ny"])
    c[out], r[out] = -1, -1
    return c, r


def urban_mask(points, weights, classes, grid, threshold_km_per_km2):
    """Cells whose street density (local, collector and major roads), averaged over the 3 x 3 cells around
    them, reaches the threshold: the built-up area."""
    dens = np.zeros((grid["ny"], grid["nx"]))
    sel = np.isin(classes, SURFACE_CLASSES)
    c, r = grid_index(points[sel], grid)
    ok = c >= 0
    np.add.at(dens, (r[ok], c[ok]), weights[sel][ok] / 1000.0)
    dens /= (grid["cell"] / 1000.0) ** 2
    pad = np.pad(dens, 1)
    smooth = sum(pad[dy:dy + grid["ny"], dx:dx + grid["nx"]] for dy in range(3) for dx in range(3)) / 9
    return smooth >= threshold_km_per_km2


def merge_heads(xy, radius=5.0):
    """One point per pole: lamps within `radius` of an earlier one are dropped."""
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    keep = np.ones(len(xy), dtype=bool)
    for i, j in sorted(cKDTree(xy).query_pairs(radius)):
        if keep[i]:
            keep[j] = False
    return xy[keep]


def median_nn(xy):
    """Median distance from each lamp to its nearest neighbour."""
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    if len(xy) < 2:
        return float("nan")
    d, _ = cKDTree(xy).query(xy, k=2)
    return float(np.median(d[:, 1]))


def place_rule(roads, eligible_road, params, avoid_xy, avoid_radius, seed):
    """Rule lamps along roads.

    roads: list of {'id', 'xy', 'cls'}; eligible_road: bool per road (the part of it in a rule area; a road is
    taken whole); params: {cls: {'spacing', 'litFraction', 'offset', 'stagger'}}; avoid_xy: lamps already
    there (inventory, OSM): a rule lamp within avoid_radius of one is not placed.
    A road is lit when stable_hash(seed, road id) < litFraction of its class, so the choice is repeatable.
    Returns (xy (n, 2), class of the road per lamp)."""
    out, cls = [], []
    for r, ok in zip(roads, eligible_road):
        p = params.get(r["cls"])
        if not ok or not p or p["spacing"] <= 0:
            continue
        if r.get("lit") == "no":
            continue
        if r.get("lit") != "yes" and stable_hash(seed, "lit", r["id"]) >= p["litFraction"]:
            continue
        start = p["spacing"] * (0.25 + 0.5 * stable_hash(seed, "start", r["id"]))
        pts = points_along(r["xy"], p["spacing"], start, p.get("offset", 0.0), p.get("stagger", False))
        out.append(pts)
        cls += [r["cls"]] * len(pts)
    if not out:
        return np.zeros((0, 2)), np.array([], dtype=object)
    xy = np.vstack(out)
    cls = np.array(cls, dtype=object)
    # where two lit roads meet, keep one of the lamps that land on top of each other
    keep = np.ones(len(xy), dtype=bool)
    for i, j in sorted(cKDTree(xy).query_pairs(p_min_gap(params))):
        if keep[i] and keep[j]:
            keep[j] = False
    xy, cls = xy[keep], cls[keep]
    if avoid_xy is not None and len(avoid_xy) and len(xy):
        d, _ = cKDTree(np.asarray(avoid_xy)).query(xy, k=1, distance_upper_bound=avoid_radius)
        keep = ~np.isfinite(d)
        xy, cls = xy[keep], cls[keep]
    return xy, cls


def p_min_gap(params):
    return 0.4 * min(p["spacing"] for p in params.values() if p["spacing"] > 0)


# ---------------------------------------------------------------- outputs
def cell_sums(xy, flux, cls, grid):
    """Lumens per cell by class: {class: (ny, nx) float64}, plus the lumens of lamps outside the grid."""
    out = {k: np.zeros((grid["ny"], grid["nx"])) for k in CLASSES}
    c, r = grid_index(xy, grid)
    inside = c >= 0
    for k in CLASSES:
        sel = inside & (np.asarray(cls) == k)
        np.add.at(out[k], (r[sel], c[sel]), np.asarray(flux, dtype=float)[sel])
    return out, float(np.asarray(flux, dtype=float)[~inside].sum())


def encode_lamps(xy, mount_m, type_ids, flags, flux_lm, aim_deg):
    rec = np.zeros(len(xy), dtype=LAMP_DTYPE)
    xy = np.asarray(xy, dtype=float).reshape(-1, 2)
    rec["x_mm"] = np.round(xy[:, 0] * 1000)
    rec["y_mm"] = np.round(xy[:, 1] * 1000)
    rec["mount_dm"] = np.clip(np.round(np.asarray(mount_m) * 10), 0, 65535)
    rec["type"] = type_ids
    rec["flags"] = flags
    rec["flux_10lm"] = np.clip(np.round(np.asarray(flux_lm) / 10), 0, 65535)
    aim = np.asarray(aim_deg, dtype=float)
    rec["aim_cdeg"] = np.where(np.isfinite(aim), np.round(np.mod(aim, 360) * 100) % 36000, AIM_UNKNOWN)
    return rec
