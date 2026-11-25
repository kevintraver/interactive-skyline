"""The reference line of a decoded road at any chainage: the Python twin of
src/drive/roadnet/refline.js. Change both together; tests hold them to 1 mm.

Plan position: cubic Hermite through consecutive stations with the stored heading as tangent,
scaled to the station spacing. Height: cubic Hermite with grades from central differences.
Curvature and crossfall: linear. Vectorised over s.

    line = Refline(road)        # road: dict with spacing, x, y, h, heading, curvature, crossfall
    p = line.at(s)              # dict of arrays: s, x, y, h, heading, curvature, grade, crossfall
"""
import numpy as np


def station_grades(h, spacing):
    n = len(h)
    i = np.arange(n)
    a, b = np.maximum(0, i - 1), np.minimum(n - 1, i + 1)
    return (h[b] - h[a]) / ((b - a) * spacing)


class Refline:
    def __init__(self, road):
        self.spacing = float(road["spacing"])
        self.x = np.asarray(road["x"], dtype=np.float64)
        self.y = np.asarray(road["y"], dtype=np.float64)
        self.h = np.asarray(road["h"], dtype=np.float64)
        self.heading = np.asarray(road["heading"], dtype=np.float64)
        self.curvature = np.asarray(road["curvature"], dtype=np.float64)
        self.crossfall = np.asarray(road["crossfall"], dtype=np.float64)
        self.n = len(self.x)
        self.length = (self.n - 1) * self.spacing
        self.cx, self.cy = np.cos(self.heading), np.sin(self.heading)
        self.grade = station_grades(self.h, self.spacing)

    def at(self, s):
        s = np.clip(np.asarray(s, dtype=np.float64), 0, self.length)
        L = self.spacing
        i = np.minimum(np.floor(s / L).astype(np.intp), self.n - 2)
        t = s / L - i
        j = i + 1
        t2, t3 = t * t, t * t * t
        h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
        d00, d10, d01, d11 = 6 * t2 - 6 * t, 3 * t2 - 4 * t + 1, -6 * t2 + 6 * t, 3 * t2 - 2 * t
        x, y, h, cx, cy, g = self.x, self.y, self.h, self.cx, self.cy, self.grade
        px = h00 * x[i] + h10 * L * cx[i] + h01 * x[j] + h11 * L * cx[j]
        py = h00 * y[i] + h10 * L * cy[i] + h01 * y[j] + h11 * L * cy[j]
        dx = d00 * x[i] + d10 * L * cx[i] + d01 * x[j] + d11 * L * cx[j]
        dy = d00 * y[i] + d10 * L * cy[i] + d01 * y[j] + d11 * L * cy[j]
        heading = np.where(t == 0, self.heading[i], np.arctan2(dy, dx))
        ph = h00 * h[i] + h10 * L * g[i] + h01 * h[j] + h11 * L * g[j]
        grade = (d00 * h[i] + d10 * L * g[i] + d01 * h[j] + d11 * L * g[j]) / L
        k, c = self.curvature, self.crossfall
        return {
            "s": s, "x": px, "y": py, "h": ph, "heading": heading, "grade": grade,
            "curvature": k[i] + t * (k[j] - k[i]), "crossfall": c[i] + t * (c[j] - c[i]),
        }
