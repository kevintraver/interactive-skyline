"""Overhead guide signs and the structures that carry them (plan 02, D3.7; MUTCD 2E.24 and 2A.18).

A guide sign goes overhead where the road has four or more lanes, or for a left exit, as on the
real road. Its panel hangs over the lanes it governs (the right lanes for a right exit, its right
edge over the right edge of the rightmost lane; mirrored for a left exit), its bottom MOUNT metres
above the pavement under it, at least 17 ft clear everywhere. The structure is a simple box truss
on columns outside the shoulders: a cantilever from one column when the panel lies within REACH
of it, else a full span with its second column in the median (in the median barrier where there
is one), else a long cantilever when the median has no room.

    from lib.roadside_overhead import is_overhead, overhead_place
"""
import numpy as np

from .roadside_place import edges_at

FT = 0.3048
MOUNT = 5.6  # m, panel bottom above the pavement under its centre (>= 17 ft + crossfall + margin)
MIN_CLEAR = 17 * FT
COLUMN_OUT = 1.8  # m outside the shoulder edge
COLUMN_W = 0.5
REACH = 12.0  # m: longest cantilever arm from the column to the panel's far edge
LONG_REACH = 22.0  # m: what a cantilever may reach when the median has no room for a column
MEDIAN_MIN = 1.2  # m of clear median a column needs
TIP = 0.5  # m the truss runs past the far edge of the panel


def is_overhead(kind, exit_side, lanes):
    return kind in ("advance", "exit", "sequence") and (exit_side == "left" or lanes >= 4)


def lanes_at(road, s):
    return len(next((x for x in road["sections"] if x["s0"] <= s <= x["s1"]), road["sections"][-1])["lanes"])


def _section(road, s):
    return next((x for x in road["sections"] if x["s0"] <= s <= x["s1"]), road["sections"][-1])


def lane_edges(road, s):
    """(left edge of the leftmost lane, right edge of the rightmost lane) at s, from the shoulder edges."""
    left, right = edges_at(road, s)
    sec = _section(road, s)
    n = len(sec["lanes"])
    sl = (sec.get("left") or {}).get("shoulder", 3.05 if n >= 3 else 1.22)
    sr = (sec.get("right") or {}).get("shoulder", 3.05)
    return left - sl, right + sr


def overhead_place(road, geom, rec, pavements, median_offset, clear_at):
    """Panel position and structure for an overhead sign record. Returns (d, structure) with d the
    panel centre's offset from the reference line (positive left) and structure a dict:
    {"kind": "cantilever"|"span", "s", "cols": [d, ...], "d0", "d1"} where cols are the column
    offsets and [d1, d0] the truss's extent (d0 > d1)."""
    s = rec["s"]
    ll, lr = lane_edges(road, s)
    left, right = edges_at(road, s)
    w = rec["w"]
    if rec["side"] == "left":
        d = ll - w / 2
        far = d - w / 2  # the panel's edge farthest from the left column
    else:
        d = lr + w / 2
        far = d + w / 2
    col_r = _column(geom, pavements, s, "right", COLUMN_OUT, right)
    med = None
    clear = clear_at(s)
    if np.isfinite(clear) and clear >= MEDIAN_MIN:
        o = median_offset(s)
        med = left + (o if o is not None else clear / 2)
    if rec["side"] == "left":
        if med is not None and med - (d - w / 2) <= REACH:
            st = {"kind": "cantilever", "cols": [med], "d0": med, "d1": d - w / 2 - TIP}
        elif med is not None:
            st = {"kind": "span", "cols": [col_r, med], "d0": med, "d1": col_r}
        else:
            st = {"kind": "cantilever", "cols": [col_r], "d0": d + w / 2 + TIP, "d1": col_r}
    else:
        if far - col_r <= REACH:
            st = {"kind": "cantilever", "cols": [col_r], "d0": far + TIP, "d1": col_r}
        elif med is not None:
            st = {"kind": "span", "cols": [col_r, med], "d0": med, "d1": col_r}
        else:
            st = {"kind": "cantilever", "cols": [col_r], "d0": min(far + TIP, col_r + LONG_REACH), "d1": col_r}
    st["s"] = s
    st = {k: (round(v, 2) if isinstance(v, float) else [round(c, 2) for c in v] if isinstance(v, list) else v) for k, v in st.items()}
    return round(d, 2), st


def _column(geom, pavements, s, side, out, edge):
    """A column's offset on `side`: COLUMN_OUT outside the shoulder edge, pushed farther out (up to
    25 m) while it would stand on another road's pavement."""
    sgn = 1.0 if side == "left" else -1.0
    for extra in np.arange(0.0, 25.0, 0.5):
        o = out + extra
        x, y, he = geom.point(np.array([s]), side, o)
        if not pavements.blocked(geom.id, x, y, he, clearance=COLUMN_W / 2 + 0.3)[0]:
            return edge + sgn * o
    return edge + sgn * out


def clearance(road, line, rec):
    """Lowest clearance under the panel: its bottom over the highest pavement point beneath it."""
    p = line.at(rec["s"])
    left, right = edges_at(road, rec["s"])
    d0, d1 = rec["d"] - rec["w"] / 2, rec["d"] + rec["w"] / 2
    d0, d1 = max(min(d0, left), right), max(min(d1, left), right)
    cf = float(p["crossfall"])
    h_c = float(p["h"]) + cf * rec["d"]
    bottom = h_c + rec["mount"]
    top_pave = float(p["h"]) + max(cf * d0, cf * d1)
    return bottom - top_pave
