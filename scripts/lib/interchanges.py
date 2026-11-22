"""Interchanges (plan 02, D3.4): ramps with gores, the roads that cross the route on bridges,
their heights by rule, and the junction records that tie them to the main line.

There is no LiDAR here, so every height is a rule over the coarse ground, as for the main line:

- A ramp is a road of its own along its OSM link ways (followed from the junction node through
  the straightest continuation, up to REACH metres from the route). Where it leaves or joins a
  carriageway it runs parallel to that carriageway's outer lane edge, GORE_GAP metres beyond
  it, its lane opening (or closing) over a taper; past the junction node it blends onto the
  OSM line. Its surface is pinned to the carriageway's plane there, so the two pavements meet
  in one plane; the browser hides the carriageway's shoulder over that stretch and fills the
  gap between the lane edge and the ramp with the painted gore (format.js, "junctions").
- A road that crosses the route on a bridge is built from its OSM ways, APPROACH metres either
  side of the route, and lifted so its deck clears every pavement under it by CLEAR_AIM
  (DECK metres of structure under its surface); its ends run into the ground.
- Profiles are the lowest that stay above the ground envelope, within the grade and
  vertical-curve limits, with these extra bounds: a ramp's pinned gore stretch; over or
  under every road already built where the two overlap in plan, by OSM `layer`. Roads are
  solved crossing roads first, then ramps, each in order of layer, so a road only ever has to
  clear what was built before it. A ramp that would have to pass under a road that cannot go
  higher (the main line sits on the ground) ends before it.
"""
import re

import numpy as np
from scipy.spatial import cKDTree

from .alignment import fit_line, stations
from .crosssection import normalise_sections, pavement_edges, tapers_of
from .osm import _oriented
from .profile import envelope, smooth_between
from .roadframe import RoadFrame, lane_edges

SPACING = 4.0
REACH = 600.0  # m: ramps end this far from the route at most
LANE = 3.66
RAMP_SL, RAMP_SR, GORE_SL = 1.22, 2.44, 0.3  # ramp shoulders (4 ft, 8 ft) and its gore-side shoulder in the gore
MARK_HALF, GORE_MARGIN = 0.5, 0.1  # half the mesher's marking strip, and room for the fit
GORE_GAP = MARK_HALF + GORE_MARGIN + GORE_SL  # carriageway lane edge to ramp lane edge in the gore
L_PAR_EXIT, L_OPEN = 200.0, 140.0  # deceleration lane before the junction node, and its opening taper
L_PAR_ENTRY, L_CLOSE = 220.0, 140.0  # acceleration lane after the merge node, and its closing taper
NOSE_GAP = 1.0  # m of ground between the carriageway's shoulder and the ramp's at the physical nose
NOSE_MAX = 400.0
SHOULDER_TAPER = 40.0
BLEND = 25.0  # m either side over which a ramp eases off the parallel line onto the OSM line
DECK = 1.2  # m from a deck's surface to its soffit
CLEAR_AIM, CLEAR_MIN = 5.5, 4.9
CLR = CLEAR_AIM + DECK  # surface to surface
SEPARATE = 4.9  # surfaces overlapping in plan must be this far apart, or share a junction
GRADE = 0.06
RAMP_GRADE = 0.08  # ramps may be steeper (and their gores follow a main line at up to 6%)
MPH = 0.44704
RAMP_MPH, CROSS_MPH = 40, 40
COMFORT = 0.5  # m/s^2 at the design speed sets the vertical-curve radius on ramps and crossings
CLEARANCE, MARGIN = 0.3, 1.0
CROWN, E_MAX, F_SIDE = 0.02, 0.08, 0.15
APPROACH, APPROACH_MAX, APPROACH_LONG = 220.0, 520.0, 900.0
DECK_GROW = 11.0  # m beyond a pavement it crosses that a deck spans (horizontal clearance and the abutment slope)
ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
                "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}


def rnd(v, nd=1):
    v = round(float(v), nd)
    return int(v) if v == int(v) else v


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:24] or "road"


def layer_of(tags):
    try:
        v = int(float(tags.get("layer", "")))
    except ValueError:
        v = None
    if v is None:
        v = 1 if tags.get("bridge") not in (None, "no") else 0
    return v


OWN_REF = "I 15"  # the route's own road: its ways are never ramps' streets or crossing roads


def is_own(tags, own=None):
    own = own or OWN_REF
    return any(r.strip().replace("-", " ") == own for r in tags.get("ref", "").split(";"))



def poly(osm, to_xy, nodes):
    lat, lon = osm.latlon(nodes)
    x, y = to_xy(lat, lon)
    return np.column_stack([np.asarray(x, float), np.asarray(y, float)])


def densify(P, step, tags=None):
    """Points every <= step m along polyline P; tags[k] (per segment) carried to each point."""
    out, tg = [P[0]], [tags[0] if tags is not None else None]
    for k in range(len(P) - 1):
        L = float(np.hypot(*(P[k + 1] - P[k])))
        n = max(1, int(np.ceil(L / step)))
        for j in range(1, n + 1):
            out.append(P[k] + (P[k + 1] - P[k]) * j / n)
            tg.append(tags[k] if tags is not None else None)
    out = np.array(out)
    keep = np.r_[True, np.hypot(*np.diff(out, axis=0).T) > 1e-3]
    return out[keep], [t for t, kk in zip(tg, keep) if kk]


def arclen(P):
    return np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]


def left_normals(P):
    d = np.gradient(P, axis=0)
    d /= np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)[:, None]
    return np.column_stack([-d[:, 1], d[:, 0]])


def movavg(a, n):
    if n <= 1 or len(a) < 3:
        return a
    n = min(n, len(a) | 1)
    pad = np.r_[np.full(n // 2, a[0]), a, np.full(n - 1 - n // 2, a[-1])]
    return np.convolve(pad, np.ones(n) / n, mode="valid")


def crossfall_rule(curvature, mph):
    """As build_roads.crossfall_rule, for the ramps' and crossing roads' design speed."""
    v = mph * MPH
    r_min = v * v / (9.81 * (E_MAX + F_SIDE))
    e = np.minimum(E_MAX, E_MAX * r_min * np.abs(curvature))
    c_right = np.maximum(CROWN, e)
    half = CROWN / 2
    c_left = np.where(e <= half, CROWN, np.where(e < CROWN, CROWN - 4 * (e - half), -e))
    return np.where(curvature < 0, c_right, c_left)


# ---------------------------------------------------------------------------------- drafts

class Draft:
    """A road being built: stations, sections and everything that refers to its chainage."""

    def __init__(self, rid, role, cls, st, sections, mph, layer, ways, ref="", direction=""):
        self.id, self.role, self.cls, self.ref, self.dir = rid, role, cls, ref, direction
        self.st = st  # x, y, heading, curvature (arrays, one per station)
        self.n = len(st["x"])
        self.sections = sections
        self.mph = mph
        self.layer = np.asarray(layer, dtype=np.int64)  # OSM layer per station
        self.ways = list(ways)  # OSM way per station (None in a gore)
        self.pin = np.full(self.n, np.nan)  # pinned reference-line height
        self.pin_cf = np.full(self.n, np.nan)  # pinned crossfall
        self.crossfall = None
        self.h = None
        self.bridges = []
        self.free_start = self.free_end = True
        self.osm_bridge = np.zeros(self.n, dtype=bool)
        self.notes = []
        self.info = {}

    @property
    def length(self):
        return (self.n - 1) * SPACING

    def road(self):
        """The writer's dict (h and crossfall must be set)."""
        return {"id": self.id, "ref": self.ref, "dir": self.dir, "class": self.cls, "role": self.role,
                "stations": {"spacing": SPACING}, "sections": self.sections,
                "speed": [{"s0": 0, "mph": int(self.mph)}], "surface": [{"s0": 0, "kind": "asphalt"}],
                "bridges": self.bridges, "links": [], "spacing": SPACING,
                "x": self.st["x"], "y": self.st["y"], "h": self.h, "heading": self.st["heading"],
                "curvature": self.st["curvature"], "crossfall": self.crossfall}

    def frame(self):
        if self.h is None:
            raise ValueError("no profile yet")
        return RoadFrame(self.road())

    def plan_frame(self):
        """A frame for plan questions before the profile exists."""
        r = self.road()
        r["h"] = np.zeros(self.n)
        r["crossfall"] = np.zeros(self.n)
        return RoadFrame(r)

    def trim(self, k0, k1, junctions=()):
        """Keep stations k0..k1; shift everything that holds a chainage on this road."""
        k1 = min(k1, self.n - 1)
        if k0 <= 0 and k1 >= self.n - 1:
            return
        off = k0 * SPACING
        L = (k1 - k0) * SPACING
        for k in ("x", "y", "heading", "curvature"):
            self.st[k] = self.st[k][k0:k1 + 1]
        for name in ("layer", "pin", "pin_cf", "osm_bridge"):
            setattr(self, name, getattr(self, name)[k0:k1 + 1])
        self.ways = self.ways[k0:k1 + 1]
        if self.crossfall is not None:
            self.crossfall = self.crossfall[k0:k1 + 1]
        if self.h is not None:
            self.h = self.h[k0:k1 + 1]
        self.n = k1 - k0 + 1
        secs = []
        for sec in self.sections:
            a, b = sec["s0"] - off, sec["s1"] - off
            if b <= 1e-6 or a >= L - 1e-6:
                continue
            sec = dict(sec, s0=rnd(max(0.0, a)), s1=rnd(min(L, b)))
            if "taper" in sec:
                t0, t1 = sec["taper"]["s0"] - off, sec["taper"]["s1"] - off
                if t0 < 0 or t1 > L or not secs:
                    sec.pop("taper")
                else:
                    sec["taper"] = dict(sec["taper"], s0=rnd(t0), s1=rnd(t1))
            if sec["s1"] - sec["s0"] > 1e-6:
                secs.append(sec)
        secs[0]["s0"] = 0
        secs[0].pop("taper", None)
        secs[-1]["s1"] = rnd(L)
        self.sections = secs
        for j in junctions:
            for end in ("a", "b"):
                if j[end]["road"] == self.id:
                    j[end]["s0"] = round(max(0.0, j[end]["s0"] - off), 2)
                    j[end]["s1"] = round(min(L, j[end]["s1"] - off), 2)
                    j[end]["s0"] = min(j[end]["s0"], j[end]["s1"])
            g = j.get("gore")
            if g and j["b"]["road"] == self.id:
                g["b"] = [round(v - off, 2) for v in g["b"]]


def chords_ok(st):
    """The decoder's check: consecutive stations SPACING apart in plan, to 0.5% (with room for mm rounding)."""
    c = np.hypot(np.diff(st["x"]), np.diff(st["y"]))
    return bool(np.all(np.abs(c - SPACING) < 0.004 * SPACING))


def stations_of(P, tol=0.1, min_radius=20.0):
    """Uniform 4 m stations along a dense polyline (map metres, in order of travel), refitted
    more smoothly where a kink would break the uniform spacing."""
    for t, r in ((tol, min_radius), (0.5, 40.0), (1.5, 60.0), (3.0, 80.0)):
        fit = fit_line(P, tol=t, step=2.0, sigma=0.05, min_radius=r, relax_span=20.0)
        st = stations(fit, 0.0, float(fit.arc[-1]), SPACING, multiple=1)
        if chords_ok(st):
            return st, fit
    raise ValueError("no fit gives uniform stations")


def stations_between(P, a0, a1):
    """Stations on a mapped line between arc lengths a0 and a1 of polyline P (tolerant fits)."""
    a = arclen(P)
    for t, r in ((0.5, 250.0), (1.0, 60.0), (2.0, 60.0), (4.0, 80.0)):
        fit = fit_line(P, tol=t, min_radius=r)
        arc0 = float(fit.project(*P[np.searchsorted(a, a0)])[0][0])
        arc1 = float(fit.project(*P[min(len(P) - 1, np.searchsorted(a, a1))])[0][0])
        st = stations(fit, arc0, arc1, SPACING, multiple=1)
        if chords_ok(st):
            return st
    raise ValueError("no fit gives uniform stations")


# ---------------------------------------------------------------------------------- topology

def link_index(osm, skip):
    starts, ends = {}, {}
    for wid, w in osm.ways.items():
        if wid in skip or w["tags"].get("highway") != "motorway_link":
            continue
        ns = _oriented(osm, wid)
        starts.setdefault(ns[0], []).append(wid)
        ends.setdefault(ns[-1], []).append(wid)
    return starts, ends


def _turn(P_from, P_to):
    a = np.arctan2(*(P_from[1] - P_from[0])[::-1])
    b = np.arctan2(*(P_to[1] - P_to[0])[::-1])
    return abs(np.angle(np.exp(1j * (b - a))))


def road_nodes(osm):
    """Nodes on any road way that is not a motorway link (where a ramp meets a street)."""
    out = set()
    for w in osm.ways.values():
        hw = w["tags"].get("highway")
        if hw in ROAD_CLASSES and hw != "motorway_link":
            out.update(w["nodes"])
    return out


def walk(osm, to_xy, first, index, forward, stop, avoid, max_len=3000.0, streets=frozenset()):
    """Link ways from `first` on (or back, forward=False), at a split taking the straightest
    continuation, ending at a carriageway node (`stop`), at a street, or where the links end.
    Returns (ways, nodes in travel order, how it ends, end node)."""
    starts, ends = index
    ways = [first]
    ns = list(_oriented(osm, first))
    length = float(arclen(poly(osm, to_xy, ns))[-1])
    while True:
        tip = ns[-1] if forward else ns[0]
        if tip in stop:
            return ways, ns, "carriageway", tip
        if tip in streets:
            return ways, ns, "street", tip
        cands = [w for w in (starts if forward else ends).get(tip, []) if w not in ways and w not in avoid]
        if not cands or length > max_len:
            return ways, ns, "end", tip
        here = poly(osm, to_xy, ns[-2:] if forward else ns[:2])
        best, bt = None, np.inf
        for w in cands:
            wn = _oriented(osm, w)
            nxt = poly(osm, to_xy, wn[:2] if forward else wn[-2:])
            t = _turn(here, nxt)
            if t < bt:
                best, bt = w, t
        wn = _oriented(osm, best)
        ns = ns + wn[1:] if forward else wn[:-1] + ns
        length += float(arclen(poly(osm, to_xy, wn))[-1])
        ways.append(best)


def find_ramps(osm, cws, to_xy):
    """Ramp specs: the link chains that leave or join each carriageway inside its stretch."""
    stop = {}
    for k, cw in enumerate(cws):
        for n in cw["ids"]:
            stop.setdefault(n, k)
    skip = set().union(*(cw["ways"] for cw in cws))
    index = link_index(osm, skip)
    streets = road_nodes(osm) - set(stop)
    specs, used = [], set()

    def s_of(k, n):
        F = cws[k]["frame"]
        x, y = poly(osm, to_xy, [n])[0]
        s, d, off = F.sd(x, y)
        return float(s[0]), float(abs(d[0])), float(off[0])

    for k, cw in enumerate(cws):
        for n in cw["ids"]:
            for wid in index[0].get(n, []):
                if wid in used:
                    continue
                s, d, off = s_of(k, n)
                if off > 1 or d > 30 or s < 40 or s > cw["frame"].length - 40:
                    continue
                ways, ns, how, tip = walk(osm, to_xy, wid, index, True, {m for m in stop if m != n}, used, streets=streets)
                end = (stop[tip], tip) if how == "carriageway" else None
                specs.append({"start": (k, n), "end": end, "ways": ways, "nodes": ns})
                used.update(ways)
    for k, cw in enumerate(cws):
        for n in cw["ids"]:
            for wid in index[1].get(n, []):
                if wid in used:
                    continue
                s, d, off = s_of(k, n)
                if off > 1 or d > 30 or s < 40 or s > cw["frame"].length - 40:
                    continue
                ways, ns, how, tip = walk(osm, to_xy, wid, index, False, {m for m in stop if m != n}, used, streets=streets)
                specs.append({"start": None, "end": (k, n), "ways": ways, "nodes": ns})
                used.update(ways)
    return specs, used


def _runs_along(P, F, hit, max_deg=12.0):
    """A way whose every point on a carriageway's pavement heads along it (within max_deg, either
    way) is a carriageway itself on a shared deck (the other direction on a bridge beyond the
    route's end, whose ref is not the route's), not a road that crosses it."""
    m, s, _ = hit
    k = np.flatnonzero(m)
    if not len(k):
        return False
    d = np.gradient(P, axis=0)[k]
    hw = np.arctan2(d[:, 1], d[:, 0])
    hr = F.line.at(s[k])["heading"]
    return bool(np.all(np.abs(np.cos(hw - hr)) >= np.cos(np.radians(max_deg))))


def endpoint_index(osm, own=None):
    idx = {}
    for wid, w in osm.ways.items():
        if w["tags"].get("highway") not in ROAD_CLASSES or is_own(w["tags"], own):
            continue
        for n in (w["nodes"][0], w["nodes"][-1]):
            idx.setdefault(n, []).append(wid)
    return idx


def find_crossings(osm, cws, to_xy, skip, own=None):
    """Ways tagged bridge that cross a carriageway's pavement in plan, extended along their road
    to chains: [{"ways", "nodes", "oneway"}]. Ways of the route's own road (`own`, as "I 15") are
    never crossings."""
    ends = endpoint_index(osm, own)
    cand = []
    for wid, w in osm.ways.items():
        t = w["tags"]
        if wid in skip or t.get("highway") not in ROAD_CLASSES or is_own(t, own) or t.get("bridge") in (None, "no"):
            continue
        P, _ = densify(poly(osm, to_xy, w["nodes"]), 2.0)
        hits = [(cw, cw["frame"].inside(P[:, 0], P[:, 1])) for cw in cws]
        hits = [(cw, h) for cw, h in hits if h[0].any()]
        if hits and not all(_runs_along(P, cw["frame"], h) for cw, h in hits):
            cand.append(wid)
    chains, used = [], set()
    for wid in cand:
        if wid in used:
            continue
        t = osm.ways[wid]["tags"]
        oneway = t.get("oneway") in ("yes", "1", "true", "-1") or t.get("highway") in ("motorway", "motorway_link")
        name = t.get("name") or t.get("ref") or ""
        ns = list(_oriented(osm, wid) if oneway else osm.ways[wid]["nodes"])
        ways = [wid]

        def grow(forward):
            nonlocal ns
            length = 0.0
            while length < APPROACH_LONG + 50:
                tip = ns[-1] if forward else ns[0]
                here = poly(osm, to_xy, ns[-2:] if forward else ns[:2])
                best, bt = None, np.radians(50)
                for w2 in ends.get(tip, []):
                    if w2 in ways or w2 in used:
                        continue
                    t2 = osm.ways[w2]["tags"]
                    ow2 = t2.get("oneway") in ("yes", "1", "true", "-1") or t2.get("highway") in ("motorway", "motorway_link")
                    if ow2 != oneway:
                        continue
                    wn = list(_oriented(osm, w2) if oneway else osm.ways[w2]["nodes"])
                    if forward and wn[0] != tip:
                        if oneway or wn[-1] != tip:
                            continue
                        wn = wn[::-1]
                    if not forward and wn[-1] != tip:
                        if oneway or wn[0] != tip:
                            continue
                        wn = wn[::-1]
                    nxt = poly(osm, to_xy, wn[:2] if forward else wn[-2:])
                    tt = _turn(here, nxt) - (0.3 if (t2.get("name") or t2.get("ref") or "") == name else 0.0)
                    if tt < bt:
                        best, bt, bwn = w2, tt, wn
                if best is None:
                    return
                ways.append(best)
                ns = ns + bwn[1:] if forward else bwn[:-1] + ns
                length += float(arclen(poly(osm, to_xy, bwn))[-1])

        grow(True)
        grow(False)
        used.update(w for w in ways if w in cand)
        chains.append({"ways": ways, "nodes": ns, "oneway": oneway, "name": name, "first": wid})
    return merge_twins(osm, to_xy, chains)


def merge_twins(osm, to_xy, chains):
    """Two one-way chains of the same named road running opposite ways within 45 m of each other
    are its two carriageways: build them as one two-way road along their midline."""
    out, taken = [], set()
    for i, a in enumerate(chains):
        if i in taken:
            continue
        twin = None
        if a["oneway"] and a["name"]:
            Pa = poly(osm, to_xy, a["nodes"])
            for j in range(i + 1, len(chains)):
                b = chains[j]
                if j in taken or not b["oneway"] or b["name"] != a["name"]:
                    continue
                Pb = poly(osm, to_xy, b["nodes"])
                d, k = cKDTree(Pb).query(Pa)
                if np.median(d) > 45:
                    continue
                ha = np.diff(Pa, axis=0).sum(axis=0)
                hb = np.diff(Pb, axis=0).sum(axis=0)
                if np.dot(ha, hb) < 0:
                    twin = j
                    break
        if twin is not None:
            taken.add(twin)
            b = chains[twin]
            out.append({**a, "oneway": False, "twin": b, "ways": a["ways"] + b["ways"], "nodes_twin": b["nodes"]})
        else:
            out.append(a)
    return out


# ---------------------------------------------------------------------------------- geometry

def way_tags_per_point(osm, ways, nodes):
    """For a node chain built from `ways`, the way of each segment."""
    seg = []
    for a, b in zip(nodes[:-1], nodes[1:]):
        hit = None
        for w in ways:
            wn = osm.ways[w]["nodes"]
            for i in range(len(wn) - 1):
                if {wn[i], wn[i + 1]} == {a, b}:
                    hit = w
                    break
            if hit:
                break
        seg.append(hit)
    return seg


def main_taper_near(F, s_node, side, kind):
    """A taper of the carriageway on `side` near s_node where a lane ends (exit) or begins
    (entrance) there: (s0, s1) or None."""
    for tp in tapers_of(F.secs):
        a, b = F.secs[tp["from"]], F.secs[tp["i"]]
        ea = lane_edges(F.secs, np.array([tp["s0"] - 1.0]))
        eb = lane_edges(F.secs, np.array([tp["s1"] + 1.0]))
        k = 0 if side == "left" else 1
        moved = float(eb[k][0] - ea[k][0])
        inward = moved < -1.5 if side == "left" else moved > 1.5
        outward = moved > 1.5 if side == "left" else moved < -1.5
        if kind == "exit" and inward and abs(tp["s1"] - s_node) < 120 and len(b["lanes"]) < len(a["lanes"]):
            return tp["s0"], tp["s1"]
        if kind == "entrance" and outward and abs(tp["s0"] - s_node) < 120 and len(b["lanes"]) > len(a["lanes"]):
            return tp["s0"], tp["s1"]
    return None


def gore_side_of(F, Q, kind):
    s, d, off = F.sd(Q[:, 0], Q[:, 1])
    order = range(len(Q)) if kind == "exit" else range(len(Q) - 1, -1, -1)
    le, ri = F.lane_edges(s)
    for i in order:
        if off[i] < 1 and (d[i] > le[i] + 3 or d[i] < ri[i] - 3):
            return "left" if d[i] > 0 else "right"
    return "right"


def weave_limits(osm, to_xy, specs, cws):
    """Where an entrance and the next exit on the same side are close, they share the stretch
    between them (a weaving section): the entrance's lane ends and the exit's opens at the middle,
    so the two gores never lie on the same pavement."""
    marks = {}
    for spec in specs:
        Q = poly(osm, to_xy, spec["nodes"])
        for key, kind in (("start", "exit"), ("end", "entrance")):
            if not spec[key]:
                continue
            k, n = spec[key]
            F = cws[k]["frame"]
            s = float(F.sd(*poly(osm, to_xy, [n])[0])[0][0])
            side = gore_side_of(F, Q, kind)
            marks.setdefault((k, side), []).append((s, kind, spec))
    for (k, side), ms in marks.items():
        ms.sort(key=lambda m: m[0])
        for i, (s, kind, spec) in enumerate(ms):
            if kind != "entrance":
                continue
            nxt = next((m for m in ms[i + 1:] if m[1] == "exit"), None)
            if nxt and nxt[0] - s < L_PAR_ENTRY + L_PAR_EXIT:
                mid = (s + nxt[0]) / 2
                spec["limit_b"] = min(spec.get("limit_b", np.inf), mid - 2)
                nxt[2]["limit_a"] = max(nxt[2].get("limit_a", 0.0), mid + 2)


def ramp_line(osm, to_xy, spec, cws, route_tree):
    """The ramp's reference line (its gore-side lane edge) as stations, and where its gores are."""
    nodes = spec["nodes"]
    seg = way_tags_per_point(osm, spec["ways"], nodes)
    lane_way = spec["ways"][0] if spec["start"] else spec["ways"][-1]
    try:
        n_l = int(osm.ways[lane_way]["tags"].get("lanes", "1"))
    except ValueError:
        n_l = 1
    n_l = int(np.clip(n_l, 1, 3))
    W = n_l * LANE
    Q, qway = densify(poly(osm, to_xy, nodes), 2.0, seg)
    qway = np.array([w if w is not None else -1 for w in qway])
    if len(Q) > 4:
        # the mapped line through a smoothing spline first, so its offset has no kinks
        fq = fit_line(Q, tol=0.5, step=2.0, min_radius=25.0, relax_span=20.0)
        a = arclen(Q)
        u = fq.u_at(np.clip(fq.project(Q[:, 0], Q[:, 1])[0], 0, fq.arc[-1]))
        from scipy.interpolate import splev
        sx, sy = splev(u, fq.tck)
        Q = np.column_stack([sx, sy])
        _ = a
    start, end = spec["start"], spec["end"]
    # how far the ramp reaches from the route
    dist, _ = route_tree.query(Q)
    far = dist > REACH
    if far.any():
        if start is not None:
            k = int(np.argmax(far))
            Q, qway = Q[:k], qway[:k]
            end = None
        else:
            k = len(far) - 1 - int(np.argmax(far[::-1]))
            Q, qway = Q[k + 1:], qway[k + 1:]
    if len(Q) < 10:
        return None
    side_s = gore_side_of(cws[start[0]]["frame"], Q, "exit") if start else None
    side_e = gore_side_of(cws[end[0]]["frame"], Q, "entrance") if end else None
    side = side_s or side_e
    if start and end and side_e != side_s:
        end = None  # a connector that changes sides: keep its exit end only
        side = side_s
    sg = -1.0 if side == "right" else 1.0  # outward from the carriageway
    # the reference line: the gore-side edge of the lanes
    Qr = Q - sg * left_normals(Q) * (W / 2)
    info = {"lanes": n_l, "side": side, "W": W}
    pts, pway = [], []

    def parallel(F, s0, s1):
        s = np.arange(s0, s1 + 1e-9, 2.0)
        le, ri = F.lane_edges(s)
        e = le if side == "left" else ri
        return s, e + sg * GORE_GAP

    tail_from, tail_to = 0, len(Qr)
    head_pts = head_way = None
    if start:
        F = cws[start[0]]["frame"]
        x, y = poly(osm, to_xy, [start[1]])[0]
        s_j = float(F.sd(x, y)[0][0])
        tp = main_taper_near(F, s_j, side, "exit")
        lim = spec.get("limit_a", 0.0)
        if tp and tp[0] - 4 >= lim:
            s_a, open1 = max(0.0, tp[0] - 4), tp[1]
        else:
            s_a = max(0.0, lim, s_j - L_PAR_EXIT)
            open1 = min(s_j, s_a + 4 + min(L_OPEN, max(40.0, s_j - s_a - 8)))
        sq, dq, off = F.sd(Qr[:, 0], Qr[:, 1])
        s_par, d_par = parallel(F, s_a, s_j + 600)
        k_end = 0
        while k_end + 1 < len(Qr) and off[k_end + 1] < 0.5 and sq[k_end + 1] > sq[k_end]:
            dp = np.interp(sq[k_end + 1], s_par, d_par)
            if sg * (dq[k_end + 1] - dp) > 15:
                break
            k_end += 1
        s_grid = np.arange(s_a, max(sq[k_end], s_j) + 1e-9, 2.0)
        dp = np.interp(s_grid, s_par, d_par)
        dqi = np.interp(s_grid, sq[:k_end + 1], dq[:k_end + 1]) if k_end > 0 else dp
        excess = np.where(s_grid > s_j, np.maximum(0.0, sg * (dqi - dp)), 0.0)
        excess = movavg(excess, int(BLEND) | 1)  # BLEND m either side at 2 m steps
        excess = np.where(s_grid > s_j - BLEND, excess, 0.0)
        d = dp + sg * excess
        hx, hy = F.xy(s_grid, d)
        head_pts = np.column_stack([hx, hy])
        head_way = np.full(len(s_grid), -1)
        tail_from = k_end + 1
        info.update(s_a=s_a, s_j=s_j, open1=open1, start_road=cws[start[0]]["frame"].id)
    tail_pts = tail_way = None
    if end:
        F = cws[end[0]]["frame"]
        x, y = poly(osm, to_xy, [end[1]])[0]
        s_m = float(F.sd(x, y)[0][0])
        tp = main_taper_near(F, s_m, side, "entrance")
        lim = spec.get("limit_b", F.length)
        if tp and tp[1] + 4 <= lim:
            close0, s_b = tp[0], min(F.length, tp[1] + 4)
        else:
            s_b = min(F.length, lim, s_m + L_PAR_ENTRY)
            close0 = max(s_m, s_b - 4 - min(L_CLOSE, max(40.0, s_b - s_m - 8)))
        sq, dq, off = F.sd(Qr[:, 0], Qr[:, 1])
        s_par, d_par = parallel(F, max(0.0, s_m - 600), s_b)
        k_start = len(Qr) - 1
        while k_start - 1 >= tail_from and off[k_start - 1] < 0.5 and sq[k_start - 1] < sq[k_start]:
            dp = np.interp(sq[k_start - 1], s_par, d_par)
            if sg * (dq[k_start - 1] - dp) > 15:
                break
            k_start -= 1
        s_lo = min(sq[k_start], s_m)
        s_grid = np.arange(s_lo, s_b + 1e-9, 2.0)
        s_grid[-1] = s_b
        dp = np.interp(s_grid, s_par, d_par)
        idx = np.arange(k_start, len(Qr))
        m = np.r_[True, np.diff(sq[idx]) > 0]
        dqi = np.interp(s_grid, sq[idx][m], dq[idx][m]) if m.sum() > 1 else dp
        excess = np.where(s_grid < s_m, np.maximum(0.0, sg * (dqi - dp)), 0.0)
        excess = movavg(excess, int(BLEND) | 1)
        excess = np.where(s_grid < s_m + BLEND, excess, 0.0)
        d = dp + sg * excess
        tx, ty = F.xy(s_grid, d)
        tail_pts = np.column_stack([tx, ty])
        tail_way = np.full(len(s_grid), -1)
        tail_to = k_start
        info.update(s_m=s_m, s_b=s_b, close0=close0, end_road=cws[end[0]]["frame"].id)
    parts, ways = [], []
    if head_pts is not None:
        parts.append(head_pts)
        ways.append(head_way)
    if tail_to > tail_from:
        parts.append(Qr[tail_from:tail_to])
        ways.append(qway[tail_from:tail_to])
    if tail_pts is not None:
        parts.append(tail_pts)
        ways.append(tail_way)
    P = np.concatenate(parts)
    PW = np.concatenate(ways)
    keep = np.r_[True, np.hypot(*np.diff(P, axis=0).T) > 0.5]
    P, PW = P[keep], PW[keep]
    if arclen(P)[-1] < 60:
        return None
    st, fit = stations_of(P)
    # the OSM way of each station
    tree = cKDTree(P)
    _, j = tree.query(np.column_stack([st["x"], st["y"]]))
    info["way"] = PW[j]
    info["fit_max_m"] = round(float(fit.node_distance.max()), 3)
    info["has_start"] = start is not None
    info["nodes"] = list(nodes)
    info["start_gore_node"] = start[1] if start else None
    info["has_end"] = end is not None
    info["end_node"] = None if end else nodes[-1] if start else None
    info["start_node"] = None if start else nodes[0]
    return st, info


def ramp_sections(L, side, n_l, nose_a=None, open1=None, nose_b=None, close0=None):
    """Lane sections of a ramp of length L on `side` of its carriageway (so its gore side, the one
    facing the carriageway, is the other): an opening gore at the start (nose_a: the physical
    nose, open1: the end of the opening taper), a closing one at the end (nose_b, close0), or both."""
    g = "left" if side == "right" else "right"
    o = side
    edge = {"left": "yellow", "right": "white"}
    normal_sh = {"left": RAMP_SL, "right": RAMP_SR}
    placement = "left_of:1" if side == "right" else f"right_of:{n_l}"

    def sec(s0, s1, w, gore):
        sh = {g: {"shoulder": GORE_SL if gore else normal_sh[g], "edge": "white" if gore else edge[g]},
              o: {"shoulder": RAMP_SR if gore else normal_sh[o], "edge": edge[o]}}
        return {"s0": rnd(s0), "s1": rnd(s1), "lanes": [{"w": w, "kind": "ramp"} for _ in range(n_l)],
                "left": sh["left"], "right": sh["right"], "placement": placement,
                "provenance": {"lanes": "osm", "widths": "rule", "crossfall": "rule", "geometry": "gore rule"}}

    out = []
    a = 0.0
    if nose_a is not None:
        out.append(sec(0, 4, 0.05, True))
        out.append(sec(4, nose_a, LANE, True))
        out[-1]["taper"] = {"s0": 4, "s1": rnd(max(8.0, min(open1, nose_a))), "kind": "opening"}
        a = nose_a
    b = L
    if nose_b is not None:
        b = nose_b
    if b - a > 1:
        s = sec(a, b, LANE, False)
        if out and a + SHOULDER_TAPER < b:
            s["taper"] = {"s0": rnd(a), "s1": rnd(a + SHOULDER_TAPER), "kind": "shoulder"}
        out.append(s)
    if nose_b is not None:
        s = sec(b, L - 4, LANE, True)
        if out and b - SHOULDER_TAPER > a:
            s["taper"] = {"s0": rnd(b - SHOULDER_TAPER), "s1": rnd(b), "kind": "shoulder"}
        out.append(s)
        last = sec(L - 4, L, 0.05, True)
        last["taper"] = {"s0": rnd(max(b, min(close0, L - 8))), "s1": rnd(L - 4), "kind": "closing"}
        out.append(last)
    out[0]["s0"] = 0
    out[-1]["s1"] = rnd(L)
    return out


def anchor(F, st, s_node, side):
    """The ramp station nearest the point of its parallel line at the carriageway's chainage s_node."""
    le, ri = F.lane_edges(np.array([s_node]))
    e = le if side == "left" else ri
    sg = -1.0 if side == "right" else 1.0
    x, y = F.xy(np.array([s_node]), e + sg * GORE_GAP)
    return int(np.argmin(np.hypot(st["x"] - x[0], st["y"] - y[0])))


def build_ramp(osm, to_xy, spec, cws, route_tree, rid):
    got = ramp_line(osm, to_xy, spec, cws, route_tree)
    if got is None:
        return None
    st, info = got
    n = len(st["x"])
    L = (n - 1) * SPACING
    side, n_l = info["side"], info["lanes"]
    sg = -1.0 if side == "right" else 1.0
    rs = np.arange(n) * SPACING
    pin = np.full(n, np.nan)
    pin_cf = np.full(n, np.nan)
    gores = []
    nose_a = open1_r = nose_b = close0_r = None

    def gore_data(F):
        s, d, off = F.sd(st["x"], st["y"])
        le, ri = F.lane_edges(s)
        pl, pr = F.edges(s)
        e = le if side == "left" else ri
        sh = np.abs(pl - le) if side == "left" else np.abs(ri - pr)
        sep = sg * (d - e)
        return s, d, off, sep, sh

    if info["has_start"]:
        F = next(cw["frame"] for cw in cws if cw["frame"].id == info["start_road"])
        s, d, off, sep, sh = gore_data(F)
        k_j = anchor(F, st, info["s_j"], side)
        need = sh + RAMP_SL + NOSE_GAP + MARK_HALF * 0  # main shoulder, ramp shoulder and some ground
        ok = (rs > rs[k_j]) & (sep >= need) & (off < 1)
        k_n = int(np.argmax(ok)) if ok.any() else min(n - 1, k_j + int(NOSE_MAX / SPACING))
        k_n = min(k_n, k_j + int(NOSE_MAX / SPACING), n - 3)
        nose_a = rs[k_n]
        open1_r = float(np.interp(info["open1"], s[: k_j + 1], rs[: k_j + 1])) if k_j > 0 else 8.0
        kk = np.arange(0, min(n, k_n + 3))
        p = F.line.at(s[kk])
        pin[kk] = p["h"] + p["crossfall"] * d[kk]
        pin_cf[kk] = p["crossfall"]
        gores.append({"kind": "diverge", "road": F.id, "side": side, "ks": kk[: k_n + 1], "s": s[: k_n + 1],
                      "s0": float(s[0]), "s1": float(s[k_n])})
    if info["has_end"]:
        F = next(cw["frame"] for cw in cws if cw["frame"].id == info["end_road"])
        s, d, off, sep, sh = gore_data(F)
        k_m = anchor(F, st, info["s_m"], side)
        need = sh + RAMP_SL + NOSE_GAP
        ok = (rs < rs[k_m]) & (sep >= need) & (off < 1)
        k_n = (n - 1 - int(np.argmax(ok[::-1]))) if ok.any() else max(0, k_m - int(NOSE_MAX / SPACING))
        k_n = max(k_n, k_m - int(NOSE_MAX / SPACING), 2)
        nose_b = rs[k_n]
        close0_r = float(np.interp(info["close0"], s[k_m:], rs[k_m:])) if k_m < n - 1 else L - 8
        kk = np.arange(max(0, k_n - 2), n)
        p = F.line.at(s[kk])
        pin[kk] = p["h"] + p["crossfall"] * d[kk]
        pin_cf[kk] = p["crossfall"]
        gores.append({"kind": "merge", "road": F.id, "side": side, "ks": np.arange(k_n, n), "s": s[k_n:],
                      "s0": float(s[k_n]), "s1": float(s[-1])})
    if nose_a is not None and nose_b is not None and nose_b - nose_a < 2 * SHOULDER_TAPER + 8:
        return None  # too short to hold both gores

    sections = ramp_sections(L, side, n_l, nose_a, open1_r, nose_b, close0_r)
    layer = np.array([layer_of(osm.ways[w]["tags"]) if w >= 0 else 0 for w in info["way"]])
    dr = Draft(rid, "ramp", "motorway_link", st, sections, RAMP_MPH, layer,
               [int(w) if w >= 0 else None for w in info["way"]])
    dr.osm_bridge = np.array([w >= 0 and osm.ways[w]["tags"].get("bridge") not in (None, "no") for w in info["way"]])
    dr.pin, dr.pin_cf = pin, pin_cf
    dr.free_start = not info["has_start"]
    dr.free_end = not info["has_end"]
    dr.info = info
    dr.gores = gores
    dr.side = side
    # a gore in a median too narrow for it would lie on the other carriageway: leave the ramp out
    P = dr.plan_frame()
    for g in gores:
        ks = np.asarray(g["ks"])
        pts = P.pavement_points(step=SPACING, across=1.0, s0=float(ks.min() * SPACING), s1=float(ks.max() * SPACING))
        for cw in cws:
            if cw["frame"].id == g["road"]:
                continue
            m, _, _ = cw["frame"].inside(pts["x"], pts["y"], grow=0.5)
            if m.any():
                raise ValueError(f"its gore would lie on {cw['frame'].id} (a median ramp with no room)")
    return dr


def build_crossing(osm, to_xy, chain, cws, rid, approach):
    """A road that crosses the route on a bridge, `approach` m beyond its outermost crossing."""
    nodes = chain["nodes"]
    seg = way_tags_per_point(osm, chain["ways"], nodes)
    P, pway = densify(poly(osm, to_xy, nodes), 2.0, seg)
    if chain.get("nodes_twin"):
        Pb, _ = densify(poly(osm, to_xy, chain["nodes_twin"]), 2.0)
        _, k = cKDTree(Pb).query(P)
        P = (P + Pb[k]) / 2
        keep = np.r_[True, np.hypot(*np.diff(P, axis=0).T) > 0.5]
        P, pway = P[keep], [w for w, kk in zip(pway, keep) if kk]
    a = arclen(P)
    inside = np.zeros(len(P), dtype=bool)
    for cw in cws:
        inside |= cw["frame"].inside(P[:, 0], P[:, 1], grow=2.0)[0]
    if not inside.any():
        return None
    a0 = max(0.0, a[inside].min() - approach)
    a1 = min(a[-1], a[inside].max() + approach)
    st = stations_between(P, a0, a1)
    tree = cKDTree(P)
    _, j = tree.query(np.column_stack([st["x"], st["y"]]))
    ways = [pway[k] for k in j]
    t = osm.ways[chain["first"]]["tags"]
    hw = t.get("highway", "road")
    try:
        lanes = int(t.get("lanes", "0"))
        if chain.get("twin"):
            lanes += int(osm.ways[chain["twin"]["first"]]["tags"].get("lanes", "0"))
    except ValueError:
        lanes = 0
    oneway = chain["oneway"]
    if oneway:
        lanes = int(np.clip(lanes or 2, 1, 5))
        sec = {"s0": 0, "s1": rnd((len(st["x"]) - 1) * SPACING),
               "lanes": [{"w": 3.5, "kind": "drive"} for _ in range(lanes)],
               "left": {"shoulder": 0.6, "edge": "yellow"}, "right": {"shoulder": 1.5, "edge": "white"},
               "provenance": {"lanes": "osm" if t.get("lanes") else "rule", "widths": "rule", "crossfall": "rule"}}
    else:
        lanes = int(np.clip(lanes or (4 if hw in ("primary", "trunk") else 2), 2, 8))
        lanes += lanes % 2
        ls = [{"w": 3.5, "kind": "drive"} for _ in range(lanes)]
        ls[lanes // 2 - 1]["line"] = "solid"
        sec = {"s0": 0, "s1": rnd((len(st["x"]) - 1) * SPACING), "lanes": ls,
               "left": {"shoulder": 1.5, "edge": "white"}, "right": {"shoulder": 1.5, "edge": "white"},
               "provenance": {"lanes": "osm" if t.get("lanes") else "rule", "widths": "rule", "crossfall": "rule",
                              "two_way": True}}
    layer = [layer_of(osm.ways[w]["tags"]) if w is not None else 0 for w in ways]
    dr = Draft(rid, "crossing", hw, st, [sec], CROSS_MPH, layer, ways, ref=t.get("ref", ""))
    dr.name = chain["name"]
    dr.osm_bridge = np.array([w is not None and osm.ways[w]["tags"].get("bridge") not in (None, "no") for w in ways])
    dr.nodes = set(nodes) | set(chain.get("nodes_twin") or [])
    dr.free_start = dr.free_end = True
    dr.gores = []
    dr.two_way = not oneway
    if not oneway:
        dr.crossfall_two_way = True
    return dr


# ---------------------------------------------------------------------------------- heights

def exempt(junctions, a_id, a_s, b_id, b_s):
    """Mask of points (a_s on road a, b_s on road b) covered by a junction between the two."""
    m = np.zeros(len(a_s), dtype=bool)
    for j in junctions:
        for x, y in (("a", "b"), ("b", "a")):
            if j[x]["road"] == a_id and j[y]["road"] == b_id:
                m |= (a_s >= j[x]["s0"] - 6) & (a_s <= j[x]["s1"] + 6) & (b_s >= j[y]["s0"] - 6) & (b_s <= j[y]["s1"] + 6)
    return m


def set_crossfall(dr):
    s = np.arange(dr.n) * SPACING
    if getattr(dr, "two_way", False):
        cf = np.zeros(dr.n)  # a crowned two-way road, taken flat across
    else:
        cf = movavg(crossfall_rule(movavg(dr.st["curvature"], 9), dr.mph), 9)
    pinned = np.isfinite(dr.pin_cf)
    if pinned.any():
        # ease from the pinned crossfall to the rule over 40 m beyond the pinned stretch
        kp = np.flatnonzero(pinned)
        dist = np.min(np.abs(s[:, None] - s[kp][None, :]), axis=1)
        nearest = dr.pin_cf[kp[np.argmin(np.abs(s[:, None] - s[kp][None, :]), axis=1)]]
        w = np.clip(dist / 40.0, 0, 1)
        cf = np.where(pinned, dr.pin_cf, (1 - w) * nearest + w * cf)
    dr.crossfall = cf


def bounds_against(dr, built, junctions, layers_of):
    """Lower and upper bounds on dr's reference-line height from every road already built that it
    overlaps in plan, and which stations go over or under what."""
    n = dr.n
    lo = np.full(n, -np.inf)
    hi = np.full(n, np.inf)
    over = np.zeros(n, dtype=bool)
    under_conflict = np.zeros(n, dtype=bool)
    F = dr.plan_frame()
    pts = F.pavement_points(step=SPACING, across=1.0)
    k = np.round(pts["s"] / SPACING).astype(int)
    cf = dr.crossfall[k]
    for B in built:
        m, sb, db = B.inside(pts["x"], pts["y"], grow=0.3)
        if not m.any():
            continue
        m &= ~exempt(junctions, dr.id, pts["s"], B.id, np.nan_to_num(sb))
        if not m.any():
            continue
        zb = B.surface(sb[m], db[m])
        la = dr.layer[k[m]]
        lb = layers_of(B, sb[m])
        kk = k[m]
        goes_over = (la > lb) | ((la == lb) & dr.osm_bridge[kk])
        need_lo = zb + CLR - cf[m] * pts["d"][m]
        need_hi = zb - CLR - cf[m] * pts["d"][m]
        for i in np.unique(kk[goes_over]):
            sel = goes_over & (kk == i)
            lo[i] = max(lo[i], need_lo[sel].max())
            over[i] = True
        if getattr(B, "estimate", False):
            continue  # a ramp not built yet: only to be cleared, never to pass under
        if (~goes_over).any():
            dr.under_ids = getattr(dr, "under_ids", set()) | {B.id}
        for i in np.unique(kk[~goes_over]):
            sel = ~goes_over & (kk == i)
            hi[i] = min(hi[i], need_hi[sel].min())
            if B.road.get("role", "main") == "main" or getattr(B, "fixed", False):
                under_conflict[i] = True
    return lo, hi, over, under_conflict


def solve_profile(dr, ground, built, junctions, layers_of, grade=GRADE, pin_ends=False):
    """Set dr.h. Returns None on success, else the first station of an impossible stretch."""
    set_crossfall(dr)
    s = np.arange(dr.n) * SPACING
    secs = normalise_sections(dr.sections)
    left, right = pavement_edges(secs, s)
    st = {"x": dr.st["x"], "y": dr.st["y"], "heading": dr.st["heading"], "crossfall": dr.crossfall}
    env = envelope(st, left, right, ground, clearance=CLEARANCE, margin=MARGIN, across=1.0)
    lo_b, hi_b, over, under = bounds_against(dr, built, junctions, layers_of)
    lower = np.maximum(env, lo_b)
    upper = hi_b.copy()
    pinned = np.isfinite(dr.pin)
    # a pin wins over the ground; past it the ground gives way to the highest profile the grade
    # and vertical-curve limits can reach from the pin's own slope
    if pinned.any():
        R = (dr.mph * MPH) ** 2 / COMFORT
        reach = np.full(dr.n, np.inf)
        for i in np.flatnonzero(pinned):
            for step in (1, -1):
                j = i + step
                if not (0 <= j < dr.n) or pinned[j]:
                    continue
                prev = i - step
                g = (dr.pin[i] - dr.pin[prev]) / SPACING if 0 <= prev < dr.n and pinned[prev] else 0.0
                z = dr.pin[i]
                while 0 <= j < dr.n and not pinned[j]:
                    g = min(grade, g + SPACING / R)
                    z += g * SPACING
                    reach[j] = min(reach[j], z - 0.05)
                    j += step
        free = lo_b == -np.inf
        lower = np.where(free, np.minimum(lower, reach), lower)
        lower[pinned] = dr.pin[pinned]
        upper[pinned] = dr.pin[pinned]
    # under a road: the ground gives way too (the road is cut down to pass)
    soft = np.isfinite(upper) & (upper < lower) & ~pinned
    lower[soft] = np.minimum(lower[soft], upper[soft])
    if pin_ends:
        for i in (0, 1, dr.n - 2, dr.n - 1):
            if not pinned[i] and not np.isfinite(hi_b[i]):
                upper[i] = max(lower[i], env[i] + 1.5)
    dr.env = env
    dr.over = over
    bad = np.flatnonzero(under & ~pinned)
    if len(bad):
        dr.bad_last = int(bad[-1])
        return int(bad[0])
    R = (dr.mph * MPH) ** 2 / COMFORT
    z = smooth_between(lower, upper, SPACING, grade, R)
    if z is None:
        # say why, for the report: which bounds make it impossible
        lo_only = np.where(np.isfinite(lo_b), lower, np.where(pinned, lower, env))
        why = []
        if smooth_between(np.where(pinned, lower, -1e6), np.where(pinned, upper, np.inf), SPACING, grade, R) is None:
            why.append("pins")
        elif smooth_between(np.where(pinned | np.isfinite(lo_b), lower, -1e6), np.where(pinned, upper, np.inf), SPACING, grade, R) is None:
            k = np.flatnonzero(np.isfinite(lo_b))
            why.append(f"over another road at s {k.min() * SPACING:.0f}-{k.max() * SPACING:.0f}")
        elif smooth_between(lower, np.where(pinned, upper, np.inf), SPACING, grade, R) is None:
            why.append("ground")
        else:
            k = np.flatnonzero(np.isfinite(hi_b))
            why.append(f"under {sorted(getattr(dr, 'under_ids', []))} at s {k.min() * SPACING:.0f}-{k.max() * SPACING:.0f}" if len(k) else "ends")
        _ = lo_only
        dr.notes.append("; ".join(why))
        return -1
    dr.h = z
    return None


# ---------------------------------------------------------------------------------- the whole build

def _layer_array(F):
    """OSM layer per station of a carriageway: 1 on its bridges, else 0."""
    s = np.arange(len(F.x)) * F.spacing
    lay = np.zeros(len(s), dtype=np.int64)
    for b in F.road.get("bridges", []):
        lay[(s >= b["s0"] - 2) & (s <= b["s1"] + 2)] = 1
    return lay


def _layers_of(F, s):
    k = np.clip(np.round(np.asarray(s) / F.spacing).astype(int), 0, len(F.layer_arr) - 1)
    return F.layer_arr[k]


def _frame_of(dr):
    F = dr.frame()
    F.layer_arr = dr.layer
    F.draft = dr
    return F


def split_from(dr, branch_of, junctions):
    """A crossing road that branches off (or into) a ramp: cut it where it clears the ramp's
    pavement, pin its end to the ramp's surface there, and record the junction. Returns the
    pins the ramp needs later, or None if nothing is left of the road."""
    out = []
    for E, end in branch_of:
        m, sb, db = E.inside(dr.st["x"], dr.st["y"], grow=0.5)
        if not m.any():
            continue
        if end == "start":
            k = len(m) - 1 - int(np.argmax(m[::-1])) if m[: max(1, len(m) // 2)].any() else -1
            if k < 0:
                continue
            if dr.n - (k + 1) < 20:
                return None
            dr.trim(k + 1, dr.n - 1, junctions)
            kk = [0, 1]
        else:
            half = len(m) // 2
            if not m[half:].any():
                continue
            k = half + int(np.argmax(m[half:]))
            if k - 1 < 20:
                return None
            dr.trim(0, k - 1, junctions)
            kk = [dr.n - 2, dr.n - 1]
        sb2, db2, _ = E.sd(dr.st["x"][kk], dr.st["y"][kk])
        dr.pin[kk] = E.surface(sb2, db2)
        L = dr.length
        junctions.append({"id": f"{dr.id}.split{len(out)}", "kind": "connect", "side": "",
                          "a": {"road": E.id, "s0": round(float(max(0.0, sb2.min() - 60)), 2), "s1": round(float(min(E.length, sb2.max() + 60)), 2)},
                          "b": {"road": dr.id, "s0": 0.0 if end == "start" else max(0.0, L - 40.0),
                                "s1": min(L, 40.0) if end == "start" else L}})
        out.append((E.draft, dr, end))
    return out


def _gore_record(dr, g, k):
    ks = g["ks"]
    rs = ks * SPACING
    sel = np.r_[np.arange(0, len(ks), 2), len(ks) - 1] if len(ks) > 2 else np.arange(len(ks))
    sel = np.unique(sel)
    ga, gb = [], []
    for a, b in zip(np.asarray(g["s"])[sel], rs[sel]):
        a, b = round(float(a), 2), round(float(b), 2)
        if not ga or (a > ga[-1] + 0.05 and b > gb[-1] + 0.05):
            ga.append(a)
            gb.append(b)
    rec = {"id": f"{dr.id}.{'g' if g['kind'] == 'diverge' else 'm'}{k}", "kind": g["kind"], "side": g["side"],
           "a": {"road": g["road"], "s0": round(float(g["s"][0]), 2), "s1": round(float(g["s"][-1]), 2)},
           "b": {"road": dr.id, "s0": round(float(rs[0]), 2), "s1": round(float(rs[-1]), 2)}}
    if len(ga) >= 2:
        rec["gore"] = {"a": ga, "b": gb}
    return rec


def _ramp_name(cws, spec, used_ids):
    k, n = spec["start"] or spec["end"]
    cw = cws[k]
    F = cw["frame"]
    links = cw.get("links", [])
    # the exit ref of the nearest junction on that carriageway
    near = None
    if links:
        x, y = cw["xy"](n)
        s = float(F.sd(x, y)[0][0])
        e = min(links, key=lambda e: abs(e["s"] - s))
        if abs(e["s"] - s) < 2500 and e.get("ref"):
            near = e["ref"]
    base = f"{cw['prefix']}.x{near or 'km' + str(int(round(float(F.sd(*cw['xy'](n))[0][0]) / 1000)))}"
    base += ".off" if spec["start"] else ".on"
    rid, j = base, 1
    while rid in used_ids:
        j += 1
        rid = f"{base}{j}"
    used_ids.add(rid)
    return rid


def build_interchanges(osm, cws, to_xy, ground, log=print, own_ref=None):
    """Ramps, crossing roads, junctions and structures around carriageways `cws`
    ([{"frame": RoadFrame of the decoded road, "ids", "ways", "prefix", "links"}]); own_ref is the
    route's road reference ("I 15", the default).
    Returns {"roads": [writer dicts], "junctions", "structures", "embankment": {road id: [...]},
    "report": {...}}."""
    for cw in cws:
        cw["frame"].layer_arr = _layer_array(cw["frame"])
        cw["frame"].fixed = True
        cw["xy"] = lambda n: tuple(poly(osm, to_xy, [n])[0])
    route_tree = cKDTree(np.vstack([np.column_stack([cw["frame"].x, cw["frame"].y]) for cw in cws]))
    report = {"ramps": [], "crossings": [], "dropped": [], "simplified": []}
    specs, ramp_ways = find_ramps(osm, cws, to_xy)
    chains = find_crossings(osm, cws, to_xy, ramp_ways, own_ref)
    log(f"  interchanges: {len(specs)} ramp chains, {len(chains)} crossing chains")
    weave_limits(osm, to_xy, specs, cws)
    built = [cw["frame"] for cw in cws]
    junctions = []
    drafts = []
    used_ids = {cw["frame"].id for cw in cws}

    # ramps in plan first: the crossing roads must clear the ones that pass under them
    ramps = []
    for spec in specs:
        rid = _ramp_name(cws, spec, used_ids)
        try:
            dr = build_ramp(osm, to_xy, spec, cws, route_tree, rid)
        except (ValueError, RuntimeError) as ex:
            report["dropped"].append({"road": rid, "why": f"geometry: {ex}",
                                      **({"node": f"n{spec['start'][1]}"} if spec["start"] else {})})
            continue
        if dr is None:
            report["dropped"].append({"road": rid, "why": "too short to build"})
            continue
        for k, g in enumerate(dr.gores):
            junctions.append(_gore_record(dr, g, k))
        ramps.append(dr)
    estimates = []
    for dr in ramps:
        if solve_profile(dr, ground, built, junctions, _layers_of, grade=RAMP_GRADE) is None:
            F = _frame_of(dr)
            F.estimate = True
            F.ends = {dr.info.get("end_node"), dr.info.get("start_node")} - {None}
            F.nodes = set(dr.info.get("nodes", []))
            estimates.append(F)
        dr.h = None

    # crossing roads, lowest layer first, streets before link flyovers
    pending_pins = []  # (ramp draft, crossing draft, which end of the crossing): pin the ramp where a branch leaves it
    cross = []
    for ch in chains:
        name = slug(ch["name"])
        rid, j = f"x.{name}", 1
        while rid in used_ids:
            j += 1
            rid = f"x.{name}.{j}"
        used_ids.add(rid)
        cross.append((rid, ch))
    order = sorted(cross, key=lambda rc: (max(layer_of(osm.ways[w]["tags"]) for w in rc[1]["ways"]),
                                          osm.ways[rc[1]["first"]]["tags"].get("highway", "").endswith("_link")))
    for rid, ch in order:
        done = None
        chain_nodes = set(ch["nodes"]) | set(ch.get("nodes_twin") or [])
        under = [E for E in estimates if not (E.ends & chain_nodes) and not (E.nodes & {ch["nodes"][0], ch["nodes"][-1]})]
        branch_of = [(E, end) for E in estimates for end, n in (("start", ch["nodes"][0]), ("end", ch["nodes"][-1]))
                     if n in E.nodes]
        for approach, grade, ends in ((APPROACH, GRADE, True), (APPROACH_MAX, GRADE, True), (APPROACH_MAX, 0.07, True),
                                      (APPROACH_LONG, 0.07, True), (APPROACH_LONG, 0.08, True)):
            dr = build_crossing(osm, to_xy, ch, cws, rid, approach)
            if dr is None:
                break
            # where it is over a carriageway it is a level above it
            for cw in cws:
                m, sc, _ = cw["frame"].inside(dr.st["x"], dr.st["y"], grow=15.0)
                if m.any():
                    k = np.flatnonzero(m)
                    dr.layer[k] = np.maximum(dr.layer[k], _layers_of(cw["frame"], sc[k]) + 1)
                    dr.osm_bridge[k] = True
            splits = split_from(dr, branch_of, junctions)
            if splits is None:
                break
            r = solve_profile(dr, ground, built + under, junctions, _layers_of, grade=grade, pin_ends=ends)
            if r is None:
                done = dr
                pending_pins.extend(splits)
                if (approach, grade) != (APPROACH, GRADE):
                    report["simplified"].append({"road": rid, "why": f"approach {approach} m, grade {grade}"
                                                 + ("" if ends else ", ends not brought to the ground")})
                break
        if done is None and dr is not None:
            # too tangled to keep its mapped level: it goes over everything here
            dr.layer[:] = 9
            if solve_profile(dr, ground, built + under, junctions, _layers_of, grade=0.08, pin_ends=True) is None:
                done = dr
                pending_pins.extend(splits or [])
                report["simplified"].append({"road": rid, "why": "over everything it meets (its mapped level does not fit)"})
        if done is None:
            why = "no profile clears the route with both ends on the ground: " + "; ".join(dr.notes if dr else [])
            if branch_of:
                why = "a branch of a ramp, too tangled to build by rule (" + why + ")"
            report["dropped"].append({"road": rid, "name": ch["name"], "why": why, "branch": bool(branch_of)})
            continue
        F = _frame_of(done)
        built.append(F)
        drafts.append(done)

    crossing_drafts = [d for d in drafts if d.role == "crossing"]
    # a free end on a crossing road we built: stop at its pavement and meet its surface
    for dr in ramps:
        for end in ("end", "start"):
            node = dr.info.get(f"{end}_node")
            if node is None or not (dr.free_end if end == "end" else dr.free_start):
                continue
            B = next((F for F in built if getattr(F, "draft", None) in crossing_drafts and node in F.draft.nodes), None)
            if B is None:
                continue
            m, sb, db = B.inside(dr.st["x"], dr.st["y"], grow=0.5)
            if not m.any():
                continue
            if end == "end":
                k_in = int(np.argmax(m))
                k1 = max(2, k_in - 1)
                dr.trim(0, k1, junctions)
                kk = [dr.n - 2, dr.n - 1]
            else:
                k_in = len(m) - 1 - int(np.argmax(m[::-1]))
                k0 = min(dr.n - 3, k_in + 1)
                dr.trim(k0, dr.n - 1, junctions)
                kk = [0, 1]
            sb2, db2, _ = B.sd(dr.st["x"][kk], dr.st["y"][kk])
            dr.pin[kk] = B.surface(sb2, db2)
            p = B.line.at(sb2)
            dr.pin_cf[kk] = p["crossfall"] if np.cos(p["heading"][0] - dr.st["heading"][kk[0]]) > 0 else -p["crossfall"]
            L = dr.length
            junctions.append({"id": f"{dr.id}.c", "kind": "connect", "side": "",
                              "a": {"road": B.id, "s0": round(float(max(0.0, sb2.min() - 25)), 2), "s1": round(float(min(B.length, sb2.max() + 25)), 2)},
                              "b": {"road": dr.id, "s0": (L - 30.0) if end == "end" else 0.0,
                                    "s1": L if end == "end" else 30.0}})

    for E_dr, X, end in pending_pins:
        if X.h is None:
            continue
        k = 0 if end == "start" else X.n - 1
        d2 = (E_dr.st["x"] - X.st["x"][k]) ** 2 + (E_dr.st["y"] - X.st["y"][k]) ** 2
        i = int(np.argmin(d2))
        lo_i, hi_i = max(0, i - 1), min(E_dr.n, i + 2)
        if not np.isfinite(E_dr.pin[lo_i:hi_i]).any():
            E_dr.pin[lo_i:hi_i] = X.h[k] - 0.0
    ramps.sort(key=lambda d: int(d.layer.max()))
    for dr in ramps:
        ok = False
        for attempt in range(5):
            r = solve_profile(dr, ground, built, junctions, _layers_of, grade=RAMP_GRADE)
            if r is None:
                ok = True
                break
            if attempt == 0 and (r >= 0 or (dr.notes and dr.notes[-1].startswith("under"))):
                keep_layer = dr.layer.copy()
                lifted = np.where(np.arange(dr.n) * SPACING > 0, 9, dr.layer)
                lifted[np.isfinite(dr.pin)] = keep_layer[np.isfinite(dr.pin)]
                dr.layer = lifted
                if solve_profile(dr, ground, built, junctions, _layers_of, grade=RAMP_GRADE) is None:
                    ok = True
                    report["simplified"].append({"road": dr.id, "why": "over everything it meets (its mapped level does not fit)"})
                    break
                dr.layer = keep_layer
            # impossible: end the ramp before the trouble, at its free end
            k = r if r >= 0 else int(dr.n * 0.75)
            if dr.free_end and not dr.free_start or (dr.free_end and k > dr.n / 2):
                k1 = k - 6 if r >= 0 else k
                if k1 < 20:
                    break
                dr.trim(0, k1, junctions)
            elif dr.free_start:
                k0 = getattr(dr, "bad_last", k) + 6 if r >= 0 else dr.n - k
                if dr.n - k0 < 20:
                    break
                dr.trim(k0, dr.n - 1, junctions)
            else:
                break
            report["simplified"].append({"road": dr.id, "why": "ends before a road it would have to pass under"
                                         if r >= 0 else "shortened until a profile fits: " + (dr.notes[-1] if dr.notes else ""),
                                         "length_m": dr.length})
        if not ok:
            report["dropped"].append({"road": dr.id, "why": "no profile: " + "; ".join(dr.notes[-2:])})
            junctions[:] = [j for j in junctions if dr.id not in (j["a"]["road"], j["b"]["road"])]
            continue
        built.append(_frame_of(dr))
        drafts.append(dr)

    # same-level overlaps at a ramp's free end: stop the ramp short of the other pavement
    from .structures import plan_overlaps
    for _ in range(3):
        frames = built
        ov = plan_overlaps(frames, junctions)
        changed = False
        for v in ov["violations"]:
            for me, other, key in (("a", "b", "a_s"), ("b", "a", "b_s")):
                F = next(f for f in frames if f.id == v[me])
                dr = getattr(F, "draft", None)
                if dr is None or dr.role != "ramp":
                    continue
                s_lo, s_hi = v[key]
                if dr.free_end and s_lo > dr.length * 0.5:
                    k1 = int(s_lo / SPACING) - 3
                    if k1 > 20:
                        dr.trim(0, k1, junctions)
                        changed = True
                        report["simplified"].append({"road": dr.id, "why": f"stops short of {v[other]}", "length_m": dr.length})
                        break
                if dr.free_start and s_hi < dr.length * 0.5:
                    k0 = int(np.ceil(s_hi / SPACING)) + 3
                    if dr.n - k0 > 20:
                        dr.trim(k0, dr.n - 1, junctions)
                        changed = True
                        report["simplified"].append({"road": dr.id, "why": f"starts clear of {v[other]}", "length_m": dr.length})
                        break
            else:
                # neither end alone: an overlap over more than half a ramp that reaches its free end
                # (two link chains that run together before they meet) is cut back from that end
                for me, other, key in (("a", "b", "a_s"), ("b", "a", "b_s")):
                    F = next(f for f in frames if f.id == v[me])
                    dr = getattr(F, "draft", None)
                    if dr is None or dr.role != "ramp":
                        continue
                    s_lo, s_hi = v[key]
                    if dr.free_end and s_hi >= dr.length - 2 * SPACING and int(s_lo / SPACING) - 3 > 20:
                        dr.trim(0, int(s_lo / SPACING) - 3, junctions)
                        changed = True
                        report["simplified"].append({"road": dr.id, "why": f"stops short of {v[other]}", "length_m": dr.length})
                        break
                    if dr.free_start and s_lo <= 2 * SPACING and dr.n - (int(np.ceil(s_hi / SPACING)) + 3) > 20:
                        dr.trim(int(np.ceil(s_hi / SPACING)) + 3, dr.n - 1, junctions)
                        changed = True
                        report["simplified"].append({"road": dr.id, "why": f"starts clear of {v[other]}", "length_m": dr.length})
                        break
                else:
                    # a ramp that lies on another's pavement over most of its length (a link that
                    # joins another ramp just before the carriageway) is that ramp: left out
                    for me, other, key in (("a", "b", "a_s"), ("b", "a", "b_s")):
                        F = next(f for f in frames if f.id == v[me])
                        dr = getattr(F, "draft", None)
                        if dr is None or dr.role != "ramp" or dr not in drafts:
                            continue
                        s_lo, s_hi = v[key]
                        if s_hi - s_lo >= 0.5 * dr.length:
                            drafts.remove(dr)
                            junctions[:] = [j for j in junctions if dr.id not in (j["a"]["road"], j["b"]["road"])]
                            report["dropped"].append({"road": dr.id, "why": f"runs on the pavement of {v[other]} over most of its length"})
                            changed = True
                            break
        if not changed:
            break
        built = [cw["frame"] for cw in cws] + [_frame_of(d) for d in drafts]

    built = [cw["frame"] for cw in cws] + [_frame_of(d) for d in drafts]
    # what is left of same-level overlaps between two ramps: a few metres of two pavements in one
    # plane where their gore stretches meet. They are two roads meeting: a connect junction
    for v in plan_overlaps(built, junctions)["violations"]:
        if v["dz_m"] > 0.1 or v["a_s"][1] - v["a_s"][0] > 12 or v["b_s"][1] - v["b_s"][0] > 12:
            continue
        roles = [getattr(getattr(F, "draft", None), "role", None) for F in built if F.id in (v["a"], v["b"])]
        if roles != ["ramp", "ramp"]:
            continue
        La, Lb = (next(F.length for F in built if F.id == v[k]) for k in ("a", "b"))
        junctions.append({"id": f"{v['a']}.{v['b'].split('.', 1)[-1]}.c", "kind": "connect", "side": "",
                          "a": {"road": v["a"], "s0": round(max(0.0, v["a_s"][0] - 4), 2), "s1": round(min(La, v["a_s"][1] + 4), 2)},
                          "b": {"road": v["b"], "s0": round(max(0.0, v["b_s"][0] - 4), 2), "s1": round(min(Lb, v["b_s"][1] + 4), 2)}})
        report["simplified"].append({"road": v["a"], "why": f"meets {v['b']} in one plane over a few metres (a connect junction)"})
    from .structures import deck_spans, embankment_room, piers_and_abutments
    structures = []
    for F in built[len(cws):]:
        dr = F.draft
        spans = deck_spans(F, built, ground, dr.osm_bridge)
        dr.bridges = [{"s0": rnd(a), "s1": rnd(b), "kind": "bridge", "deck": True} for a, b in spans]
        structures += piers_and_abutments(F, spans, built, ground)
    # frames again, now with decks (a deck carries no embankment)
    all_draft_xy = np.vstack([np.column_stack([d.st["x"], d.st["y"]]) for d in drafts]) if drafts else np.zeros((0, 2))
    dtree = cKDTree(all_draft_xy) if len(all_draft_xy) else None
    embank = {}
    for F in built:
        near = None
        if getattr(F, "fixed", False) and dtree is not None:
            dd, _ = dtree.query(np.column_stack([F.x, F.y]), distance_upper_bound=120.0)
            near = np.isfinite(dd)
        # the carriageways' embankments among themselves are as they were: only new roads count
        others = [B for B in built if not (getattr(F, "fixed", False) and getattr(B, "fixed", False))]
        rooms = embankment_room(F, others, near)
        dr = getattr(F, "draft", None)
        if dr is not None:
            # no embankment over a deck anyway: drop rooms inside the spans
            rooms = [r for r in rooms if not any(b["s0"] <= r["s0"] and r["s1"] <= b["s1"] for b in dr.bridges)]
        if rooms:
            embank[F.id] = rooms
    roads = []
    for dr in drafts:
        r = dr.road()
        if dr.id in embank:
            r["embankment"] = embank[dr.id]
        if getattr(dr, "name", None):
            r["name"] = dr.name
        if dr.role == "ramp" and dr.info.get("start_gore_node"):
            r["_start_node"] = f"n{dr.info['start_gore_node']}"
        roads.append(r)
        entry = {"road": dr.id, "length_m": dr.length, "lanes": len(dr.sections[0]["lanes"]),
                 "decks": len(dr.bridges), "max_layer": int(dr.layer.max())}
        if dr.role == "ramp":
            entry.update(side=dr.side, gore_start=not dr.free_start, gore_end=not dr.free_end,
                         fit_max_m=dr.info.get("fit_max_m"))
            report["ramps"].append(entry)
        else:
            p = dr.frame().line.at(np.arange(dr.n) * SPACING)
            entry.update(name=getattr(dr, "name", ""), top_h=round(float(p["h"].max()), 1))
            report["crossings"].append(entry)
    main_embank = {cw["frame"].id: embank.get(cw["frame"].id, []) for cw in cws}
    # junctions of roads that were left out, and those of earlier attempts at a road, go
    have = {F.id for F in built}
    last = {}
    for j in junctions:
        if j["a"]["road"] in have and j["b"]["road"] in have:
            last[j["id"]] = j
    junctions[:] = list(last.values())
    return {"roads": roads, "junctions": junctions, "structures": structures, "main_embankment": main_embank,
            "frames": built, "report": report}
