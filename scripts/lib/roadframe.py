"""A built road seen as a frame: chainage s and lateral offset d (positive left) for any point
near it, its pavement edges, its surface height, and samples of its pavement. Used by the
interchange builder and the overlap checks.

    f = RoadFrame(road)                 # road: decoded (or encoder-ready) dict with spacing, x, y, h, ...
    s, d, off = f.sd(x, y)              # off: metres beyond either end along the line (0 inside)
    x, y = f.xy(s, d)
    z = f.surface(s, d)                 # pavement height there, crossfall included
    inside = f.inside(x, y, grow=0.0)   # in the pavement (outer shoulder edges) in plan
"""
import numpy as np
from scipy.spatial import cKDTree

from .crosssection import normalise_sections, pavement_edges
from .refline import Refline


def lane_edges(secs, s):
    """Edges of the lanes alone (left of lane 1, right of the last lane) at each s, vectorised,
    tapers included: the outer shoulder edges less the blended shoulders."""
    left, right = pavement_edges(secs, s)
    from .crosssection import _blend_terms
    cur, prev, u = _blend_terms(secs, s)
    sl = np.array([sec["left"]["shoulder"] for sec in secs])
    sr = np.array([sec["right"]["shoulder"] for sec in secs])
    return left - ((1 - u) * sl[prev] + u * sl[cur]), right + ((1 - u) * sr[prev] + u * sr[cur])


class RoadFrame:
    def __init__(self, road):
        self.road = road
        self.id = road["id"]
        self.line = Refline(road)
        self.secs = normalise_sections(road["sections"])
        self.spacing = float(road["spacing"])
        self.length = self.line.length
        self.x = np.asarray(road["x"], dtype=np.float64)
        self.y = np.asarray(road["y"], dtype=np.float64)
        self.tree = cKDTree(np.column_stack([self.x, self.y]))
        st = np.arange(len(self.x)) * self.spacing
        le, ri = pavement_edges(self.secs, st)
        self.left, self.right = le, ri
        self.half = float(max(np.abs(le).max(), np.abs(ri).max()))
        self.bbox = (self.x.min() - self.half, self.y.min() - self.half, self.x.max() + self.half, self.y.max() + self.half)

    def sd(self, x, y):
        x = np.atleast_1d(np.asarray(x, dtype=np.float64)).ravel()
        y = np.atleast_1d(np.asarray(y, dtype=np.float64)).ravel()
        _, i = self.tree.query(np.column_stack([x, y]))
        s = i * self.spacing
        for _ in range(4):
            p = self.line.at(s)
            c, sn = np.cos(p["heading"]), np.sin(p["heading"])
            dx, dy = x - p["x"], y - p["y"]
            s = np.clip(s + dx * c + dy * sn, 0, self.length)
        p = self.line.at(s)
        c, sn = np.cos(p["heading"]), np.sin(p["heading"])
        dx, dy = x - p["x"], y - p["y"]
        return s, -dx * sn + dy * c, np.abs(dx * c + dy * sn)

    def xy(self, s, d):
        p = self.line.at(s)
        return p["x"] - d * np.sin(p["heading"]), p["y"] + d * np.cos(p["heading"])

    def surface(self, s, d):
        p = self.line.at(s)
        return p["h"] + p["crossfall"] * d

    def edges(self, s):
        return pavement_edges(self.secs, np.asarray(s, dtype=np.float64))

    def lane_edges(self, s):
        return lane_edges(self.secs, np.asarray(s, dtype=np.float64))

    def near(self, x, y, extra=5.0):
        """Mask of points within reach of this road's pavement (a cheap prefilter)."""
        x = np.ravel(x)
        y = np.ravel(y)
        e = extra + self.spacing
        x0, y0, x1, y1 = self.bbox
        box = (x >= x0 - e) & (x <= x1 + e) & (y >= y0 - e) & (y <= y1 + e)
        out = np.zeros(len(x), dtype=bool)
        if box.any():
            d, _ = self.tree.query(np.column_stack([x[box], y[box]]), distance_upper_bound=self.half + e)
            out[box] = np.isfinite(d)
        return out

    def inside(self, x, y, grow=0.0):
        """(mask, s, d) for points in the pavement grown by `grow` metres each side."""
        x = np.ravel(x)
        y = np.ravel(y)
        m = self.near(x, y, grow + 1)
        s = np.full(len(x), np.nan)
        d = np.full(len(x), np.nan)
        if m.any():
            ss, dd, off = self.sd(x[m], y[m])
            le, ri = self.edges(ss)
            ok = (off < 0.5) & (dd <= le + grow) & (dd >= ri - grow)
            idx = np.flatnonzero(m)
            m[idx[~ok]] = False
            s[idx] = ss
            d[idx] = dd
        return m, s, d

    def pavement_points(self, step=2.0, across=1.0, s0=0.0, s1=None):
        """Points over the pavement: every `step` m along, every `across` m (edges included) across.
        Returns dict of flat arrays x, y, z, s, d."""
        s1 = self.length if s1 is None else s1
        s = np.arange(s0, s1 + 1e-9, step)
        if s[-1] < s1 - 1e-6:
            s = np.r_[s, s1]
        le, ri = self.edges(s)
        k = max(2, int(np.ceil((le - ri).max() / across)) + 1)
        f = np.linspace(0, 1, k)
        d = ri[:, None] + (le - ri)[:, None] * f[None, :]
        p = self.line.at(s)
        nx, ny = -np.sin(p["heading"]), np.cos(p["heading"])
        x = p["x"][:, None] + d * nx[:, None]
        y = p["y"][:, None] + d * ny[:, None]
        z = p["h"][:, None] + p["crossfall"][:, None] * d
        ss = np.broadcast_to(s[:, None], d.shape)
        return {"x": x.ravel(), "y": y.ravel(), "z": z.ravel(), "s": ss.ravel(), "d": d.ravel()}
