"""Where a sign stands across the road: the pavement edges at its chainage, the room in the median
for a sign on the left, and the ground under the panel. Offsets are metres from the reference
line, positive to the left, as in src/drive/roadnet/crosssection.js.

    from lib.roadside_place import edges_at, Median
    left, right = edges_at(road, s)          # outer shoulder edges at s
"""
import numpy as np
from scipy.spatial import cKDTree

from .heights import ground_of

LANE_W, SHOULDER_WIDE, SHOULDER_NARROW = 3.66, 3.05, 1.22
EMBANKMENT = ((24.0, 6.0), (20.0, 40.0))  # as EMBANKMENT in src/drive/roadnet/mesher.js


try:  # the twin of crosssection.js, with lane tapers
    from .crosssection import normalise_sections, pavement_edges
except ImportError:  # pragma: no cover - an older pipeline without it
    normalise_sections = pavement_edges = None


def _plain_edges(road, s):
    """Outer shoulder edges at s for sections without tapers (crosssection.js before tapers)."""
    sec = next((x for x in road["sections"] if x["s0"] <= s < x["s1"]), road["sections"][-1])
    widths = [ln.get("w", LANE_W) for ln in sec["lanes"]]
    n = len(widths)
    left_sh = (sec.get("left") or {}).get("shoulder", SHOULDER_WIDE if n >= 3 else SHOULDER_NARROW)
    right_sh = (sec.get("right") or {}).get("shoulder", SHOULDER_WIDE)
    pl = sec.get("placement", "centre")
    if pl == "centre":
        lead = sum(widths) / 2
    else:
        kind, num = pl.split(":")
        k = int(num)
        lead = sum(widths[:k - 1]) + {"left_of": 0, "middle_of": widths[k - 1] / 2, "right_of": widths[k - 1]}[kind]
    return lead + left_sh, lead - sum(widths) - right_sh


def edges_at(road, s):
    """(left, right) outer shoulder edges at s, as edgesAt in crosssection.js gives them."""
    if pavement_edges is None:
        return _plain_edges(road, s)
    secs = road.get("_secs") or road.setdefault("_secs", normalise_sections(road["sections"]))
    left, right = pavement_edges(secs, np.array([float(s)]))
    return float(left[0]), float(right[0])


def embankment_drop(lateral):
    """How far the embankment surface lies below the shoulder edge, `lateral` metres outside it."""
    (w1, d1), (w2, d2) = EMBANKMENT
    lateral = np.maximum(0.0, lateral)
    return np.where(lateral <= w1, lateral * d1 / w1, d1 + (lateral - w1) * d2 / w2)


class Median:
    """Clear width between a road's left shoulder edge and the opposite carriageway's pavement."""

    def __init__(self, road, line, opp, opp_line):
        self.road, self.line, self.opp, self.opp_line = road, line, opp, opp_line
        self.tree = cKDTree(np.c_[opp["x"], opp["y"]]) if opp is not None else None

    def clear(self, s):
        """Metres from the left shoulder edge at s to the nearest opposite pavement edge (inf without one)."""
        if self.tree is None:
            return float("inf")
        p = self.line.at(s)
        left, _ = edges_at(self.road, s)
        hd = float(p["heading"])
        px = float(p["x"]) - np.sin(hd) * left
        py = float(p["y"]) + np.cos(hd) * left
        _, i = self.tree.query([px, py])
        q = self.opp_line.at(i * self.opp["spacing"])
        qh = float(q["heading"])
        dl = (px - float(q["x"])) * -np.sin(qh) + (py - float(q["y"])) * np.cos(qh)
        o_left, o_right = edges_at(self.opp, i * self.opp["spacing"])
        # dl is how far the point lies on the opposite road's left (its median side); below its
        # left edge the two pavements overlap and the clear width is negative
        return float(dl - o_left)


def panel_ground(road, line, heights, s, side, offset, width):
    """(pavement edge height, highest ground under the panel's near edge, middle and far edge)
    for a sign at chainage s standing `offset` metres outside the edge; heights from lib.heights."""
    p = line.at(s)
    left, right = edges_at(road, s)
    d_edge = left if side == "left" else right
    sgn = 1.0 if side == "left" else -1.0
    hd = float(p["heading"])
    h_edge = float(p["h"]) + float(p["crossfall"]) * d_edge
    lat = d_edge + sgn * (offset + np.array([0.0, width / 2, width]))
    xs = float(p["x"]) - np.sin(hd) * lat
    ys = float(p["y"]) + np.cos(hd) * lat
    g = ground_of(heights)(xs, ys)
    return h_edge, float(np.max(g))
