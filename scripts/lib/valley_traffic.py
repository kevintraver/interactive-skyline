"""Traffic on the rest of the valley (plan 02, D6.6): the stages of build_valley_traffic.py as pure
functions, so tests run them on small fixtures without the network.

    ways     = osm_ways(osm_doc, frame)                  # OSM ways in map metres, with their road keys
    stations = trina_points(trina_doc, frame, year)      # TRINA mainline stations, with their road keys
    shapes   = make_shapes(tmas_stations, means, w)      # hour-of-week shapes of continuous stations
    result   = build(ways, stations, shapes, driven, bounds)
    doc, blob = encode(result, meta)                     # valley.json + valley.bin

Format: public/data/<city>/traffic/valley.json + valley.bin (the reader is
src/drive/traffic/valleyFormat.js; change both together).

valley.json = {
  "version": 1, "city", "year", "tz",            hours below are local in tz
  "quantum": 2,                                    metres per coordinate unit in the bin
  "hourOfWeek": "index = 24 * day + hour, day 0 = Monday, local time",
  "classes": ["motorway", "trunk", "primary", "secondary"],
  "shapes": [{ "id", "station", "dir", "kind", "location", "values": [168] }],
      values: share of a mean day's volume in each hour of the week: sum(values) / 7 = 1, so the
      flow in hour h of a road of daily volume Q is Q * values[h] vehicles per hour
  "names": ["Flamingo Rd", ...],                   road names, by index
  "stations": [{ "id", "aadt", "location" }],      the TRINA stations pieces took their volume from
  "vertices": V, "pieces": P,
  "bin": { "coords": [offset, bytes], "pieces": [offset, bytes], "pieceBytes": 20 },
  "sources": [...]
}
valley.bin, little-endian:
  coords   Int16 x 2V: x, y of every vertex in quantum units (map metres east, north / quantum)
  pieces   P records of 20 bytes:
             u32 first vertex, u16 vertex count, u8 class, u8 flags (1 one-way, 2 volume assumed),
             u8 lanes per direction, u8 speed km/h, u16 forward daily volume / 10,
             u16 backward daily volume / 10 (0 on a one-way piece), u8 forward shape, u8 backward shape,
             u16 station index (65535: none), u16 name index (65535: none)
  Forward is the order of the vertices; on a one-way piece it is the direction of travel.
"""
import math
import re

import numpy as np

CLASSES = ["motorway", "trunk", "primary", "secondary"]
QUANTUM = 2.0
PIECE_BYTES = 20
PIECE_DTYPE = np.dtype([("start", "<u4"), ("n", "<u2"), ("cls", "u1"), ("flags", "u1"), ("lanes", "u1"), ("kmh", "u1"),
                        ("fwd", "<u2"), ("bwd", "<u2"), ("sf", "u1"), ("sb", "u1"), ("st", "<u2"), ("name", "<u2")])
PIECE_M = 3000.0          # pieces are at most this long, so volumes can change along a road
SIMPLIFY_M = 6.0          # Douglas-Peucker tolerance
DENSIFY_M = 20.0          # spacing for the cut against the driven routes
DRIVEN_NEAR_M = 45.0      # a way point this close to a driven carriageway ...
DRIVEN_PARALLEL = math.cos(math.radians(30))  # ... and this parallel to it is that carriageway
MIN_RUN_M = 150.0         # shorter runs left after the cut are dropped
STATION_SNAP_M = 80.0     # a station sits on a way of its road within this distance
STATION_SNAP_ANY_M = 25.0  # ... or on the nearest way of any name within this (names that disagree)
STATION_REACH_M = {"motorway": 15000.0, "trunk": 15000.0, "primary": 5000.0, "secondary": 3000.0}  # a piece
# takes a station of its road within this distance (freeway volumes change slowly between interchanges)
CLASS_DEFAULT_AADT = {"motorway": 60000, "trunk": 25000, "primary": 22000, "secondary": 10000}  # two-way, assumed
CLASS_DEFAULT_LANES = {"motorway": 3, "trunk": 2, "primary": 3, "secondary": 2}  # per direction, assumed
CLASS_DEFAULT_MPH = {"motorway": 65, "trunk": 55, "primary": 45, "secondary": 40}  # assumed
FREEWAY_FSYSTEM = {"1", "2", "11", "12"}  # TMAS functional systems that are freeways
NOT_MAINLINE = re.compile(r"ramp|fly ?over|connector|hov|frontage|\bto\b|\bfrom\b|intch to", re.I)
TMAS_DIRS = {1: 0.0, 3: 90.0, 5: 180.0, 7: 270.0}  # TMAS direction -> compass heading of travel
MPH = 0.44704

SUFFIX = {"boulevard": "blvd", "road": "rd", "avenue": "ave", "av": "ave", "street": "st", "drive": "dr",
          "parkway": "pkwy", "lane": "ln", "highway": "hwy", "freeway": "fwy", "expressway": "expy",
          "way": "way", "circle": "cir", "court": "ct", "place": "pl", "trail": "trl"}
DIRECTIONAL = {"n", "s", "e", "w", "north", "south", "east", "west", "nb", "sb", "eb", "wb"}
REF_PREFIX = {"I": "IR", "US": "US", "SR": "SR", "NV": "SR", "CC": "CC", "CR": "CC"}


# ---------------------------------------------------------------- road keys

def name_key(name):
    """'East Lake Mead Boulevard North' -> 'lake mead blvd'; 'Saint Rose Parkway' -> 'st rose pkwy'."""
    if not name:
        return None
    words = re.sub(r"[^a-z0-9 ]", " ", name.lower()).split()
    words = [SUFFIX.get(w, w) for w in words]
    while words and words[0] in DIRECTIONAL:
        words = words[1:]
    while words and words[-1] in DIRECTIONAL:
        words = words[:-1]
    if words and words[0] == "saint":
        words[0] = "st"
    words = ["luther" if w == "l" else w for w in words]  # 'Martin L King' and 'Martin Luther King'
    return " ".join(words) or None


def osm_ref_keys(ref):
    """'I 15;US 93' -> {'IR15', 'US93'}; 'CC 215' -> {'CC215'}; 'US 95 Business' -> {} (another road)."""
    out = set()
    for part in (ref or "").split(";"):
        m = re.fullmatch(r"([A-Z]+)[ -]?(\d+)[NSEW]?", part.strip())  # not 'US 95 Business'

        if m and m.group(1) in REF_PREFIX:
            out.add(REF_PREFIX[m.group(1)] + m.group(2))
    return out


def trina_keys(route_name):
    """TRINA ROUTE_NAME -> road keys: 'SR159 (Charleston Blvd)' -> {'SR159', 'charleston blvd'};
    'IR515, US95' -> {'IR515', 'US95'}; 'Flamingo Rd' -> {'flamingo rd'}."""
    keys = set()
    s = (route_name or "").strip().rstrip(".")
    for part in re.split(r"[,()]", s):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(IR|US|SR|CC|CL)\s?(\d+)[NSEW]?", part)
        if m:
            keys.add(("CC" if m.group(1) == "CL" else m.group(1)) + m.group(2))
        else:
            k = name_key(part)
            if k:
                keys.add(k)
    return keys


def is_ref(key):
    return bool(re.fullmatch(r"(IR|US|SR|CC)\d+", key))


def way_keys(tags):
    keys = set()
    for k in ("ref", "unsigned_ref"):  # not old_ref: an old route number now runs elsewhere
        keys |= osm_ref_keys(tags.get(k))
    for k in ("name", "alt_name", "official_name", "old_name"):
        for v in (tags.get(k) or "").split(";"):
            nk = name_key(v)
            if nk:
                keys.add(nk)
    return keys


def parse_mph(v):
    if not v:
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?", str(v))
    if not m:
        return None
    x = float(m.group(1))
    return x if (m.group(2) or "mph") == "mph" else x / 1.609344


def parse_int(v):
    try:
        return int(str(v).split(";")[0])
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- inputs

def osm_ways(doc, frame):
    """OSM ways -> list of {id, cls, oneway, lanes (per direction), mph, name, keys, xy (N, 2)}."""
    nodes = {}
    for el in doc["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
    ways = []
    for el in doc["elements"]:
        if el["type"] != "way":
            continue
        t = el.get("tags", {})
        cls = t.get("highway")
        if cls not in CLASSES:
            continue
        ids = [n for n in el["nodes"] if n in nodes]
        if len(ids) < 2:
            continue
        ow = t.get("oneway", "no")
        if cls == "motorway" and ow not in ("no", "-1"):
            ow = "yes"  # motorways are one-way unless tagged otherwise
        if ow == "-1":
            ids = ids[::-1]
        lat = np.array([nodes[n][0] for n in ids])
        lon = np.array([nodes[n][1] for n in ids])
        x, y = frame.to_local(lat, lon)
        oneway = ow in ("yes", "-1", "true", "1")
        lanes = parse_int(t.get("lanes"))
        if lanes is not None and not oneway:
            lanes = max(1, math.ceil(lanes / 2))
        ways.append({"id": el["id"], "cls": cls, "oneway": oneway,
                     "lanes": lanes or CLASS_DEFAULT_LANES[cls], "lanesAssumed": lanes is None,
                     "mph": parse_mph(t.get("maxspeed")) or CLASS_DEFAULT_MPH[cls],
                     "name": t.get("name") or t.get("ref") or "", "keys": way_keys(t),
                     "xy": np.column_stack([np.asarray(x, float), np.asarray(y, float)])})
    return ways


def trina_points(doc, frame, year):
    """TRINA stations on main lines with an AADT: {id, keys, aadt, x, y, type, location}."""
    out = []
    for f in doc["features"]:
        a = f["attributes"]
        aadt = a.get(f"AADT_{year}")
        if aadt is None or aadt <= 0 or a.get("LAT_DECIMAL") is None:
            continue
        loc = (a.get("LOCATION_D") or "").strip()
        if NOT_MAINLINE.search(loc) or NOT_MAINLINE.search(a.get("ROUTE_NAME") or ""):
            continue
        x, y = frame.to_local(a["LAT_DECIMAL"], a["LON_DECIMAL"])
        out.append({"id": a["Name"], "keys": trina_keys(a.get("ROUTE_NAME")), "route": (a.get("ROUTE_NAME") or "").strip(),
                    "aadt": float(aadt), "x": float(x), "y": float(y), "type": a.get("StationType"), "location": loc})
    return out


def make_shapes(stations, means, weights, min_seasons=2):
    """Shapes of continuous stations: `stations` maps (tmas id, dir) -> {x, y, f_system, location};
    `means` is lib.traffic.hour_of_week_means. A shape is the season-weighted mean week over the
    seasons the station counted (at least min_seasons), scaled so that sum / 7 = 1."""
    shapes = []
    for key in sorted(stations):
        m = means.get(key)
        if m is None:
            continue
        cov = [s for s in range(4) if m["covered"][s]]
        if len(cov) < min_seasons:
            continue
        w = np.array([weights[s] for s in cov])
        week = np.sum(w[:, None] * m["flow"][cov], axis=0) / w.sum()
        if not np.all(np.isfinite(week)) or week.sum() <= 0:
            continue
        st = stations[key]
        shapes.append({"station": "0" + key[0], "dir": int(key[1]),
                       "kind": "freeway" if st["f_system"] in FREEWAY_FSYSTEM else "arterial",
                       "x": st["x"], "y": st["y"], "location": st["location"],
                       "meanDay": float(week.sum() / 7), "values": week / (week.sum() / 7)})
    for i, s in enumerate(shapes):
        s["id"] = i
    return shapes


# ---------------------------------------------------------------- geometry

def densify(xy, step):
    seg = np.hypot(*np.diff(xy, axis=0).T)
    out = [xy[:1]]
    for i, L in enumerate(seg):
        n = max(1, int(math.ceil(L / step)))
        t = np.arange(1, n + 1)[:, None] / n
        out.append(xy[i] + t * (xy[i + 1] - xy[i]))
    return np.vstack(out)


def headings(xy):
    """Unit direction at each point (central differences)."""
    d = np.gradient(xy, axis=0)
    n = np.hypot(d[:, 0], d[:, 1])
    n[n == 0] = 1
    return d / n[:, None]


def simplify(xy, tol):
    """Douglas-Peucker, iterative; keeps the end points."""
    if len(xy) <= 2:
        return xy
    keep = np.zeros(len(xy), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = xy[a], xy[b]
        d = q - p
        L = math.hypot(*d)
        seg = xy[a + 1:b] - p
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L > 0 else np.hypot(seg[:, 0], seg[:, 1])
        i = int(np.argmax(dist))
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return xy[keep]


def length_of(xy):
    return float(np.sum(np.hypot(*np.diff(xy, axis=0).T)))


class Grid:
    """A uniform hash grid over points, for 'which points are near' without scipy."""

    def __init__(self, pts, cell):
        self.pts, self.cell = pts, cell
        self.cells = {}
        ij = np.floor(pts / cell).astype(np.int64)
        for k, (i, j) in enumerate(ij):
            self.cells.setdefault((int(i), int(j)), []).append(k)

    def near(self, p, r):
        i0, j0 = int(math.floor((p[0] - r) / self.cell)), int(math.floor((p[1] - r) / self.cell))
        i1, j1 = int(math.floor((p[0] + r) / self.cell)), int(math.floor((p[1] + r) / self.cell))
        out = []
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                out += self.cells.get((i, j), [])
        if not out:
            return np.zeros(0, np.int64), np.zeros(0)
        idx = np.array(out)
        d = np.hypot(self.pts[idx, 0] - p[0], self.pts[idx, 1] - p[1])
        sel = d <= r
        return idx[sel], d[sel]


def driven_mask(xy, driven_grid, driven_dir):
    """True where a densified way point lies on a driven carriageway (near and parallel)."""
    h = headings(xy)
    out = np.zeros(len(xy), bool)
    for k, p in enumerate(xy):
        idx, _ = driven_grid.near(p, DRIVEN_NEAR_M)
        if len(idx) and np.max(np.abs(driven_dir[idx] @ h[k])) >= DRIVEN_PARALLEL:
            out[k] = True
    return out


def runs(mask):
    """[start, end) of the runs of False in mask."""
    out, a = [], None
    for i, m in enumerate(mask):
        if not m and a is None:
            a = i
        elif m and a is not None:
            out.append((a, i))
            a = None
    if a is not None:
        out.append((a, len(mask)))
    return out


def split_pieces(xy, max_len):
    """Cut a polyline into pieces of at most max_len (of nearly equal length)."""
    L = length_of(xy)
    n = max(1, int(math.ceil(L / max_len)))
    if n == 1:
        return [xy]
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    out = []
    for k in range(n):
        a, b = L * k / n, L * (k + 1) / n
        inside = (cum > a) & (cum < b)
        pa = np.array([np.interp(a, cum, xy[:, 0]), np.interp(a, cum, xy[:, 1])])
        pb = np.array([np.interp(b, cum, xy[:, 0]), np.interp(b, cum, xy[:, 1])])
        out.append(np.vstack([pa, xy[inside], pb]))
    return out


# ---------------------------------------------------------------- chains

def chain_ways(ways):
    """Join ways that are one road (class, one-way-ness and name) where exactly two of them meet
    end to end; two-way ways may be turned round to join, one-way ways only join end to start.
    Returns chains as lists of (way index, reversed)."""
    def sig(w):
        return (w["cls"], w["oneway"], name_key(w["name"]) or f"#{w['id']}")

    def key(p):
        return (round(float(p[0]), 1), round(float(p[1]), 1))

    groups = {}
    for i, w in enumerate(ways):
        groups.setdefault((sig(w), key(w["xy"][0])), []).append((i, 0))
        groups.setdefault((sig(w), key(w["xy"][-1])), []).append((i, 1))
    link = {}
    for (sg, _), ends in groups.items():
        if len(ends) != 2 or ends[0][0] == ends[1][0]:
            continue
        (i, e), (j, f) = ends
        if sg[1] and e == f:
            continue  # one-way: an end must meet a start
        link[(i, e)], link[(j, f)] = (j, f), (i, e)
    chains, seen = [], set()

    def walk(i, rev):
        c = []
        while True:
            seen.add(i)
            c.append((i, rev))
            nxt = link.get((i, 0 if rev else 1))
            if nxt is None or nxt[0] in seen:
                return c
            i, rev = nxt[0], nxt[1] == 1

    for i, w in enumerate(ways):
        if i in seen:
            continue
        if (i, 0) not in link:
            chains.append(walk(i, False))
        elif (i, 1) not in link and not w["oneway"]:
            chains.append(walk(i, True))
    for i in range(len(ways)):  # what is left is in loops, or one-way runs entered midway
        if i not in seen:
            # step back to the start of the run (or round the loop once)
            j, rev, back = i, False, set()
            while True:
                back.add(j)
                prv = link.get((j, 1 if rev else 0))
                if prv is None or prv[0] in seen or prv[0] in back:
                    break
                j, rev = prv[0], prv[1] == 0
            chains.append(walk(j, rev))
    return chains


# ---------------------------------------------------------------- stations

def snap_stations(stations, ways):
    """Each station onto a way: the nearest way sharing a road key within STATION_SNAP_M, else the
    nearest way of any name within STATION_SNAP_ANY_M. Returns {station index: (way index, distance)}."""
    pts, owner = [], []
    for i, w in enumerate(ways):
        d = densify(w["xy"], 10.0)
        pts.append(d)
        owner += [i] * len(d)
    pts = np.vstack(pts)
    owner = np.array(owner)
    grid = Grid(pts, 200.0)
    out = {}
    for si, s in enumerate(stations):
        idx, dist = grid.near((s["x"], s["y"]), STATION_SNAP_M)
        best = None
        for k in np.argsort(dist):
            w = ways[owner[idx[k]]]
            if s["keys"] & w["keys"]:
                best = (int(owner[idx[k]]), float(dist[k]))
                break
        # names that disagree: only street counts onto streets, never a freeway count onto a crossing road
        if best is None and len(dist) and dist.min() <= STATION_SNAP_ANY_M and not any(map(is_ref, s["keys"])):
            k = int(np.argmin(dist))
            w = ways[owner[idx[k]]]
            if w["cls"] != "motorway" and not any(map(is_ref, w["keys"])):
                best = (int(owner[idx[k]]), float(dist[k]))
        if best is not None:
            out[si] = best
    return out


def road_ids(ways, chains):
    """A road id per way: ways of one chain, and chains sharing a road key and touching (within
    60 m), get the same id, so a station's reach follows its road and not a crossing street."""
    parent = list(range(len(chains)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    ends, keys = [], []
    for ci, c in enumerate(chains):
        k = set()
        for wi, _ in c:
            k |= ways[wi]["keys"] or {f"#{ways[wi]['id']}"}
        keys.append(k)
        for wi, _ in c:
            for p in (ways[wi]["xy"][0], ways[wi]["xy"][-1]):
                ends.append((p, ci))
    pts = np.array([e[0] for e in ends])
    grid = Grid(pts, 120.0)
    for k, (p, ci) in enumerate(ends):
        idx, _ = grid.near(p, 60.0)
        for j in idx:
            cj = ends[j][1]
            if cj != ci and keys[ci] & keys[cj]:
                a, b = find(ci), find(cj)
                if a != b:
                    parent[a] = b
    rid = {}
    for ci, c in enumerate(chains):
        for wi, _ in c:
            rid[wi] = find(ci)
    return rid


# ---------------------------------------------------------------- the build

def heading_deg(xy):
    d = xy[-1] - xy[0]
    return (math.degrees(math.atan2(d[0], d[1])) + 360) % 360  # compass: 0 north, 90 east


def pick_shape(shapes, kind, heading, p):
    """Nearest shape of the kind whose station direction is closest to the heading of travel
    (on the same axis: north/south or east/west); any direction when none is."""
    def angle(a, b):
        return abs((a - b + 180) % 360 - 180)

    same = [s for s in shapes if s["kind"] == kind] or shapes
    best_dir = min(TMAS_DIRS, key=lambda d: angle(TMAS_DIRS[d], heading))
    cand = [s for s in same if s["dir"] == best_dir] or same
    return min(cand, key=lambda s: (s["x"] - p[0]) ** 2 + (s["y"] - p[1]) ** 2)


def build(ways, stations, shapes, driven, bounds):
    """Pieces with geometry, volumes and shapes. `driven` is a list of {id, xy}; `bounds` is
    (x0, y0, x1, y1) in map metres (pieces are clipped to it by dropping points outside)."""
    if not shapes:
        raise ValueError("no hour-of-week shapes")
    # the cut against the driven carriageways
    if driven:
        dpts = np.vstack([densify(d["xy"], 10.0) for d in driven])
        ddir = np.vstack([headings(densify(d["xy"], 10.0)) for d in driven])
        dgrid = Grid(dpts, 100.0)
    cut_m = {c: 0.0 for c in CLASSES}
    kept = []
    for w in ways:
        xy = densify(w["xy"], DENSIFY_M)
        inside = (xy[:, 0] >= bounds[0]) & (xy[:, 0] <= bounds[2]) & (xy[:, 1] >= bounds[1]) & (xy[:, 1] <= bounds[3])
        mask = ~inside
        if driven:
            dm = driven_mask(xy, dgrid, ddir) & inside
            cut_m[w["cls"]] += float(np.sum(np.hypot(*np.diff(xy, axis=0).T)[dm[1:] & dm[:-1]])) if len(xy) > 1 else 0.0
            mask |= dm
        rs = runs(mask)
        if len(rs) == 1 and rs[0] == (0, len(xy)):
            kept.append(w)
            continue
        for a, b in rs:
            if b - a >= 2 and length_of(xy[a:b]) >= MIN_RUN_M:
                kept.append({**w, "xy": simplify(xy[a:b], 0.5), "cutFromDriven": True})
    snapped = snap_stations(stations, kept)
    chains = chain_ways(kept)
    rid = road_ids(kept, chains)
    on_road = {}
    for si, (wi, d) in snapped.items():
        on_road.setdefault(rid[wi], []).append(si)

    pieces = []
    for c in chains:
        w0 = kept[c[0][0]]
        parts = [kept[i]["xy"][::-1] if r else kept[i]["xy"] for i, r in c]
        xy = np.vstack([parts[0]] + [q[1:] for q in parts[1:]])
        lens = np.array([length_of(q) for q in parts]) + 1e-6
        lanes = int(round(np.average([kept[i]["lanes"] for i, _ in c], weights=lens)))
        mph = float(np.average([kept[i]["mph"] for i, _ in c], weights=lens))
        road = rid[c[0][0]]
        for p in split_pieces(xy, PIECE_M):
            p = simplify(p, SIMPLIFY_M)
            L = length_of(p)
            if L < 1.0:
                continue
            mid = p[len(p) // 2] if len(p) > 2 else (p[0] + p[-1]) / 2
            cand = on_road.get(road, [])
            best = None
            if cand:
                dists = [math.hypot(stations[s]["x"] - mid[0], stations[s]["y"] - mid[1]) for s in cand]
                k = int(np.argmin(dists))
                if dists[k] <= STATION_REACH_M[w0["cls"]]:
                    best = (cand[k], dists[k])
            if w0["cls"] == "secondary" and best is None:
                continue  # secondary roads only where a station counts them
            aadt = stations[best[0]]["aadt"] if best else CLASS_DEFAULT_AADT[w0["cls"]]
            # one-way: this carriageway carries half the two-way count; two-way: half each way
            fwd = aadt / 2
            bwd = 0.0 if w0["oneway"] else aadt / 2
            kind = "freeway" if w0["cls"] == "motorway" else "arterial"
            hd = heading_deg(p)
            sf = pick_shape(shapes, kind, hd, mid)
            sb = pick_shape(shapes, kind, (hd + 180) % 360, mid)
            pieces.append({"xy": p, "cls": w0["cls"], "oneway": w0["oneway"], "lanes": lanes,
                           "mph": mph, "name": w0["name"], "fwd": fwd, "bwd": bwd,
                           "shapeF": sf["id"], "shapeB": sb["id"], "station": best[0] if best else None,
                           "stationDist": best[1] if best else None, "assumed": best is None, "length": L,
                           "road": road, "wayIds": [kept[i]["id"] for i, _ in c]})
    return {"pieces": pieces, "stations": stations, "snapped": snapped, "shapes": shapes, "cutM": cut_m}


# ---------------------------------------------------------------- output

def encode(result, meta):
    pieces, stations, shapes = result["pieces"], result["stations"], result["shapes"]
    used_st = sorted({p["station"] for p in pieces if p["station"] is not None})
    st_index = {s: i for i, s in enumerate(used_st)}
    names = sorted({p["name"] for p in pieces if p["name"]})
    name_index = {n: i for i, n in enumerate(names)}
    coords, recs = [], bytearray()
    v = 0
    for p in pieces:
        q = np.round(p["xy"] / QUANTUM).astype(np.int64)
        # drop vertices that quantise onto their predecessor
        keep = np.concatenate([[True], np.any(q[1:] != q[:-1], axis=1)])
        q = q[keep]
        if len(q) < 2:
            q = np.vstack([q[0], q[0] + [1, 0]])
        if np.any(np.abs(q) > 32767):
            raise ValueError("coordinate out of the Int16 range")
        coords.append(q.astype("<i2"))
        rec = np.zeros(1, dtype=PIECE_DTYPE)
        rec["start"], rec["n"] = v, len(q)
        rec["cls"] = CLASSES.index(p["cls"])
        rec["flags"] = (1 if p["oneway"] else 0) | (2 if p["assumed"] else 0)
        rec["lanes"] = min(255, int(p["lanes"]))
        rec["kmh"] = min(255, int(round(p["mph"] * 1.609344)))
        rec["fwd"] = min(65535, int(round(p["fwd"] / 10)))
        rec["bwd"] = min(65535, int(round(p["bwd"] / 10)))
        rec["sf"], rec["sb"] = p["shapeF"], p["shapeB"]
        rec["st"] = st_index.get(p["station"], 65535)
        rec["name"] = name_index.get(p["name"], 65535)
        assert rec.itemsize == PIECE_BYTES
        recs += rec.tobytes()
        v += len(q)
    cbytes = np.vstack(coords).tobytes()
    doc = {
        "version": 1, **{k: meta[k] for k in ("city", "year", "tz")}, "quantum": QUANTUM,
        "hourOfWeek": "index = 24 * day + hour, day 0 = Monday, local time, hour = the hour that starts then",
        "classes": CLASSES,
        "shapes": [{"id": s["id"], "station": s["station"], "dir": s["dir"], "kind": s["kind"], "location": s["location"],
                    "values": [round(float(x), 5) for x in s["values"]]} for s in shapes],
        "names": names,
        "stations": [{"id": stations[s]["id"], "aadt": stations[s]["aadt"], "location": stations[s]["location"]} for s in used_st],
        "vertices": v, "pieces": len(pieces),
        "bin": {"coords": [0, len(cbytes)], "pieces": [len(cbytes), len(recs)], "pieceBytes": PIECE_BYTES},
        "assumed": {"classDefaultAadt": CLASS_DEFAULT_AADT, "classDefaultLanes": CLASS_DEFAULT_LANES,
                    "classDefaultMph": CLASS_DEFAULT_MPH,
                    "split": "two-way AADT split evenly between the directions (one-way carriageways carry half)"},
        "sources": meta.get("sources", []),
    }
    return doc, cbytes + bytes(recs)


def decode(doc, blob):
    """The pieces back from valley.json + valley.bin (for tests and the report)."""
    c0, cn = doc["bin"]["coords"]
    p0, pn = doc["bin"]["pieces"]
    coords = np.frombuffer(blob[c0:c0 + cn], dtype="<i2").reshape(-1, 2).astype(float) * doc["quantum"]
    recs = np.frombuffer(blob[p0:p0 + pn], dtype=PIECE_DTYPE)
    out = []
    for r in recs:
        out.append({"xy": coords[r["start"]:r["start"] + r["n"]], "cls": doc["classes"][r["cls"]],
                    "oneway": bool(r["flags"] & 1), "assumed": bool(r["flags"] & 2), "lanes": int(r["lanes"]),
                    "kmh": int(r["kmh"]), "fwd": int(r["fwd"]) * 10, "bwd": int(r["bwd"]) * 10,
                    "shapeF": int(r["sf"]), "shapeB": int(r["sb"]),
                    "station": None if r["st"] == 65535 else int(r["st"]),
                    "name": None if r["name"] == 65535 else doc["names"][r["name"]]})
    return out


def report(result, dropped=()):
    pieces = result["pieces"]
    km = {c: round(sum(p["length"] for p in pieces if p["cls"] == c) / 1000, 1) for c in CLASSES}
    km["total"] = round(sum(km.values()), 1)
    by_class = {c: {"pieces": sum(1 for p in pieces if p["cls"] == c),
                    "station": sum(1 for p in pieces if p["cls"] == c and not p["assumed"]),
                    "default": sum(1 for p in pieces if p["cls"] == c and p["assumed"]),
                    "kmStation": round(sum(p["length"] for p in pieces if p["cls"] == c and not p["assumed"]) / 1000, 1),
                    "kmDefault": round(sum(p["length"] for p in pieces if p["cls"] == c and p["assumed"]) / 1000, 1)}
                for c in CLASSES}
    roads = {}
    for p in pieces:
        r = roads.setdefault(p["name"] or "(unnamed)", {"km": 0.0, "vkt": 0.0, "maxTwoWayAadt": 0.0, "cls": p["cls"]})
        r["km"] += p["length"] / 1000
        r["vkt"] += (p["fwd"] + p["bwd"]) * p["length"] / 1000
        r["maxTwoWayAadt"] = max(r["maxTwoWayAadt"], (p["fwd"] + p["bwd"]) * (2 if p["oneway"] else 1))
    busiest = sorted(({"name": k, "cls": v["cls"], "km": round(v["km"], 1), "vehicleKmPerDay": round(v["vkt"]),
                       "maxTwoWayAadt": round(v["maxTwoWayAadt"])} for k, v in roads.items()),
                     key=lambda r: -r["vehicleKmPerDay"])[:25]
    st = result["stations"]
    used = {p["station"] for p in pieces if p["station"] is not None}
    return {
        "km": km, "byClass": by_class,
        "kmCutAsDrivenRoutes": {c: round(v / 1000, 1) for c, v in result["cutM"].items()},
        "stations": {"mainline": len(st), "snappedToARoad": len(result["snapped"]), "usedByAPiece": len(used),
                     "unsnapped": [{"id": s["id"], "route": s["route"], "location": s["location"]}
                                   for i, s in enumerate(st) if i not in result["snapped"]][:60]},
        "shapes": [{"id": s["id"], "station": s["station"], "dir": s["dir"], "kind": s["kind"], "location": s["location"],
                    "meanDay": round(s["meanDay"])} for s in result["shapes"]],
        "busiest": busiest,
        "tmasDaysDropped": len(dropped),
    }
