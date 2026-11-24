"""Roadside barriers for the drive (plan 02, D3.6): OpenStreetMap's `barrier` ways where they are
mapped, rules elsewhere, with the rules' thresholds fitted to the mapped stretches and checked on
a held-out share of them.

Everything here works on stations STEP metres apart along each road and on its two sides. A
barrier's position across the road is `o`, metres OUTWARD from that side's outer shoulder edge
(crosssection edges, tapers included), so a run follows the pavement through every taper.

    from lib.roadside_barriers import RoadGeom, project_osm, mapped_labels, features, fit_rules, place
    geoms = {rid: RoadGeom(road) for rid, road in roads.items()}
    pts = project_osm(osm, frame, geoms, pairs)
    ...

Types: "concrete" (an F-shape safety barrier, 32 in), "guardrail" (W-beam at 31 in on posts),
"wall" (a noise or retaining wall), "cable" (three-cable median barrier). Fences are projected and
counted but not placed (they stand at the right-of-way line, 20-30 m out, and read as nothing).
"""
import math
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

from .crosssection import normalise_sections, pavement_edges
from .refline import Refline
from .heights import ground_of

STEP = 4.0
TYPES = ("concrete", "guardrail", "wall", "cable")
T_CODE = {t: i for i, t in enumerate(TYPES)}
NONE = -1
FENCE = 9  # projected, counted, not placed

# where a barrier stands, metres outward from the shoulder edge (centre of a concrete barrier,
# face of a guardrail's rail)
O_GUARDRAIL = 0.3
O_CONCRETE_EDGE = 0.6  # a concrete barrier at a drop-off or on an outer edge
O_CONCRETE_MEDIAN = (0.45, 1.2)  # median barrier centre: half the clear median, within these bounds
O_WALL_MIN = 1.5
WALL_H = {"noise": 4.0, "retaining": 2.4, "wall": 3.0}
MEDIAN_WALL = 3.5  # a mapped `wall` closer than this to the median edge is the median barrier
MAX_O = 40.0  # mapped ways farther out are not this road's
PARALLEL = 0.85  # |cos| between a way and the road for it to count as running along it
GAP_BRIDGE = 6  # stations: mapped coverage with gaps up to this is one run
MIN_RUN = 5  # stations: shorter mapped runs are dropped, and so are placed runs after cuts
APPROACH = (45.0, 15.0)  # guardrail before / after a bridge's parapets, metres (leading, trailing)
PIER_ZONE = 10.0  # a pier this close outside the shoulder edge gets guardrail in front of it
PIER_RUN = (40.0, 10.0)  # metres before / after the pier
DROP_ROOM = 4.0  # an embankment held to less than this (drawn as a wall) is a drop-off
DROP_H = 1.0  # ... where the road stands at least this high
CLEARANCE = 4.9  # vertical separation that lets a barrier pass under or over another road
GORE_MARGIN = (10.0, 30.0)  # cut a side's barriers this far around a junction on that side
FIT_MIN_POS = 50  # stations of mapped positives a threshold needs before it is fitted
DEFAULT_FILL = 3.0  # m: guardrail where the fill beside the shoulder is higher (when the fit is unsupported)
FIT_MIN_F1 = 0.3  # a fitted threshold that scores worse than this on its own training share is not used
MIN_RULE_RUN = {"concrete": 400.0, "guardrail": 30.0}  # m: shorter rule-only runs (outside bridge and pier rules) are dropped
RULE_GAP = {"concrete": 100.0, "guardrail": 20.0}  # m: rule-only gaps up to this are closed
BLOCK = 1000.0  # m: blocks for the hold-out split
HOLDOUT_EVERY = 4  # every 4th surveyed block is held out


class RoadGeom:
    """A decoded road at its stations: positions, headings, pavement edges and heights."""

    def __init__(self, road):
        self.road = road
        self.id = road["id"]
        self.line = Refline(road)
        self.secs = road.get("_secs") or road.setdefault("_secs", normalise_sections(road["sections"]))
        self.length = self.line.length
        n = int(self.length // STEP) + 1
        self.s = np.arange(n) * STEP
        p = self.line.at(self.s)
        self.x, self.y, self.h, self.hd = p["x"], p["y"], p["h"], p["heading"]
        self.cf, self.k = p["crossfall"], p["curvature"]
        self.left, self.right = pavement_edges(self.secs, self.s)
        self.tree = cKDTree(np.c_[road["x"], road["y"]])
        self.half = float(np.max(np.maximum(np.abs(self.left), np.abs(self.right))))

    def edge(self, side, s=None):
        if s is None:
            return self.left if side == "left" else self.right
        lt, rt = pavement_edges(self.secs, np.atleast_1d(np.asarray(s, dtype=np.float64)))
        return lt if side == "left" else rt

    def point(self, s, side, o):
        """Map (x, y) and pavement edge height of the point `o` outward of `side`'s edge at s (vectorised)."""
        s = np.atleast_1d(np.asarray(s, dtype=np.float64))
        p = self.line.at(s)
        e = self.edge(side, s)
        sgn = 1.0 if side == "left" else -1.0
        d = e + sgn * np.asarray(o, dtype=np.float64)
        x = p["x"] - np.sin(p["heading"]) * d
        y = p["y"] + np.cos(p["heading"]) * d
        return x, y, p["h"] + p["crossfall"] * e

    def locate(self, x, y):
        """(s, lateral d positive left, heading) of map points relative to this road, vectorised."""
        x, y = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)
        _, i = self.tree.query(np.c_[x, y])
        sp = self.road["spacing"]
        hd = np.asarray(self.road["heading"])[i]
        dx, dy = x - np.asarray(self.road["x"])[i], y - np.asarray(self.road["y"])[i]
        s = i * sp + dx * np.cos(hd) + dy * np.sin(hd)
        d = -dx * np.sin(hd) + dy * np.cos(hd)
        return s, d, hd


# ---------------------------------------------------------------- OSM


def osm_type(tags, o):
    """The placed type of a mapped barrier way `o` metres outside the edge, or FENCE, or None."""
    b = tags.get("barrier")
    if b in ("jersey_barrier", "concrete_block"):
        return T_CODE["concrete"]
    if b == "guard_rail":
        return T_CODE["concrete"] if tags.get("material") == "concrete" else T_CODE["guardrail"]
    if b == "cable_barrier":
        return T_CODE["cable"]
    if b in ("wall", "retaining_wall", "city_wall"):
        return T_CODE["concrete"] if o < MEDIAN_WALL else T_CODE["wall"]
    if b == "fence":
        return FENCE
    return None


def wall_height(tags):
    try:
        h = float(str(tags.get("height", "")).split()[0])
        if 0.5 <= h <= 10:
            return h
    except (ValueError, IndexError):
        pass
    if tags.get("wall") == "noise_barrier":
        return WALL_H["noise"]
    return WALL_H["retaining"] if tags.get("barrier") == "retaining_wall" else WALL_H["wall"]


def project_osm(osm, frame, geoms, pairs):
    """Every mapped barrier way, densified every STEP metres and assigned to the road and side whose
    shoulder edge it runs nearest and alongside. `pairs` maps a carriageway id to its opposite: a
    point in the median between the two belongs to the first of the pair (it draws the median).
    Returns {(road, side): list of (s, o, type, way id, wall height)}."""
    out = defaultdict(list)
    ids = list(geoms)
    owner = {b: a for a, b in pairs.items()}  # opposite -> driven
    for wid, w in osm.ways.items():
        if len(w["nodes"]) < 2 or any(n not in osm.nodes for n in w["nodes"]):
            continue
        lat, lon = osm.latlon(w["nodes"])
        x, y = frame.to_local(lat, lon)
        px, py, pa = [], [], []
        for i in range(len(x) - 1):
            seg = math.hypot(x[i + 1] - x[i], y[i + 1] - y[i])
            n = max(1, int(seg / STEP))
            t = np.arange(n) / n
            px.append(x[i] + t * (x[i + 1] - x[i]))
            py.append(y[i] + t * (y[i + 1] - y[i]))
            pa.append(np.full(n, math.atan2(y[i + 1] - y[i], x[i + 1] - x[i])))
        px, py, pa = np.concatenate(px), np.concatenate(py), np.concatenate(pa)
        best = np.full(len(px), np.inf)
        pick = [None] * len(px)
        for rid in ids:
            g = geoms[rid]
            s, d, hd = g.locate(px, py)
            ok = (s >= 0) & (s <= g.length) & (np.abs(np.cos(pa - hd)) > PARALLEL)
            if not ok.any():
                continue
            lt, rt = pavement_edges(g.secs, np.clip(s, 0, g.length))
            left = d > 0
            o = np.where(left, d - lt, rt - d)
            ok &= (o > -1.5) & (o < MAX_O)
            for k in np.nonzero(ok & (o < best))[0]:
                best[k] = o[k]
                pick[k] = (rid, "left" if left[k] else "right", float(s[k]), float(o[k]))
        h = wall_height(w["tags"])
        for k, pk in enumerate(pick):
            if pk is None:
                continue
            rid, side, s, o = pk
            if side == "left" and rid in owner:  # the opposite's median side: the driven road's median
                g = geoms[owner[rid]]
                ss, dd, _ = g.locate(px[k:k + 1], py[k:k + 1])
                lt = g.edge("left", np.clip(ss, 0, g.length))
                if dd[0] > lt[0] - 1.5:
                    rid, side, s, o = owner[rid], "left", float(ss[0]), float(dd[0] - lt[0])
            t = osm_type(w["tags"], o)
            if t is not None:
                out[(rid, side)].append((s, o, t, wid, h))
    return out


def mapped_labels(geom, points):
    """Per station: mapped type (or NONE), its offset and wall height, from projected points. Gaps of up
    to GAP_BRIDGE stations within one type are closed and runs shorter than MIN_RUN dropped."""
    n = len(geom.s)
    lab = np.full(n, NONE)
    off = np.zeros(n)
    hgt = np.zeros(n)
    by_type = defaultdict(lambda: defaultdict(list))
    for s, o, t, _, h in points:
        i = int(round(s / STEP))
        if 0 <= i < n:
            by_type[t][i].append((o, h))
    # placed types first, by priority (a concrete median barrier wins over a guardrail mapped beside it)
    for t in sorted(by_type, key=lambda t: (t == FENCE, [0, 1, 3, 2, 9].index(t) if t in (0, 1, 2, 3, 9) else 9)):
        cov = np.zeros(n, dtype=bool)
        idx = np.array(sorted(by_type[t]))
        cov[idx] = True
        cov = close_gaps(cov, GAP_BRIDGE)
        cov = drop_short(cov, MIN_RUN)
        free = cov & (lab == NONE)
        lab[free] = t
        # offsets: the median of the points nearby, carried across closed gaps
        known = np.full(n, np.nan)
        kh = np.full(n, np.nan)
        for i, v in by_type[t].items():
            known[i] = float(np.median([a for a, _ in v]))
            kh[i] = float(np.max([b for _, b in v]))
        ii = np.nonzero(~np.isnan(known))[0]
        if len(ii):
            off[free] = np.interp(np.nonzero(free)[0], ii, known[ii])
            hgt[free] = np.interp(np.nonzero(free)[0], ii, kh[ii])
    return lab, off, hgt


def close_gaps(mask, gap):
    m = mask.copy()
    idx = np.nonzero(mask)[0]
    for a, b in zip(idx, idx[1:]):
        if 1 < b - a <= gap + 1:
            m[a:b] = True
    return m


def drop_short(mask, n):
    m = mask.copy()
    for a, b in runs_of(mask):
        if b - a < n:
            m[a:b] = False
    return m


def runs_of(mask):
    """[(i0, i1)) of every run of True."""
    d = np.diff(np.r_[0, mask.astype(np.int8), 0])
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


# ---------------------------------------------------------------- features


def median_clear(geom, opp):
    """Metres from the left shoulder edge to the opposite carriageway's pavement, per station (inf without one)."""
    if opp is None:
        return np.full(len(geom.s), np.inf)
    px = geom.x - np.sin(geom.hd) * geom.left
    py = geom.y + np.cos(geom.hd) * geom.left
    s, d, _ = opp.locate(px, py)
    lt, _ = pavement_edges(opp.secs, np.clip(s, 0, opp.length))
    out = d - lt
    out[(s < 0) | (s > opp.length)] = np.inf
    return out


def fill_height(geom, heights, side):
    """How far the pavement edge stands above the ground 3 to 9 m outside it (the highest such drop), per station."""
    e = geom.edge(side)
    sgn = 1.0 if side == "left" else -1.0
    he = geom.h + geom.cf * e
    drops = []
    for o in (3.0, 6.0, 9.0):
        d = e + sgn * o
        g = ground_of(heights)(geom.x - np.sin(geom.hd) * d, geom.y + np.cos(geom.hd) * d)
        drops.append(he - g)
    return np.max(drops, axis=0)


def room(geom, side):
    """How far the drawn embankment may reach on `side`, per station (the road's `embankment` entries)."""
    out = np.full(len(geom.s), 99.0)
    for e in geom.road.get("embankment", []):
        if e["side"] == side:
            m = (geom.s >= e["s0"]) & (geom.s <= e["s1"])
            out[m] = np.minimum(out[m], e["w"])
    return out


def window(geom, ranges):
    m = np.zeros(len(geom.s), dtype=bool)
    for a, b in ranges:
        m |= (geom.s >= a) & (geom.s <= b)
    return m


def parapet_ranges(road):
    return [(b["s0"], b["s1"]) for b in road.get("bridges", []) if not b.get("deck")]


def approach_ranges(road):
    """Guardrail before and after every parapet-bridge, leading end first."""
    return [(b0 - APPROACH[0], b0) for b0, _ in parapet_ranges(road)] + [(b1, b1 + APPROACH[1]) for _, b1 in parapet_ranges(road)]


def pier_ranges(geom, structures, side):
    """Guardrail ranges in front of the piers of other roads standing close outside `side`'s edge,
    with the largest offset that keeps the rail in front of each pier."""
    out = []
    for st in structures:
        if st.get("kind") != "pier" or st["road"] == geom.id:
            continue
        ps = st["_xy"]
        s, d, hd = geom.locate([ps[0]], [ps[1]])
        s, d = float(s[0]), float(d[0])
        if not (0 <= s <= geom.length):
            continue
        lt, rt = pavement_edges(geom.secs, np.array([s]))
        # the pier's near face: half its width across its own road, which crosses ours
        reach = st["w"] / 2 * abs(math.cos(st["_hd"] - float(hd[0]))) + st["t"] / 2
        o = (d - reach - lt[0]) if side == "left" else (rt[0] - d - reach)
        if -0.5 < o < PIER_ZONE and abs(st["_h0"] - geom.h[min(len(geom.h) - 1, int(s / STEP))]) < 12:
            out.append((s - PIER_RUN[0], s + PIER_RUN[1], max(0.0, min(O_GUARDRAIL, o - 0.8))))
    return out


def junction_cuts(geom, junctions, side):
    out = []
    for j in junctions:
        for end in ("a", "b"):
            if j[end]["road"] != geom.id:
                continue
            if end == "a" and j.get("side") not in (side, ""):
                continue
            out.append((j[end]["s0"] - GORE_MARGIN[0], j[end]["s1"] + GORE_MARGIN[1]))
    return out


# ---------------------------------------------------------------- rules and their fit


def f1(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def score(pred, truth):
    tp = int(np.sum(pred & truth))
    fp = int(np.sum(pred & ~truth))
    fn = int(np.sum(~pred & truth))
    p, r, f = f1(tp, fp, fn)
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3), "tp": tp, "fp": fp, "fn": fn,
            "stations": int(len(pred))}


def fit_threshold(x, truth, below=True, candidates=None):
    """The threshold T for the rule `x < T` (below) or `x > T` that maximises F1 on (x, truth).
    Returns (T, score at T); T is None when there are no positives."""
    x = np.asarray(x, dtype=np.float64)
    truth = np.asarray(truth, dtype=bool)
    ok = np.isfinite(x)
    if not truth[ok].any():
        return None, None
    if candidates is None:
        candidates = np.unique(np.round(np.quantile(x[ok], np.linspace(0, 1, 401)), 2))
    best = None
    for t in candidates:
        pred = (x < t) if below else (x > t)
        pred &= ok
        sc = score(pred, truth)
        if best is None or sc["f1"] > best[1]["f1"] + 1e-12:
            best = (float(t), sc)
    return best


def holdout_split(s, surveyed):
    """(train, test) station masks: surveyed BLOCK-metre blocks, every HOLDOUT_EVERY-th held out."""
    blk = (s // BLOCK).astype(int)
    blocks = sorted(set(blk[surveyed].tolist()))
    held = set(blocks[HOLDOUT_EVERY - 1::HOLDOUT_EVERY])
    test = surveyed & np.isin(blk, list(held))
    return surveyed & ~test, test


def surveyed_mask(geom, labs):
    """Stations in BLOCK-metre blocks where OSM maps any barrier or fence on either side of this road."""
    blk = (geom.s // BLOCK).astype(int)
    any_map = np.zeros(len(geom.s), dtype=bool)
    for lab in labs:
        any_map |= lab != NONE
    blocks = set(blk[any_map].tolist())
    return np.isin(blk, list(blocks))


def fit_rules(samples):
    """Fit the rule thresholds on the training share and score them on the held-out share.

    samples: {"median": [(clear, truth, train, test)], "fill": [(height, truth, train, test)]}, one
    entry per road side the rule applies to (arrays per station). Returns the report section."""
    out = {}
    for name, below, default, unit in (("median", True, None, "m of clear median"), ("fill", False, DEFAULT_FILL, "m of fill")):
        rows = samples.get(name, [])
        if not rows:
            out[name] = {"threshold": default, "fitted": False, "why": "no road side the rule applies to"}
            continue
        x = np.concatenate([r[0] for r in rows])
        y = np.concatenate([r[1] for r in rows])
        tr = np.concatenate([r[2] for r in rows])
        te = np.concatenate([r[3] for r in rows])
        pos = int(np.sum(y & tr))
        entry = {"unit": unit, "rule": f"barrier where {'clear median <' if below else 'fill >'} threshold",
                 "positives_train": pos, "stations_train": int(tr.sum()), "positives_test": int(np.sum(y & te)),
                 "stations_test": int(te.sum())}
        if pos < FIT_MIN_POS:
            entry.update({"threshold": default, "fitted": False,
                          "why": f"{pos} mapped stations in the training share (< {FIT_MIN_POS}); design value kept"})
        else:
            t, sc = fit_threshold(x[tr], y[tr], below)
            if sc["f1"] < FIT_MIN_F1:
                entry.update({"threshold": default, "fitted": False, "best_fit": round(t, 2), "train_at_best_fit": sc,
                              "why": f"the best threshold scores F1 {sc['f1']} on the training share (< {FIT_MIN_F1}): "
                                     "the feature does not explain where OSM maps this barrier; design value kept"})
            else:
                entry.update({"threshold": round(t, 2), "fitted": True, "train": sc})
        t = entry["threshold"]
        if t is not None and te.any():
            pred = ((x < t) if below else (x > t)) & np.isfinite(x)
            entry["holdout"] = score(pred[te], y[te])
        out[name] = entry
    return out


# ---------------------------------------------------------------- placement


def rule_labels(geom, side, thr, feats, is_median_owner):
    """Rule types per station for one side (NONE where no rule asks), and their offsets."""
    n = len(geom.s)
    lab = np.full(n, NONE)
    off = np.zeros(n)
    fill = feats["fill"][side]
    if side == "left" and is_median_owner:
        clear = feats["clear"]
        t = thr["median"]["threshold"]
        if t is not None:
            m = clear < t
            lab[m] = T_CODE["concrete"]
            off[m] = np.clip(clear[m] / 2, *O_CONCRETE_MEDIAN)
    lab = smooth_rule(lab, T_CODE["concrete"], "concrete")
    off[lab == T_CODE["concrete"]] = np.clip(feats["clear"][lab == T_CODE["concrete"]] / 2, *O_CONCRETE_MEDIAN) if side == "left" and is_median_owner else O_CONCRETE_EDGE
    tf = thr["fill"]["threshold"]
    gr = smooth_rule((fill > tf) & (lab == NONE), True, "guardrail") & (lab == NONE)
    if side == "left" and is_median_owner:
        gr &= feats["clear"] > 2.0  # a guardrail needs room in the median
    lab[gr] = T_CODE["guardrail"]
    off[gr] = O_GUARDRAIL
    drop = (room(geom, side) < DROP_ROOM) & (fill > DROP_H) & (lab != T_CODE["concrete"])
    lab[drop] = T_CODE["concrete"]
    off[drop] = O_CONCRETE_EDGE
    appr = window(geom, approach_ranges(geom.road)) & (lab == NONE)
    if side == "left" and is_median_owner:
        appr &= feats["clear"] > 2.0
    lab[appr] = T_CODE["guardrail"]
    off[appr] = O_GUARDRAIL
    for a, b, o in feats["piers"][side]:
        m = (geom.s >= a) & (geom.s <= b) & (lab != T_CODE["concrete"])
        lab[m] = T_CODE["guardrail"]
        off[m] = o
    return lab, off


def smooth_rule(lab, value, kind):
    """Close rule-only gaps up to RULE_GAP and drop runs shorter than MIN_RULE_RUN, for one type."""
    m = lab == value
    m = close_gaps(m, int(RULE_GAP[kind] / STEP))
    m = drop_short(m, int(MIN_RULE_RUN[kind] / STEP))
    if lab.dtype == bool:
        return m
    out = np.where(lab == value, NONE, lab)
    out[m] = value
    return out


def merge_labels(mapped, rule):
    """Mapped where mapped, rule elsewhere. Returns (type, offset, height, provenance 0 mapped / 1 rule)."""
    mlab, moff, mh = mapped
    rlab, roff = rule
    use_m = (mlab != NONE) & (mlab != FENCE)
    lab = np.where(use_m, mlab, rlab)
    prov = np.where(use_m, 0, 1)
    # mapped concrete and guardrail stand at the rule's offset (OSM's positions are a few metres
    # loose); a mapped wall keeps its mapped offset
    off = np.where(use_m & (mlab == T_CODE["wall"]), np.maximum(moff, O_WALL_MIN), roff)
    off = np.where(use_m & (mlab == T_CODE["guardrail"]), O_GUARDRAIL, off)
    off = np.where(use_m & (mlab == T_CODE["concrete"]) & (rlab != T_CODE["concrete"]), O_CONCRETE_EDGE, off)
    off = np.where(use_m & (mlab == T_CODE["cable"]), O_CONCRETE_MEDIAN[1], off)
    h = np.where(use_m & (mlab == T_CODE["wall"]), mh, 0.0)
    return lab, off, h, prov


class Pavements:
    """Every road's pavement in plan, to keep barriers and columns out of other roads."""

    def __init__(self, geoms):
        self.geoms = geoms

    def blocked(self, own, x, y, h, clearance=0.4):
        """Mask of map points (with heights h) that lie on another road's pavement (or within
        `clearance` of it) at less than CLEARANCE vertically."""
        x, y, h = (np.atleast_1d(np.asarray(v, dtype=np.float64)) for v in (x, y, h))
        out = np.zeros(len(x), dtype=bool)
        for rid, g in self.geoms.items():
            if rid == own:
                continue
            dist, _ = g.tree.query(np.c_[x, y], distance_upper_bound=g.half + g.road["spacing"] + clearance + 2)
            near = np.isfinite(dist)
            if not near.any():
                continue
            k = np.nonzero(near)[0]
            s, d, _ = g.locate(x[k], y[k])
            ok = (s >= -1) & (s <= g.length + 1)
            sc = np.clip(s, 0, g.length)
            lt, rt = pavement_edges(g.secs, sc)
            p = g.line.at(sc)
            hr = p["h"] + p["crossfall"] * d
            hit = ok & (d < lt + clearance) & (d > rt - clearance) & (np.abs(hr - h[k]) < CLEARANCE)
            out[k[hit]] = True
        return out


def cut_mask(geom, side, junctions, pavements, lab, off):
    """Stations where nothing may stand: gore openings, parapet bridges (the parapet is the
    barrier there) and other roads' pavements."""
    # a gore opening stops what stands near the edge; a wall far out is kept off the ramp by the pavement test
    cut = (window(geom, junction_cuts(geom, junctions, side)) & (off < 6.0)) | window(geom, parapet_ranges(geom.road))
    k = np.nonzero(lab != NONE)[0]
    if len(k):
        x, y, he = geom.point(geom.s[k], side, off[k] + np.where(lab[k] == T_CODE["concrete"], 0.3, 0.0))
        cut[k[pavements.blocked(geom.id, x, y, he)]] = True
    return cut


def to_runs(geom, side, lab, off, hgt, prov, heights, max_err=0.15, max_len=240.0):
    """Station labels into runs: pieces of one type and provenance, offsets linear within each
    (split until no station is more than max_err off), with which ends are free (need an end
    treatment) or join the next piece. Walls carry their base height relative to the pavement edge."""
    runs = []
    n = len(lab)
    i = 0
    while i < n:
        if lab[i] == NONE:
            i += 1
            continue
        j = i
        while j + 1 < n and lab[j + 1] == lab[i]:
            j += 1
        if j - i + 1 >= MIN_RUN:
            runs.extend(_pieces(geom, side, i, j, int(lab[i]), off, hgt, prov, heights, max_err, max_len))
        i = j + 1
    return runs


def wall_support(geom, side, s, off, heights):
    """Height, relative to the pavement edge, of what a wall `off` metres outside `side`'s edge stands on at each s:
    the higher of the drawn ground and the drawn embankment (squeezed as the mesher squeezes it)."""
    from .groundcheck import Road
    if getattr(geom, "_drawn", None) is None:
        geom._drawn = Road(geom.road)
    road = geom._drawn
    s = np.asarray(s, dtype=np.float64)
    z, he, _ = road.emb_surface(s, side, off)
    x, y, _ = geom.point(s, side, off)
    g = np.ravel(ground_of(heights)(x, y))
    return np.maximum(g, z) - he


def _pieces(geom, side, i, j, t, off, hgt, prov, heights, max_err, max_len):
    out = []
    stack = [(i, j)]
    segs = []
    while stack:
        a, b = stack.pop()
        lin = np.interp(np.arange(a, b + 1), [a, b], [off[a], off[b]])
        err = np.max(np.abs(lin - off[a:b + 1]))
        pv = prov[a:b + 1]
        if (b - a > 2) and (err > max_err or (b - a) * STEP > max_len or pv.min() != pv.max()):
            m = (a + b) // 2
            if pv.min() != pv.max():  # split where the provenance changes
                m = a + int(np.nonzero(pv != pv[0])[0][0]) - 1
                m = max(a + 1, min(b - 1, m))
            stack.append((m, b))
            stack.append((a, m))
            continue
        segs.append((a, b))
    segs.sort()
    for k, (a, b) in enumerate(segs):
        r = {"s0": float(geom.s[a]), "s1": float(geom.s[b]), "side": side, "type": TYPES[t],
             "o0": round(float(off[a]), 2), "o1": round(float(off[b]), 2), "prov": "mapped" if prov[a] == 0 else "rule",
             "open0": k == 0, "open1": k == len(segs) - 1}
        if TYPES[t] == "wall":
            hh = float(np.max(hgt[a:b + 1])) or WALL_H["wall"]
            r["h"] = round(hh, 1)
            # the base stands on what is drawn there, relative to the edge: the higher of the ground and the
            # embankment as the mesher squeezes it (lib.groundcheck, mesher.js embScales), and nowhere along the run
            # above it (the base is a straight line between the ends)
            qs = np.arange(a, b + 1)
            sup = wall_support(geom, side, geom.s[qs], np.maximum(off[qs], 0.0), heights)
            line = np.interp(qs, [a, b], [sup[0], sup[-1]])
            lower = max(0.0, float((line - sup).max()))
            r["z0"], r["z1"] = (math.floor((float(v) - lower) * 100) / 100 for v in (sup[0], sup[-1]))
        out.append(r)
    return out


# ---------------------------------------------------------------- delineators

FT = 0.3048
DELIN_TANGENT = 400 * FT  # 122 m on straight mainline (MUTCD 3F: 200 to 530 ft)
DELIN_RAMP = 100 * FT
DELIN_OFFSET = 0.9  # m outside the shoulder edge (MUTCD: 2 to 8 ft)


def curve_spacing(radius_m):
    """MUTCD Table 3F-1, S = 3 sqrt(R - 50) in feet, kept within 20 and 300 ft, in metres."""
    r_ft = radius_m / FT
    return max(20.0, min(300.0, 3.0 * math.sqrt(max(r_ft - 50.0, 0.0)))) * FT


def delineators(geom, side, ramp, blocked_side, pavements, cuts):
    """Chainages of delineators on one side: at MUTCD spacing (closer on curves and ramps), not
    where a barrier runs on that side (it carries reflectors of its own), not in a gore opening
    or on another road's pavement."""
    out = []
    s = 30.0
    while s < geom.length - 10:
        i = min(len(geom.s) - 1, int(round(s / STEP)))
        k = abs(float(geom.k[i]))
        sp = DELIN_RAMP if ramp else DELIN_TANGENT
        if k > 1e-5:
            sp = min(sp, curve_spacing(1 / k))
        if not blocked_side[i] and not cuts[i]:
            out.append(round(s, 1))
        s += sp
    if out:
        x, y, he = geom.point(np.array(out), side, DELIN_OFFSET)
        bad = pavements.blocked(geom.id, x, y, he, clearance=0.6)
        out = [v for v, b in zip(out, bad) if not b]
    return out


# ---------------------------------------------------------------- the whole build


def check_points(geom, final, mapped, n=30):
    """n evenly spaced points along the driven road: what OSM maps there (if anything, within 20 m)
    and what was placed, on each side."""
    out = []
    parapet = window(geom, parapet_ranges(geom.road))
    for k in range(n):
        s = (k + 0.5) * geom.length / n
        i = int(round(s / STEP))
        row = {"s": round(s, 1), "km": round(s / 1000, 2)}
        for side in ("left", "right"):
            lab = final[side][0]
            ml = mapped[side][0]
            lo, hi = max(0, i - 5), min(len(lab), i + 6)
            mm = [int(v) for v in ml[lo:hi] if v not in (NONE, FENCE)]
            placed = int(lab[i]) if lab[i] != NONE else None
            if placed is None and parapet[i]:
                placed = T_CODE["concrete"]  # the bridge's own parapet
            row[side] = {"placed": TYPES[placed] if placed is not None else "none",
                         "osm": TYPES[max(set(mm), key=mm.count)] if mm else None,
                         "basis": "mapped" if mm else "rule only"}
            row[side]["agrees"] = (row[side]["osm"] == row[side]["placed"]) if mm else None
        out.append(row)
    return out


def build(roads, junctions, structures, route_road, opp_id, osm, frame, heights, include=("main", "ramp")):
    """Barrier runs and delineators for the route's road, its opposite and the ramps. Returns
    (roads for encode_barriers, report)."""
    sel = {rid: r for rid, r in roads.items() if (r.get("role") or "main") in include}
    geoms = {rid: RoadGeom(r) for rid, r in sel.items()}
    pav = Pavements({rid: (geoms.get(rid) or RoadGeom(r)) for rid, r in roads.items()})
    for st in structures:
        if st["road"] not in roads:
            continue
        g = pav.geoms[st["road"]]
        p = g.line.at(np.array([st["s"]]))
        hd = float(p["heading"][0])
        st["_xy"] = (float(p["x"][0]) - math.sin(hd) * st["d"], float(p["y"][0]) + math.cos(hd) * st["d"])
        st["_hd"], st["_h0"] = hd, st.get("h1", float(p["h"][0]))
    pairs = {route_road: opp_id} if opp_id in geoms else {}
    pts = project_osm(osm, frame, geoms, pairs) if osm is not None else {}
    mapped, feats, rules_in = {}, {}, {"median": [], "fill": []}
    counts_osm = defaultdict(float)
    for rid, g in geoms.items():
        opp = geoms.get(opp_id) if rid == route_road else None
        f = {"clear": median_clear(g, opp), "fill": {}, "piers": {}}
        for side in ("left", "right"):
            mapped[(rid, side)] = mapped_labels(g, pts.get((rid, side), []))
            f["fill"][side] = fill_height(g, heights, side)
            f["piers"][side] = pier_ranges(g, structures, side)
            for t in set(mapped[(rid, side)][0].tolist()) - {NONE}:
                counts_osm["fence" if t == FENCE else TYPES[t]] += float(np.sum(mapped[(rid, side)][0] == t)) * STEP
        feats[rid] = f
        surveyed = surveyed_mask(g, [mapped[(rid, s)][0] for s in ("left", "right")])
        train, test = holdout_split(g.s, surveyed)
        if rid == route_road and opp is not None:
            # the median rule is fitted where OSM maps the median at all (a block with any barrier on the
            # left): there OSM's silence is a mapped "no barrier"; elsewhere it says nothing
            lab = mapped[(rid, "left")][0]
            med_tr, med_te = holdout_split(g.s, surveyed_mask(g, [lab]))
            rules_in["median"].append((f["clear"], lab == T_CODE["concrete"], med_tr, med_te))
        for side in ("left", "right"):
            lab = mapped[(rid, side)][0]
            if side == "left" and rid == route_road and opp is not None:
                continue  # the median side has its own rule
            # where the side's mapped barrier is not a guardrail it says nothing for or against one
            known = (lab == NONE) | (lab == T_CODE["guardrail"]) | (lab == FENCE)
            rules_in["fill"].append((f["fill"][side], lab == T_CODE["guardrail"], train & known, test & known))
    fit = fit_rules(rules_in)
    fit["median_cable"] = {"placed": False, "why": "OSM maps no cable barrier along the route, so no fit supports one in the wide median"}

    out_roads, final_main, report_roads = [], {}, {}
    counts = defaultdict(float)
    for rid, g in geoms.items():
        runs, dels = [], []
        ramp = (g.road.get("role") or "main") == "ramp"
        for side in ("left", "right"):
            rl = rule_labels(g, side, fit, feats[rid], rid == route_road and rid in pairs)
            lab, off, hgt, prov = merge_labels(mapped[(rid, side)], rl)
            cut = cut_mask(g, side, junctions, pav, lab, off)
            lab = np.where(cut, NONE, lab)
            for t in range(len(TYPES)):  # pieces shorter than MIN_RUN after the cuts go
                m = drop_short(lab == t, MIN_RUN)
                lab = np.where((lab == t) & ~m, NONE, lab)
            if rid == route_road:
                final_main[side] = (lab, prov, off)
            side_runs = to_runs(g, side, lab, off, hgt, prov, heights)
            runs += side_runs
            for r in side_runs:
                counts[(r["type"], r["prov"])] += r["s1"] - r["s0"]
            # delineators on the right; on the left only where the median is open (no barrier) and wide
            barrier = (lab == T_CODE["guardrail"]) | (lab == T_CODE["concrete"])
            want_left = ramp or (rid == route_road and side == "left" and opp_id in geoms)
            if side == "right" or want_left:
                block = barrier.copy()
                if side == "left" and not ramp:
                    block |= feats[rid]["clear"] < 6.0
                cuts = window(g, junction_cuts(g, junctions, side)) | window(g, parapet_ranges(g.road))
                ss = delineators(g, side, ramp, block, pav, cuts)
                if ss:
                    dels.append({"side": side, "colour": "white" if side == "right" else "yellow", "o": DELIN_OFFSET, "s": ss})
        runs.sort(key=lambda r: (r["s0"], r["side"]))
        if runs or dels:
            out_roads.append({"id": rid, "runs": runs, "delineators": dels})
        report_roads[rid] = {"runs": len(runs), "delineators": sum(len(d["s"]) for d in dels)}
    main_g = geoms[route_road]
    report = {
        "fit": fit,
        "osm_mapped_m": {k: round(v) for k, v in counts_osm.items()},
        "placed_m": {f"{t} {p}": round(v) for (t, p), v in sorted(counts.items())},
        "roads": report_roads,
        "check_points": check_points(main_g, final_main, {s: mapped[(route_road, s)] for s in ("left", "right")}),
        "rules": {"median": "concrete median barrier where the clear median is under the fitted threshold, centre at half the clear width within "
                  f"{O_CONCRETE_MEDIAN} m of the left edge", "fill": "guardrail where the fill 3-9 m outside the edge exceeds the threshold",
                  "approach": f"guardrail {APPROACH[0]:.0f} m before and {APPROACH[1]:.0f} m after every parapet bridge",
                  "piers": f"guardrail {PIER_RUN[0]:.0f} m before to {PIER_RUN[1]:.0f} m past any pier within {PIER_ZONE:.0f} m of the edge",
                  "drop_off": f"concrete barrier where the embankment is held under {DROP_ROOM} m and the road stands over {DROP_H} m",
                  "cuts": "no barrier in a gore opening (junction range +- margin), on a parapet bridge, or on another road's pavement within 4.9 m vertically",
                  "delineators": "white on the right, yellow on the left in open medians at least 6 m wide; 400 ft on tangents, MUTCD Table 3F-1 on curves, 100 ft on ramps; none beside a barrier"},
    }
    ctx = {"geoms": geoms, "pavements": pav, "main": final_main, "clear": feats[route_road]["clear"], "geom": main_g}
    return out_roads, report, ctx


def median_offset_fn(ctx):
    """s -> the median barrier's offset outward of the driven road's left edge there, or None."""
    lab, _, off = ctx["main"]["left"]

    def f(s):
        i = int(round(s / STEP))
        if 0 <= i < len(lab) and lab[i] == T_CODE["concrete"]:
            return float(off[i])
        return None
    return f


def clear_fn(ctx):
    clear = ctx["clear"]
    return lambda s: float(clear[min(len(clear) - 1, max(0, int(round(s / STEP))))])
