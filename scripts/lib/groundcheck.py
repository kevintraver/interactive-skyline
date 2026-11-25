"""Does everything the drive draws meet the ground the drive draws?

The ground on screen is a set of triangle meshes (lib.ground.drawn_surface: two triangles per grid
cell, every grid and patch the drive draws, the highest one wherever two overlap). This walks a
route's RoadNet and everything placed along it and measures, against that surface:

- pavement: lanes and shoulders of every road (main lines, opposite carriageways, ramps, crossings),
  wherever drawn ground comes up above them;
- embankments: on each side of every row that is not a deck, whether the fixed embankment the mesher
  draws (mesher.js: EMBANKMENT, squeezed by embScales) reaches the drawn ground, or hangs in the air;
- road ends: a ramp's or crossing's first and last row against the ground under it;
- structures: piers and abutments, whether their feet reach the ground and their tops stay above it;
- signs (posts, overhead columns), delineators, walls (signs*.json, barriers*.json);
- billboards, lamp poles and the roadside buildings, as the runtime stands them (by a height function
  passed in: the drive's own `ground`, so the check measures what is drawn);
- the dam patch's water sheets: their shores against the ground.

Every measure is a signed gap in metres: positive `hang` is air under something, positive `buried`
is ground over something that should be seen. Each kind reports how many items are over its
tolerance and the worst ones with their chainage.

    from lib.groundcheck import check_route
    rep = check_route("lv", "i15n", hs, ground)      # ground(x, y): metres above sea level, drawn
"""
import json
from pathlib import Path

import numpy as np

from .crosssection import normalise_sections, pavement_edges
from .refline import Refline
from .roadnet import decode_roadnet

ROOT = Path(__file__).resolve().parents[2]

EMBANKMENT = ((24.0, 6.0), (20.0, 40.0))  # mesher.js EMBANKMENT
EMB_W = EMBANKMENT[0][0] + EMBANKMENT[1][0]
FOLD = 0.8  # mesher.js
WALL = 4.0  # mesher.js: an embankment squeezed under this is a concrete wall

# tolerances (metres)
TOL = {
    "pavement": 0.01,  # drawn ground never above the pavement or the shoulders (1 cm: between the profile's samples)
    "embankment": 0.25,  # an embankment's toe that ends this far above the ground hangs
    "road_end": 1.5,  # a ramp's or crossing's open end this far above the ground hangs
    "pier": 0.25, "abutment": 0.25,
    "sign": 0.25, "column": 0.25, "delineator": 0.15, "wall": 0.25,
    "billboard": 0.15, "pole": 0.15, "building": 0.15,
}


def emb_drop(e):
    (w1, d1), (w2, d2) = EMBANKMENT
    e = np.maximum(0.0, e)
    return np.where(e <= w1, e * d1 / w1, d1 + (np.minimum(e, w1 + w2) - w1) * d2 / w2)


def load_route(city, route, root=ROOT):
    """(routes.json entry, decoded roads, roadnet doc, signs doc, barriers doc) of one route."""
    folder = Path(root) / "public" / "data" / city
    routes = json.loads((folder / "routes.json").read_text())
    entry = next(r for r in routes["routes"] if r["id"] == route)
    rn = entry["files"]["roadnet"]
    doc = json.loads((folder / rn).read_text())
    roads = decode_roadnet(doc, (folder / rn.replace(".json", ".bin")).read_bytes())
    signs = json.loads((folder / entry["files"]["signs"]).read_text())
    bname = "barriers.json" if rn == "roadnet.json" else f"barriers-{route}.json"
    barriers = json.loads((folder / bname).read_text()) if (folder / bname).exists() else {"roads": []}
    return entry, roads, doc, signs, barriers


class Road:
    """A decoded road with what the checks ask of it: the reference line, pavement edges, the
    embankment's reach on each side (mesher.js embScales), decks."""

    def __init__(self, r):
        self.r = r
        self.id = r["id"]
        self.line = Refline(r)
        self.secs = normalise_sections(r["sections"])
        self.length = self.line.length
        self.decks = [(b["s0"], b["s1"]) for b in r.get("bridges", []) if b.get("deck")]
        self.emb = r.get("embankment", [])

    def edges(self, s):
        return pavement_edges(self.secs, np.atleast_1d(np.asarray(s, dtype=np.float64)))

    def on_deck(self, s):
        s = np.asarray(s, dtype=np.float64)
        m = np.zeros(s.shape, dtype=bool)
        for a, b in self.decks:
            m |= (s >= a) & (s <= b)  # a row at a deck's end is the deck's (mesher.js: a span's mode is its middle's)
        return m

    def room(self, s, side):
        s = np.asarray(s, dtype=np.float64)
        w = np.full(s.shape, EMB_W)
        for e in self.emb:
            if e["side"] == side:
                w = np.where((s >= e["s0"]) & (s <= e["s1"]), np.minimum(w, e["w"]), w)
        return w

    def scales(self, s, p, L, R):
        """embScales: the share of its width the embankment keeps on the left and the right."""
        k = p["curvature"]
        inner = np.where(np.abs(k) > 1e-9, FOLD / np.maximum(np.abs(k), 1e-12), np.inf)
        sl = np.where(k > 0, np.clip((inner - L) / EMB_W, 0.05, 1), 1.0)
        sr = np.where(k < 0, np.clip((inner + R) / EMB_W, 0.05, 1), 1.0)
        if self.emb:
            sl = np.minimum(sl, self.room(s, "left") / EMB_W)
            sr = np.minimum(sr, self.room(s, "right") / EMB_W)
        return sl, sr

    def point(self, p, d):
        """Map (x, y) at lateral offsets d (positive left) from the reference line points p."""
        hd = p["heading"]
        return p["x"] - np.sin(hd) * d, p["y"] + np.cos(hd) * d

    def emb_surface(self, s, side, lateral):
        """Height of the embankment the mesher draws `lateral` metres outside the shoulder edge on
        `side` (scaled as embScales squeezes it), and the edge height. On a deck: the deck's edge
        (no embankment, -inf below it)."""
        s = np.atleast_1d(np.asarray(s, dtype=np.float64))
        p = self.line.at(s)
        L, R = self.edges(s)
        sl, sr = self.scales(s, p, L, R)
        edge = L if side == "left" else R
        sc = sl if side == "left" else sr
        he = p["h"] + p["crossfall"] * edge
        out = np.asarray(lateral, dtype=np.float64) / np.maximum(sc, 1e-6)
        z = np.where(out <= EMB_W * 1.0001, he - emb_drop(out), -np.inf)
        z = np.where(self.on_deck(s), np.where(lateral <= 0, he, -np.inf), z)
        return z, he, sc


def _worst(items, key, n=8):
    items = sorted(items, key=lambda it: -it[key])
    return items[:n]


def _summary(kind, gaps, where, tol, n=8):
    """gaps: array of signed gaps (positive = wrong); where: list of dicts of the same length."""
    gaps = np.asarray(gaps, dtype=np.float64)
    bad = np.nonzero(gaps > tol)[0]
    worst = sorted(bad, key=lambda i: -gaps[i])[:n]
    return {"kind": kind, "count": int(len(gaps)), "wrong": int(len(bad)), "tol_m": tol,
            "max_m": round(float(gaps.max()), 2) if len(gaps) else None,
            "worst": [{**where[i], "m": round(float(gaps[i]), 2)} for i in worst]}


def check_pavement(road, ground, along=2.0, across=0.5):
    """Drawn ground above the pavement (lanes and shoulders, crossfall included): per row, the
    largest (ground - surface). Returns (gap per row, s per row)."""
    s = np.arange(0, road.length + 1e-9, along)
    out = np.empty(len(s))
    for c in range(0, len(s), 3000):
        ss = s[c:c + 3000]
        p = road.line.at(ss)
        le, ri = road.edges(ss)
        k = int(np.ceil((le - ri).max() / across)) + 1
        d = ri[:, None] + (le - ri)[:, None] * np.linspace(0, 1, k)[None, :]
        px, py = road.point({kk: v[:, None] for kk, v in p.items()}, d)
        ph = p["h"][:, None] + p["crossfall"][:, None] * d
        out[c:c + 3000] = (ground(px, py) - ph).max(axis=1)
    return out, s


def check_embankment(road, ground, along=4.0, n_out=45):
    """Per row and side (not on a deck): how far the drawn embankment stays above the ground over
    its whole width (> 0: it never meets the ground, its toe hangs). Returns (gap, s, side, height
    of the edge above the ground at the toe)."""
    s = np.arange(0, road.length + 1e-9, along)
    s = s[~road.on_deck(s)]
    gaps, sides, ss_all = [], [], []
    if not len(s):
        return np.array([]), np.array([]), []
    p = road.line.at(s)
    L, R = road.edges(s)
    sl, sr = road.scales(s, p, L, R)
    o = np.linspace(0, 1, n_out)
    for side, edge, sc, sg in (("left", L, sl, 1.0), ("right", R, sr, -1.0)):
        he = p["h"] + p["crossfall"] * edge
        out = o[None, :] * EMB_W  # unscaled distance along the embankment's profile
        lat = edge[:, None] + sg * out * sc[:, None]
        px, py = road.point({k: v[:, None] for k, v in p.items()}, lat)
        z = he[:, None] - emb_drop(out)
        g = ground(px, py)
        gaps.append((z - g).min(axis=1))
        sides += [side] * len(s)
        ss_all.append(s)
    return np.concatenate(gaps), np.concatenate(ss_all), sides


def meets_road(roads, road, x, y, h, tol=1.0):
    """Whether map (x, y) at height h lies on another road's pavement (within 1 m of its edges, in plan, and `tol`
    metres of its surface): a road end that carries on into another road, not an open end."""
    for other in roads.values():
        if other is road:
            continue
        r = other.r
        d2 = (r["x"] - x) ** 2 + (r["y"] - y) ** 2
        i = int(np.argmin(d2))
        if d2[i] > 60.0 ** 2:
            continue
        s = np.clip(i * r["spacing"] + np.arange(-8, 9) * 1.0, 0, other.length)
        p = other.line.at(s)
        hd = p["heading"]
        along = (x - p["x"]) * np.cos(hd) + (y - p["y"]) * np.sin(hd)
        k = int(np.argmin(np.abs(along)))
        lat = -(x - p["x"][k]) * np.sin(hd[k]) + (y - p["y"][k]) * np.cos(hd[k])
        le, ri = other.edges(s[k:k + 1])
        if ri[0] - 1.0 <= lat <= le[0] + 1.0 and abs(p["h"][k] + p["crossfall"][k] * lat - h) < tol:
            return True
    return False


def check_ends(road, ground, roads=None, joined=()):
    """A ramp's or crossing's two ends: the pavement's centre above the ground (> 0 hangs) where no
    other road carries on from it (a `connect` junction over that end, or meets_road). Returns [(gap, s)]."""
    out = []
    for s in (0.0, road.length):
        if any(a - 1.0 <= s <= b + 1.0 for a, b in joined):
            continue
        p = road.line.at(np.array([s]))
        le, ri = road.edges(np.array([s]))
        d = np.linspace(ri[0], le[0], 9)
        px, py = road.point({k: v for k, v in p.items()}, d)
        ph = p["h"] + p["crossfall"] * d
        # carried on: some of its end row lies on another road's pavement, at that road's height
        if roads is not None and any(meets_road(roads, road, float(a), float(b), float(c)) for a, b, c in zip(px, py, ph)):
            continue
        out.append((float((ph - ground(px, py)).min()), s))
    return out


def check_structures(doc, roads, ground):
    """Piers: their foot (h0) over the lowest ground of the footprint hangs; ground over their top
    (h1) buries them. Abutments: the toe (h0 at s + dir * len) over the ground there."""
    hang_p, where_p, bur_p, hang_a, where_a = [], [], [], [], []
    for st in doc.get("structures", []):
        road = roads.get(st["road"])
        if road is None:
            continue
        p = road.line.at(np.array([float(st["s"])]))
        hd = float(p["heading"][0])
        tx, ty, nx, ny = np.cos(hd), np.sin(hd), -np.sin(hd), np.cos(hd)
        cx = float(p["x"][0]) + nx * st["d"]
        cy = float(p["y"][0]) + ny * st["d"]
        if st["kind"] == "pier":
            a = np.linspace(-st["t"] / 2, st["t"] / 2, 3)
            c = np.linspace(-st["w"] / 2, st["w"] / 2, 9)
            A, C = np.meshgrid(a, c)
            g = ground(cx + A * tx + C * nx, cy + A * ty + C * ny)
            hang_p.append(st["h0"] - g.min())
            bur_p.append(g.max() - st["h1"])
            where_p.append({"road": st["road"], "s": st["s"], "d": st["d"]})
        elif st["kind"] == "abutment":
            c = np.linspace(-st["w"] / 2, st["w"] / 2, 9)
            L = st["dir"] * st["len"]
            g = ground(cx + L * tx + c * nx, cy + L * ty + c * ny)
            hang_a.append(st["h0"] - g.min())
            where_a.append({"road": st["road"], "s": st["s"], "d": st["d"]})
    return (_summary("pier_foot", hang_p, where_p, TOL["pier"]),
            _summary("pier_buried", bur_p, where_p, TOL["pier"]),
            _summary("abutment_toe", hang_a, where_a, TOL["abutment"]))


def _support(road, ground, s, side, lateral):
    """What a post `lateral` metres outside the edge stands on: the higher of the drawn ground and
    the drawn embankment. Returns (support height, edge height, ground, embankment)."""
    z, he, _ = road.emb_surface(s, side, lateral)
    p = road.line.at(np.atleast_1d(s))
    L, R = road.edges(np.atleast_1d(s))
    edge = L if side == "left" else R
    sg = 1.0 if side == "left" else -1.0
    x, y = road.point(p, edge + sg * lateral)
    g = ground(x, y)
    return np.maximum(g, z), he, g, z


SIGN_BURY = 0.8  # geometry.js BURY
COLUMN_BURY = 0.8  # structures.js COLUMN.bury


def check_signs(signs, roads, ground):
    """Ground-mounted signs: each post's foot as the runtime stands it (geometry.js standY: BURY below the higher of
    the embankment the mesher draws there and the drawn ground) against what is there (> 0: the post stands in the
    air); the panel's bottom against the ground under it (> 0: buried). Overhead structures: each column's foot."""
    hang, where, bur, wb, col, wc = [], [], [], [], [], []
    for sr in signs.get("roads", []):
        road = roads.get(sr["id"])
        if road is None:
            continue
        for k, rec in enumerate(sr.get("signs", [])):
            if rec.get("over"):
                continue
            s = float(np.clip(rec["s"], 0, road.length))
            side = rec["side"]
            lats = [rec["offset"] + rec["w"] / 2] if rec["w"] < 2.0 else [rec["offset"] + rec["w"] * 0.2, rec["offset"] + rec["w"] * 0.8]
            for lat in lats:
                sup, he, g, z = _support(road, ground, s, side, lat)
                foot = sup - SIGN_BURY  # geometry.js standY: down to the higher of the drawn embankment and ground
                hang.append(float(foot[0] - sup[0]))
                where.append({"road": road.id, "s": round(s, 1), "kind": rec["kind"], "side": side})
                bur.append(float(g[0] - (he[0] + rec["mount"])))
                wb.append({"road": road.id, "s": round(s, 1), "kind": rec["kind"], "side": side})
        for stc in sr.get("structures", []):
            s = float(np.clip(stc["s"], 0, road.length))
            L, R = road.edges(np.array([s]))
            for d in stc.get("cols", []):
                if d < R[0] or d > L[0]:
                    side = "right" if d < R[0] else "left"
                    lat = R[0] - d if side == "right" else d - L[0]
                    sup, he, g, z = _support(road, ground, s, side, lat)
                    foot = sup - COLUMN_BURY  # structures.js, through standY
                else:  # in the median or on the pavement: on the pavement's height there
                    p = road.line.at(np.array([s]))
                    x, y = road.point(p, d)
                    sup = ground(x, y)
                    foot = np.minimum(p["h"] + p["crossfall"] * d, sup) - COLUMN_BURY
                col.append(float(foot[0] - sup[0]))
                wc.append({"road": road.id, "s": round(s, 1), "kind": stc["kind"], "d": d})
    return (_summary("sign_post", hang, where, TOL["sign"]), _summary("sign_buried", bur, wb, TOL["sign"]),
            _summary("sign_column", col, wc, TOL["column"]))


def check_barriers(barriers, roads, ground):
    """Delineators (base on the embankment surface at their offset, unscaled, as delineators.js
    stands them) and walls (base at z relative to the edge) against what is there."""
    hang, where, bur, wb, wall, ww = [], [], [], [], [], []
    for br in barriers.get("roads", []):
        road = roads.get(br["id"])
        if road is None:
            continue
        for side_i, _colour, o, ss in br.get("delineators", []):
            side = ("left", "right")[side_i]
            ss = np.clip(np.asarray(ss, dtype=np.float64), 0, road.length)
            if not len(ss):
                continue
            sup, he, g, z = _support(road, ground, ss, side, o)
            base = sup  # delineators.js, through standY
            hang += list(base - sup)
            bur += list(g - (base + 1.15))
            where += [{"road": road.id, "s": round(float(v), 1), "side": side} for v in ss]
        for run in br.get("runs", []):
            if len(run) < 11:
                continue
            s0, s1, side_i, _t, o0, o1, _p, _e, _h, z0, z1 = run
            side = ("left", "right")[side_i]
            ss = np.linspace(s0, s1, max(2, int((s1 - s0) / 4) + 1))
            o = np.interp(ss, [s0, s1], [o0, o1])
            zr = np.interp(ss, [s0, s1], [z0, z1])
            for v, oo, zz in zip(ss, o, zr):
                sup, he, g, z = _support(road, ground, np.array([v]), side, max(0.0, oo))
                wall.append(float(he[0] + zz - sup[0]))
                ww.append({"road": road.id, "s": round(float(v), 1), "side": side})
    return (_summary("delineator_hang", hang, where, TOL["delineator"]),
            _summary("delineator_buried", bur, where, TOL["delineator"]),
            _summary("wall_base", wall, ww, TOL["wall"]))


def near_route(x, y, roads, reach):
    """Mask of points within `reach` metres (in plan) of any road's reference line."""
    from scipy.spatial import cKDTree
    pts = np.concatenate([np.column_stack([r.r["x"], r.r["y"]]) for r in roads.values()])
    d, _ = cKDTree(pts).query(np.column_stack([x, y]))
    return d < reach


def chainage_of(x, y, main):
    from scipy.spatial import cKDTree
    _, i = cKDTree(np.column_stack([main.r["x"], main.r["y"]])).query(np.column_stack([x, y]))
    return i * main.r["spacing"]


def check_billboards(city, roads, main, ground, placed, root=ROOT, reach=1500.0):
    """Billboard poles: the runtime stands each at placed(x, y) (its base height function); against
    the lowest drawn ground around the pole (> 0 hangs) and the highest (> 0.5 m + tol buries)."""
    doc = json.loads((Path(root) / "public" / "data" / city / "billboards.json").read_text())
    f = {k: i for i, k in enumerate(doc["fields"])}
    b = np.array([[r[f["x"]], r[f["y"]]] for r in doc["boards"]])
    m = near_route(b[:, 0], b[:, 1], roads, reach)
    b = b[m]
    base = placed(b[:, 0], b[:, 1])
    ring = [(0, 0)] + [(0.6 * np.cos(a), 0.6 * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)]
    g = np.stack([ground(b[:, 0] + dx, b[:, 1] + dy) for dx, dy in ring])
    s = chainage_of(b[:, 0], b[:, 1], main)
    where = [{"s": round(float(v), 0), "x": round(float(x), 1), "y": round(float(y), 1)} for v, (x, y) in zip(s, b)]
    return (_summary("billboard_hang", base - g.min(axis=0), where, TOL["billboard"]),
            _summary("billboard_buried", g.max(axis=0) - base - 0.5, where, TOL["billboard"]))


def read_lamps(city, root=ROOT):
    folder = Path(root) / "public" / "data" / city
    meta = json.loads((folder / "lamps-drive.json").read_text())
    blob = (folder / meta["file"]).read_bytes()
    arrs = {}
    for a in meta["arrays"]:
        arrs[a["name"]] = np.frombuffer(blob, dtype={"uint32": "<u4", "uint16": "<u2", "uint8": "u1"}[a["type"]],
                                        count=a["length"], offset=a["offset"])
    cs = arrs["cellStart"].astype(np.int64)
    n = int(meta["count"])
    cell = np.repeat(np.arange(len(cs) - 1), np.diff(cs))
    x = meta["x0"] + (cell % meta["nx"]) * meta["cell"] + arrs["qx"][:n] / meta["q"]
    y = meta["y0"] + (cell // meta["nx"]) * meta["cell"] + arrs["qy"][:n] / meta["q"]
    lift = arrs["lift"][:n] / meta["mountQ"] if "lift" in arrs else np.zeros(n)
    mount = arrs["mount"][:n] / meta["mountQ"]
    enclosed = (arrs["kind"][:n] & meta["bits"]["enclosed"]) > 0
    return x, y, lift, mount, enclosed


def check_poles(city, roads, main, ground, placed, root=ROOT, reach=60.0):
    """Lamp poles near the route's roads (the runtime draws poles within 60 m of a road): the foot
    (placed(x, y) - 0.3, poles.js) on the ground (> 0 hangs), and poles beside a road that rides
    well above the ground standing at ground level (their head below the pavement beside them)."""
    x, y, lift, mount, enclosed = read_lamps(city, root)
    m = ~enclosed & near_route(x, y, roads, reach) & (lift == 0)
    x, y, mount = x[m], y[m], mount[m]
    ring = [(0, 0)] + [(0.3 * np.cos(a), 0.3 * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)]
    g = np.stack([ground(x + dx, y + dy) for dx, dy in ring]).min(axis=0)
    base = placed(x, y) - 0.3
    s = chainage_of(x, y, main)
    where = [{"s": round(float(v), 0), "x": round(float(a), 1), "y": round(float(b), 1)} for v, a, b in zip(s, x, y)]
    return _summary("pole_hang", base - g, where, TOL["pole"])


def check_buildings(city, roads, main, ground, placed, root=ROOT, reach=3000.0):
    """Roadside buildings: the runtime stands each from min(placed) - 1 m over its outline's points and the middles of
    its sides (corridor/mesher.js groundUnder, SINK); against the lowest drawn ground along the outline, at its points,
    the sides' middles and quarters (> 0 hangs)."""
    from .corridor_format import decode_cell
    folder = Path(root) / "public" / "data" / city / "corridor"
    index = json.loads((folder / "index.json").read_text())
    cells = index.get("cells") or []
    files = [c["file"] if isinstance(c, dict) else c for c in cells] if cells else sorted(p.name for p in folder.glob("*.bin"))
    rings = []
    for fname in files:
        cell = decode_cell((folder / fname).read_bytes())
        rings += [np.asarray(b["rings"][0], dtype=np.float64) for b in cell["buildings"] if b["rings"] and len(b["rings"][0])]
    cen = np.array([r.mean(axis=0) for r in rings])
    keep = near_route(cen[:, 0], cen[:, 1], roads, reach)
    rings, cen = [r for r, k in zip(rings, keep) if k], cen[keep]
    s = chainage_of(cen[:, 0], cen[:, 1], main)
    hang, where = [], []
    for ring, (cx, cy), sv in zip(rings, cen, s):
        # the outline's points and the middles of its sides
        nxt = np.roll(ring, -1, axis=0)
        pts = np.concatenate([ring, (ring + nxt) / 2])
        edge = np.concatenate([pts, 0.75 * ring + 0.25 * nxt, 0.25 * ring + 0.75 * nxt])
        bottom = placed(pts[:, 0], pts[:, 1]).min() - 1.0  # corridor/mesher.js groundUnder: points and sides' middles
        hang.append(bottom - ground(edge[:, 0], edge[:, 1]).min())
        where.append({"s": round(float(sv), 0), "x": round(float(cx), 1), "y": round(float(cy), 1)})
    return _summary("building_hang", hang, where, TOL["building"])


def check_water(city, ground, root=ROOT):
    """The dam patch's water sheets: the level against the ground along each shore. Positive: the
    sheet's edge stands above the ground there (it hangs as a ledge), worst per body."""
    folder = Path(root) / "public" / "data" / city
    meta = json.loads((folder / "terrain.json").read_text())
    out = []
    for pid, p in (meta.get("patches") or {}).items():
        if not p.get("water"):
            continue
        doc = json.loads((folder / p["water"]).read_text())
        for body in doc["bodies"]:
            for ring in body["rings"][:1]:
                r = np.asarray(ring, dtype=np.float64)
                seg = np.linspace(0, 1, 5, endpoint=False)
                a, b = r, np.roll(r, -1, axis=0)
                pts = (a[:, None, :] * (1 - seg[None, :, None]) + b[:, None, :] * seg[None, :, None]).reshape(-1, 2)
                g = ground(pts[:, 0], pts[:, 1])
                lvl = body["level"]
                out.append({"patch": pid, "body": body.get("name"), "level": lvl,
                            "edge_above_ground_p95_m": round(float(np.percentile(lvl - g, 95)), 1),
                            "edge_above_ground_max_m": round(float((lvl - g).max()), 1)})
    return out


def check_route(city, route, ground, placed=None, root=ROOT, everything=True):
    """Every check of one route. ground: the drawn surface (metres above sea level); placed: the
    height function the runtime stands billboards, poles and buildings on (default: ground)."""
    placed = placed or ground
    entry, decoded, doc, signs, barriers = load_route(city, route, root)
    roads = {r["id"]: Road(r) for r in decoded}
    main = next(r for r in roads.values() if r.r.get("role", "main") == "main" and r.id.startswith(route))
    # where a road meets another end to side (a ramp at a crossing road): its (s0, s1) on that road
    joined = {}
    for j in doc.get("junctions", []):
        if j["kind"] == "connect":
            for side in ("a", "b"):
                joined.setdefault(j[side]["road"], []).append((j[side]["s0"], j[side]["s1"]))
    rep = {"route": route, "kinds": {}}
    K = rep["kinds"]
    # pavement and embankments, per role
    for role in ("main", "ramp", "crossing"):
        pav_g, pav_w, emb_g, emb_w, end_g, end_w = [], [], [], [], [], []
        for r in roads.values():
            if r.r.get("role", "main") != role:
                continue
            g, s = check_pavement(r, ground)
            pav_g.append(g)
            pav_w += [{"road": r.id, "s": round(float(v), 1)} for v in s]
            eg, es, sides = check_embankment(r, ground)
            emb_g.append(eg)
            emb_w += [{"road": r.id, "s": round(float(v), 1), "side": sd} for v, sd in zip(es, sides)]
            if role != "main":
                for gap, s_end in check_ends(r, ground, roads, joined.get(r.id, [])):
                    end_g.append(gap)
                    end_w.append({"road": r.id, "s": round(s_end, 1)})
        if pav_g:
            K[f"pavement_{role}"] = _summary(f"pavement_{role}", np.concatenate(pav_g), pav_w, TOL["pavement"])
            K[f"embankment_{role}"] = _summary(f"embankment_{role}", np.concatenate(emb_g), emb_w, TOL["embankment"])
        if end_g:
            K[f"end_{role}"] = _summary(f"end_{role}", end_g, end_w, TOL["road_end"])
    for s in check_structures(doc, roads, ground):
        K[s["kind"]] = s
    if everything:
        for s in check_signs(signs, roads, ground):
            K[s["kind"]] = s
        for s in check_barriers(barriers, roads, ground):
            K[s["kind"]] = s
        for s in check_billboards(city, roads, main, ground, placed, root):
            K[s["kind"]] = s
        K["pole_hang"] = check_poles(city, roads, main, ground, placed, root)
        K["building_hang"] = check_buildings(city, roads, main, ground, placed, root)
    return rep
