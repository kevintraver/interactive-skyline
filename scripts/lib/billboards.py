"""Billboards beside the drive's roads (plan 02, D7.4): records from three sources, merged, placed and faced.

Pure functions; scripts/build_billboards.py reads the files and writes the product. tests/data/test_billboards.py
tests them on fixtures.

    recs = osm_records(overpass_json, to_local) + clv_records(geojson, to_local) + clark_records(geojson, to_local)
    boards, groups = dedupe(recs)                 # one board per structure, merged across sources
    index = RoadIndex(roads)                      # every road of the three RoadNets (main lines, ramps, streets)
    placed, report = place(boards, index, routes) # facing, size, height, clearance from the pavement

A record: {"src": "osm" | "clv" | "clark", "id", "x", "y" (map metres), "width", "height" (panel, m, or None),
"overall" (structure height, m, or None), "digital" (True / False / None), "sides" (1 / 2 / None),
"facing" (azimuth of the face's normal, radians counter-clockwise from east, or None), "along" (azimuth of the panel's
line, for a mapped way, or None), "status"}.
"""
import math
import re

import numpy as np

from .heights import ground_of

FT = 0.3048
# a standard bulletin (14 x 48 ft) and a 30-sheet poster (10.5 x 22.8 ft viewing area)
BULLETIN = (48 * FT, 14 * FT)
POSTER = (22.8 * FT, 10.5 * FT)
# panel bottom above the ground when no structure height is given (m): a freeway bulletin's 25 ft, a poster's 12 ft
BOTTOM = {"bulletin": 25 * FT, "poster": 12 * FT}
# structures closer than this are one (m): Nevada and Clark County space off-premise signs 300 to 750 ft apart
# along a freeway, and a V or back-to-back structure is often mapped once per face
MERGE_M = 30.0
# half-angle of a V structure between its faces and the road's normal... (degrees): each face turns this far from
# facing straight back along the traffic toward the road
V_HALF_DEG = 20.0
# a single face turns this far toward the road from facing straight back along the traffic (degrees)
TOE_DEG = 15.0
# share of the boards without a tag that are digital (ASSUMED: Clark County's digital conversions are a minority)
DIGITAL_SHARE = 0.15
# share of the boards without a tag that have two faces (ASSUMED: most freeway structures serve both directions)
TWO_SIDED_SHARE = 0.6
# clearance (m) of the pole and of every point of the panels' footprints from any road's pavement edge
POLE_CLEAR = 6.0
PANEL_CLEAR = 2.0
MAX_SHIFT = 45.0
SOURCE_RANK = {"clv": 0, "osm": 1, "clark": 2}  # whose position and size win in a merge


def fnv1a(text):
    """32-bit FNV-1a of a string: the stable hash behind every rule-made choice (and the runtime seed)."""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def _num(v):
    if v is None:
        return None
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(ft|')?", str(v))
    if not m:
        return None
    x = float(m.group(1))
    return x * FT if m.group(2) else x


def _yes(v):
    return str(v).strip().lower() in ("yes", "true", "1")


def osm_records(doc, to_local):
    """Billboards from an Overpass answer (out geom): nodes, and ways whose line gives the panel's orientation."""
    out = []
    for e in doc.get("elements", []):
        t = e.get("tags") or {}
        kind = t.get("advertising") or ("billboard" if t.get("man_made") == "advertising" else None)
        if kind not in ("billboard", "board", "screen", "yes"):
            continue
        if t.get("support") in ("wall_mounted", "wall", "roof", "building"):
            continue  # on a building, not a structure of its own
        along = None
        if e["type"] == "node":
            lat, lon = e["lat"], e["lon"]
        elif e.get("geometry"):
            g = e["geometry"]
            xs, ys = to_local(np.array([p["lat"] for p in g]), np.array([p["lon"] for p in g]))
            x, y = float(np.mean(xs)), float(np.mean(ys))
            if len(g) >= 2:
                along = math.atan2(float(ys[-1] - ys[0]), float(xs[-1] - xs[0]))
            out.append(_osm_rec(e, t, kind, x, y, along))
            continue
        elif e.get("center"):
            lat, lon = e["center"]["lat"], e["center"]["lon"]
        else:
            continue
        x, y = to_local(lat, lon)
        out.append(_osm_rec(e, t, kind, float(x), float(y), along))
    return out


def _osm_rec(e, t, kind, x, y, along):
    facing = None
    d = t.get("direction")
    if d is not None:
        try:
            facing = math.radians(90.0 - float(d))  # a compass bearing the face looks toward
        except ValueError:
            facing = None
    digital = True if kind == "screen" or _yes(t.get("animated")) or t.get("display") in ("digital", "led", "screen") else None
    sides = int(t["sides"]) if str(t.get("sides", "")).isdigit() else None
    return {"src": "osm", "id": f"{e['type'][0]}{e['id']}", "x": x, "y": y, "width": _num(t.get("width")),
            "height": None, "overall": _num(t.get("height")), "digital": digital, "sides": sides,
            "facing": facing, "along": along, "status": "existing"}


_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*$")
_DIGITAL = re.compile(r"\b(DIGITAL|LED|ELECTRONIC|EMC)\b", re.I)


def clv_records(doc, to_local):
    """The City of Las Vegas billboard permits (points with SIZE_ 'h x w' in feet and SIGN_HEIGH, overall, in feet)."""
    out = []
    for f in doc.get("features", []):
        g, p = f.get("geometry"), f.get("properties") or {}
        if not g or g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        x, y = to_local(lat, lon)
        size = p.get("SIZE_") or p.get("SIZE") or ""
        w = h = None
        m = _SIZE.match(str(size))
        if m:
            a, b = float(m.group(1)) * FT, float(m.group(2)) * FT
            h, w = min(a, b), max(a, b)
        elif p.get("SIGN_AREA"):
            area = float(p["SIGN_AREA"]) * FT * FT
            if area > 0:
                h = math.sqrt(area / (48 / 14))
                w = area / h
        overall = float(p["SIGN_HEIGH"]) * FT if p.get("SIGN_HEIGH") else None
        notes = " ".join(str(p.get(k) or "") for k in ("NOTES", "NOTES_SUP", "NOTES_VAR", "NOTES_RQR"))
        out.append({"src": "clv", "id": f"clv{p.get('OBJECTID')}", "x": float(x), "y": float(y), "width": w, "height": h,
                    "overall": overall or None, "digital": True if _DIGITAL.search(notes) else None, "sides": None,
                    "facing": None, "along": None, "status": "existing"})
    return out


def clark_records(doc, to_local):
    """Clark County's billboard points; only those whose CATEGORY is EXISTING stand."""
    out = []
    for f in doc.get("features", []):
        g, p = f.get("geometry"), f.get("properties") or {}
        if not g or g.get("type") != "Point":
            continue
        status = str(p.get("CATEGORY") or "").strip().lower()
        lon, lat = g["coordinates"][:2]
        x, y = to_local(lat, lon)
        out.append({"src": "clark", "id": f"clark{p.get('BILLBOARDS') or p.get('OBJECTID') or p.get('FID')}", "x": float(x),
                    "y": float(y), "width": None, "height": None, "overall": None, "digital": None, "sides": None,
                    "facing": None, "along": None, "status": status or "unknown"})
    return out


def dedupe(recs, merge_m=MERGE_M):
    """Merge records closer than merge_m (single linkage) into one board each. Returns (boards, groups): a board has
    the position and size of its best-ranked source (City, then OSM, then County), the facing and panel line of any
    OSM member, digital if any member says so, and `sources` listing every member."""
    n = len(recs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    if n:
        xy = np.array([[r["x"], r["y"]] for r in recs])
        order = np.argsort(xy[:, 0])
        for a_i in range(n):
            a = order[a_i]
            for b_i in range(a_i + 1, n):
                b = order[b_i]
                if xy[b, 0] - xy[a, 0] > merge_m:
                    break
                if math.hypot(*(xy[a] - xy[b])) <= merge_m:
                    parent[find(a)] = find(b)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(recs[i])
    boards = []
    for members in groups.values():
        members.sort(key=lambda r: (SOURCE_RANK[r["src"]], r["id"]))
        best = dict(members[0])
        for r in members[1:]:
            for k in ("width", "height", "overall", "facing", "along", "sides"):
                if best.get(k) is None and r.get(k) is not None:
                    best[k] = r[k]
            if r.get("digital"):
                best["digital"] = True
        # two records of one source a few metres apart: a structure mapped once per face
        if best.get("sides") is None and len({r["src"] for r in members}) < len(members):
            same = [r for r in members if r["src"] == members[0]["src"]]
            if len(same) >= 2:
                best["sides"] = 2
        best["sources"] = sorted({r["src"] for r in members})
        best["members"] = [r["id"] for r in members]
        boards.append(best)
    boards.sort(key=lambda b: b["id"])
    return boards, list(groups.values())


class RoadIndex:
    """Every station of every road with its pavement edges, for nearest-road queries (scipy cKDTree)."""

    def __init__(self, roads, edges_fn, step=8.0):
        from scipy.spatial import cKDTree
        xs, ys, hd, left, right, kind, rid, h = [], [], [], [], [], [], [], []
        for k, r in enumerate(roads):
            every = max(1, int(round(step / r["spacing"])))
            idx = np.arange(0, r["count"], every)
            s = idx * r["spacing"]
            le, ri = edges_fn(r, s)
            xs.append(r["x"][idx]); ys.append(r["y"][idx]); hd.append(r["heading"][idx])
            left.append(le); right.append(ri); h.append(r["h"][idx])
            kind.append(np.full(len(idx), 0 if r["id"].endswith((".main", ".opp")) else 1))
            rid.append(np.full(len(idx), k))
        self.x, self.y, self.heading = np.concatenate(xs), np.concatenate(ys), np.concatenate(hd)
        self.left, self.right = np.concatenate(left), np.concatenate(right)
        self.kind, self.road, self.h = np.concatenate(kind), np.concatenate(rid), np.concatenate(h)
        self.tree = cKDTree(np.column_stack([self.x, self.y]))
        self.step = step

    def clearance(self, px, py, radius=80.0):
        """Smallest clearance (m) from any road's pavement at a point: negative inside the pavement."""
        best = math.inf
        for i in self.tree.query_ball_point([px, py], radius):
            fx, fy = math.cos(self.heading[i]), math.sin(self.heading[i])
            dx, dy = px - self.x[i], py - self.y[i]
            along = dx * fx + dy * fy
            if abs(along) > self.step * 0.75:
                continue
            lat = -dx * fy + dy * fx  # positive to the left
            c = max(lat - self.left[i], self.right[i] - lat)
            best = min(best, c)
        return best

    def nearest_main(self, px, py, radius=300.0):
        """The nearest station of a main carriageway (main or opp line) within radius, or None."""
        d, i = self.tree.query([px, py], k=64, distance_upper_bound=radius)
        for dd, ii in zip(np.atleast_1d(d), np.atleast_1d(i)):
            if np.isfinite(dd) and self.kind[ii] == 0:
                return int(ii)
        cand = [j for j in self.tree.query_ball_point([px, py], radius) if self.kind[j] == 0]
        if not cand:
            return None
        return min(cand, key=lambda j: (self.x[j] - px) ** 2 + (self.y[j] - py) ** 2)


def panels(board):
    """The faces of a placed board as (centre x, y, normal azimuth, along azimuth), the same geometry as
    src/drive/roadside/billboards.js panelsOf(): one face centred on the pole, or two in a V whose apex is toward
    the road and whose faces each turn V_HALF_DEG from the road's normal, the pole at their middle."""
    w = board["w"]
    if board["sides"] == 1:
        a = board["facing"]
        return [(board["x"], board["y"], a, a - math.pi / 2)]
    a1, a2 = board["facing"], board["facing2"]
    n1 = (math.cos(a1), math.sin(a1))
    n2 = (math.cos(a2), math.sin(a2))
    # each panel runs from the apex away from the other face's normal: along = perpendicular to its normal,
    # pointing against the sum of the two normals (the apex is on the side the faces look toward)
    sx, sy = n1[0] + n2[0], n1[1] + n2[1]
    out = []
    pts = []
    for (nx, ny), a in ((n1, a1), (n2, a2)):
        ux, uy = -ny, nx
        if ux * sx + uy * sy > 0:
            ux, uy = -ux, -uy
        pts.append((ux, uy, a))
    mx = sum(p[0] for p in pts) / 2 * w / 2
    my = sum(p[1] for p in pts) / 2 * w / 2
    for ux, uy, a in pts:
        cx = board["x"] - mx + ux * w / 2
        cy = board["y"] - my + uy * w / 2
        out.append((cx, cy, a, math.atan2(uy, ux)))
    return out


def footprint(board, step=2.0):
    """Points along every panel's line on the ground (for clearance)."""
    pts = []
    for cx, cy, _a, al in panels(board):
        ux, uy = math.cos(al), math.sin(al)
        k = max(2, int(board["w"] / step))
        for j in range(k + 1):
            t = -board["w"] / 2 + board["w"] * j / k
            pts.append((cx + ux * t, cy + uy * t))
    return pts


def _facings(index, i, x, y, sides, facing, along):
    """Facing of face 1 (and 2) toward approaching traffic on the nearest carriageway, unless the source gave one."""
    fx, fy = math.cos(index.heading[i]), math.sin(index.heading[i])
    lat = -(x - index.x[i]) * fy + (y - index.y[i]) * fx
    side = 1.0 if lat >= 0 else -1.0
    ux, uy = side * fy, -side * fx  # from the board toward the road
    back = math.atan2(-fy, -fx)
    road = math.atan2(uy, ux)

    def turn(a0, toward, deg):
        d = math.atan2(math.sin(toward - a0), math.cos(toward - a0))
        return a0 + math.copysign(math.radians(deg), d)

    if facing is None and along is not None:
        # a mapped panel line: its normal on the side that sees more of the approaching traffic
        c1, c2 = along + math.pi / 2, along - math.pi / 2
        score = lambda a: math.cos(a - back) + 0.5 * math.cos(a - road)  # noqa: E731
        facing = c1 if score(c1) >= score(c2) else c2
    if sides == 1:
        return (facing if facing is not None else turn(back, road, TOE_DEG)), None
    fwd = math.atan2(fy, fx)
    if facing is not None:
        # the second face mirrors the first about the road's normal
        f2 = 2 * road - facing
        return facing, f2
    return turn(back, road, 90 - (90 - V_HALF_DEG)), turn(fwd, road, V_HALF_DEG)


def place(boards, index, route_index, heights=None, route_m=300.0):
    """Size, facing, height and clearance for every board within route_m of a route's main lines.
    route_index: a RoadIndex of the routes' main and opposite carriageways only. heights: lib.heights, or None.
    Returns (placed, report)."""
    placed, dropped, moved, far = [], [], 0, 0
    for b in boards:
        if b.get("status") not in ("existing",):
            dropped.append((b["id"], f"status {b.get('status')}"))
            continue
        i = route_index.nearest_main(b["x"], b["y"], route_m)
        if i is None:
            far += 1
            continue
        seed = fnv1a(b["id"])
        if b.get("width") and b.get("height"):
            w, h = float(b["width"]), float(b["height"])
            if w < h:
                w, h = h, w
        else:
            w, h = BULLETIN
        kind = "bulletin" if w >= 11 else "poster"
        sides = b.get("sides") or (2 if (seed >> 8) % 1000 < TWO_SIDED_SHARE * 1000 else 1)
        digital = b.get("digital")
        if digital is None:
            digital = (seed >> 20) % 1000 < DIGITAL_SHARE * 1000
        f1, f2 = _facings(route_index, i, b["x"], b["y"], sides, b.get("facing"), b.get("along"))
        bottom = BOTTOM[kind]
        if b.get("overall") and b["overall"] > h + 2:
            bottom = b["overall"] - h
        rec = {"id": b["id"], "x": b["x"], "y": b["y"], "w": w, "h": h, "bottom": bottom, "sides": sides,
               "facing": f1, "facing2": f2, "digital": bool(digital), "seed": seed, "kind": kind,
               "sources": b.get("sources", [b["src"]]), "shift": 0.0}
        ok = _clear(rec, index)
        if not ok:
            ok = _push(rec, index)
            if ok:
                moved += 1
        if not ok:
            dropped.append((b["id"], "on or over a pavement and no clear spot within reach"))
            continue
        if heights is not None:
            # stand above a raised road beside it: the panel's bottom at least 4.5 m over the nearest road
            j = route_index.nearest_main(rec["x"], rec["y"], 80.0)
            if j is not None:
                g = float(ground_of(heights)(rec["x"], rec["y"]))
                rec["bottom"] = max(rec["bottom"], min(20.0, float(route_index.h[j]) - g + 4.5))
        placed.append(rec)
    report = {"placed": len(placed), "moved": moved, "dropped": [{"id": i, "why": w} for i, w in dropped],
              "beyond_route_m": far}
    return placed, report


def _clear(rec, index):
    if index.clearance(rec["x"], rec["y"]) < POLE_CLEAR:
        return False
    return all(index.clearance(px, py) >= PANEL_CLEAR for px, py in footprint(rec))


def _push(rec, index):
    """Move a board straight away from the nearest road, a metre at a time, until it is clear (at most MAX_SHIFT)."""
    i = index.tree.query([rec["x"], rec["y"]])[1]
    fx, fy = math.cos(index.heading[i]), math.sin(index.heading[i])
    lat = -(rec["x"] - index.x[i]) * fy + (rec["y"] - index.y[i]) * fx
    side = 1.0 if lat >= 0 else -1.0
    ox, oy = -side * fy, side * fx  # away from the road
    x0, y0 = rec["x"], rec["y"]
    for k in range(1, int(MAX_SHIFT) + 1):
        rec["x"], rec["y"] = x0 + ox * k, y0 + oy * k
        if _clear(rec, index):
            rec["shift"] = float(k)
            return True
    rec["x"], rec["y"] = x0, y0
    return False


def encode(placed):
    """The runtime rows: [x, y, facing deg, facing2 deg or null, w, h, bottom, digital, sides, seed, sources mask]."""
    mask = {"osm": 1, "clv": 2, "clark": 4}
    rows = []
    for r in sorted(placed, key=lambda r: (round(r["x"]), round(r["y"]))):
        rows.append([round(r["x"], 1), round(r["y"], 1), round(math.degrees(r["facing"]) % 360, 1),
                     None if r["facing2"] is None else round(math.degrees(r["facing2"]) % 360, 1),
                     round(r["w"], 2), round(r["h"], 2), round(r["bottom"], 2), 1 if r["digital"] else 0, r["sides"],
                     r["seed"], sum(mask[s] for s in r["sources"])])
    return rows
