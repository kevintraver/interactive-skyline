"""How a route's drawn road surfaces lie over and against each other, measured on the built RoadNet (plan 02, D3.4
and section 7.2's rules). Two measures, each a list of findings that name the roads and their chainages:

- deck_clearances: wherever one road's pavement lies over another's in plan (more than UNDER m above it), the upper
  road is on a deck there and its soffit (DECK under its surface) clears the lower pavement by CLEAR_MIN;
- close_overlaps: wherever two pavements overlap in plan less than SEPARATE m apart vertically, outside a gore (a
  diverge or merge junction with a gore, where the reader hides the carriageway's shoulder under the ramp), the
  overlap is one road's end meeting the other: it lies within END m of an end of one of them (a ramp at a street, a
  lead at its carriageway, a branch leaving a ramp). Anywhere else two surfaces are drawn along or through each other
  in one plane, and flicker where they nearly coincide.

    from lib.layers import load_frames, deck_clearances, close_overlaps
    doc, frames = load_frames("lv", "i15s")
    bad = [f for f in deck_clearances(frames) if not f["ok"]]
"""
import json
from pathlib import Path

import numpy as np

from .roadframe import RoadFrame
from .roadnet import decode_roadnet

ROOT = Path(__file__).resolve().parents[2]

DECK = 1.2  # m from a deck's surface to its soffit (lib.interchanges, lib.structures)
CLEAR_MIN = 4.9  # m under a deck's soffit (section 7.2 [R7])
SEPARATE = 4.9  # m between surfaces that overlap in plan, outside a junction (format.js)
UNDER = 1.0  # m: a pavement this far below another, where they overlap in plan, passes under it
END = 30.0  # m from a road's end within which an overlap closer than SEPARATE is that end meeting the other road
STEP, ACROSS, SHRINK = 2.0, 1.0, 0.05  # sampling of the pavement, and the edge band where two pavements touch


def load_frames(city, route, root=ROOT):
    """(roadnet doc, [RoadFrame]) of one route's RoadNet in public/data/<city>."""
    folder = Path(root) / "public" / "data" / city
    entry = next(r for r in json.loads((folder / "routes.json").read_text())["routes"] if r["id"] == route)
    rn = entry["files"]["roadnet"]
    doc = json.loads((folder / rn).read_text())
    roads = decode_roadnet(doc, (folder / rn.replace(".json", ".bin")).read_bytes())
    return doc, [RoadFrame(r) for r in roads]


def _pairs(frames):
    """For each pair of roads whose pavements overlap in plan: (A, B, A's points there, B's s and d under them)."""
    pts = {F.id: F.pavement_points(step=STEP, across=ACROSS) for F in frames}
    for i, A in enumerate(frames):
        pa = pts[A.id]
        for B in frames[i + 1:]:
            m, sb, db = B.inside(pa["x"], pa["y"], grow=-SHRINK)
            if not m.any():
                continue
            le, ri = A.edges(pa["s"][m])
            inner = (pa["d"][m] < le - SHRINK) & (pa["d"][m] > ri + SHRINK)
            mm = np.flatnonzero(m)[inner]
            if len(mm):
                yield A, B, {k: v[mm] for k, v in pa.items()}, sb[mm], db[mm]


def _decks(F):
    return [(b["s0"], b["s1"]) for b in F.road.get("bridges", []) if b.get("deck")]


def _on(spans, s):
    m = np.zeros(len(s), dtype=bool)
    for a, b in spans:
        m |= (s >= a - 1e-6) & (s <= b + 1e-6)
    return m


def _rng(v):
    return [round(float(v.min()), 1), round(float(v.max()), 1)]


def deck_clearances(frames):
    """One finding per pair of roads where one passes under the other: the clearance under the upper road's soffit
    (its lowest), whether the upper road is on a deck over all of it, and `ok`."""
    out = []
    for A, B, pa, sb, db in _pairs(frames):
        zb = B.surface(sb, db)
        dz = pa["z"] - zb
        for up, low, s_up, s_low, gap in ((A, B, pa["s"], sb, dz), (B, A, sb, pa["s"], -dz)):
            m = gap > UNDER
            if not m.any():
                continue
            clear = gap[m] - DECK
            decked = _on(_decks(up), s_up[m])
            k = int(np.argmin(clear))
            out.append({"upper": up.id, "upper_s": _rng(s_up[m]), "lower": low.id, "lower_s": _rng(s_low[m]),
                        "at": {"upper_s": round(float(s_up[m][k]), 1), "lower_s": round(float(s_low[m][k]), 1)},
                        "clearance_m": round(float(clear.min()), 2), "on_deck": bool(decked.all()),
                        "ok": bool(clear.min() >= CLEAR_MIN - 1e-3 and decked.all())})
    return out


def _gored(junctions, a, sa, b, sb, pad=6.0):
    m = np.zeros(len(sa), dtype=bool)
    for j in junctions:
        if not j.get("gore"):
            continue
        for x, y in (("a", "b"), ("b", "a")):
            if j[x]["road"] == a and j[y]["road"] == b:
                m |= ((sa >= j[x]["s0"] - pad) & (sa <= j[x]["s1"] + pad)
                      & (sb >= j[y]["s0"] - pad) & (sb <= j[y]["s1"] + pad))
    return m


def _runs(s, gap):
    """Index groups of sorted chainages s split where they jump by more than `gap`."""
    order = np.argsort(s)
    cut = np.flatnonzero(np.diff(s[order]) > gap) + 1
    return np.split(order, cut)


def _at_end(s, length):
    return bool(s.max() <= END or s.min() >= length - END)


def close_overlaps(frames, junctions):
    """One finding per stretch where two pavements overlap in plan closer than SEPARATE vertically, outside a gore:
    its chainages on both roads, its length (the longer extent of the two), the least and the median vertical gap,
    and `ok` (it lies within END of an end of one of the two roads)."""
    out = []
    for A, B, pa, sb, db in _pairs(frames):
        dz = np.abs(pa["z"] - B.surface(sb, db))
        m = (dz < SEPARATE) & ~_gored(junctions, A.id, pa["s"], B.id, sb)
        if not m.any():
            continue
        sa, sbb, dzm = pa["s"][m], sb[m], dz[m]
        for g in _runs(sa, 3 * STEP):
            length = max(float(np.ptp(sa[g])), float(np.ptp(sbb[g])))
            out.append({"a": A.id, "a_s": _rng(sa[g]), "b": B.id, "b_s": _rng(sbb[g]), "length_m": round(length, 1),
                        "dz_min_m": round(float(dzm[g].min()), 2), "dz_median_m": round(float(np.median(dzm[g])), 2),
                        "ok": _at_end(sa[g], A.length) or _at_end(sbb[g], B.length)})
    return out
