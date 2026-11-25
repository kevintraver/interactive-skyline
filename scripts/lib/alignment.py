"""The plan line of a road: a smoothing spline through the OSM nodes, resampled to uniform
stations as RoadNet asks (see src/drive/roadnet/format.js).

    fit = fit_line(xy, tol=0.5)            # xy: (n, 2) OSM nodes in order of travel, map metres
    fit.node_distance                      # metres from each node to the fitted line
    st = stations(fit, a0, a1, spacing=4)  # x, y, heading, curvature at s = 0, 4, 8, ...
"""
from dataclasses import dataclass

import numpy as np
from scipy.interpolate import splev, splprep
from scipy.spatial import cKDTree


@dataclass
class Fit:
    tck: tuple
    u: np.ndarray  # dense parameter samples
    arc: np.ndarray  # arc length at each dense sample, from the fit's start
    pts: np.ndarray  # dense points (m, 2)
    node_arc: np.ndarray  # arc length of each input node's nearest point on the line
    node_distance: np.ndarray  # metres from each input node to the line
    sigma: float  # the smoothing noise level the fit settled on

    def u_at(self, a):
        """Spline parameter at arc length a (vectorised), refined by Newton on |r'(u)|."""
        a = np.asarray(a, dtype=np.float64)
        u = np.interp(a, self.arc, self.u)
        for _ in range(3):
            # arc length from the nearest dense sample below, by Gauss-Legendre over [u_k, u]
            k = np.clip(np.searchsorted(self.u, u) - 1, 0, len(self.u) - 2)
            got = self.arc[k] + _arc_between(self.tck, self.u[k], u)
            dx, dy = splev(u, self.tck, der=1)
            u = u - (got - a) / np.hypot(dx, dy)
        return u

    def project(self, x, y):
        """Arc length of the nearest point on the line to (x, y), and the distance to it."""
        tree = cKDTree(self.pts)
        q = np.atleast_2d(np.column_stack([np.atleast_1d(x), np.atleast_1d(y)]))
        a, d = _project(self.pts, self.arc, tree, q)
        return a, d


_GL_X, _GL_W = np.polynomial.legendre.leggauss(5)


def _arc_between(tck, u0, u1):
    u0, u1 = np.broadcast_arrays(np.asarray(u0, float), np.asarray(u1, float))
    mid, half = (u0 + u1) / 2, (u1 - u0) / 2
    total = np.zeros(u0.shape)
    for xg, wg in zip(_GL_X, _GL_W):
        dx, dy = splev(mid + half * xg, tck, der=1)
        total = total + wg * np.hypot(dx, dy)
    return total * half


def _project(pts, arc, tree, q):
    """Nearest point on the dense polyline for each query: (arc length, distance)."""
    _, k = tree.query(q)
    best_a = np.zeros(len(q))
    best_d = np.full(len(q), np.inf)
    for off in (-1, 0):
        i = np.clip(k + off, 0, len(pts) - 2)
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = np.clip(np.einsum("ij,ij->i", q - a, ab) / np.maximum(np.einsum("ij,ij->i", ab, ab), 1e-12), 0, 1)
        p = a + t[:, None] * ab
        d = np.hypot(*(q - p).T)
        better = d < best_d
        best_d = np.where(better, d, best_d)
        best_a = np.where(better, arc[i] + t * (arc[i + 1] - arc[i]), best_a)
    return best_a, best_d


def densify(xy, step):
    """Points every `step` metres along a smooth curve through the nodes, for the spline to fit.

    OSM draws freeways with sparse nodes: straights kilometres long, gentle curves with a few
    vertices hundreds of metres apart. A spline through the nodes alone bows on the long
    segments (by 55 m on one 3.2 km segment of I-15), and the chords alone kink at the vertices.
    So each segment is filled along a cubic Hermite curve whose tangent at a node is the
    weighted bisector of the two chords, leaning towards the longer one (tangent = incoming
    heading + turn * L_out^2 / (L_in^2 + L_out^2)): between equal chords that is the circle's
    tangent, and a long straight next to a short curved segment keeps its own direction, the
    bend going into the short segment. (Weights linear in length bowed a 3 km straight by 3 m
    next to a 45 m segment and left I-15 with a 320 m radius; squared, 0.3 m and 418 m.)
    Returns (points, index of each input node in points)."""
    seg = np.hypot(*np.diff(xy, axis=0).T)
    hd = np.arctan2(np.diff(xy[:, 1]), np.diff(xy[:, 0]))
    tang = np.empty(len(xy))
    tang[0], tang[-1] = hd[0], hd[-1]
    turn = np.angle(np.exp(1j * np.diff(hd)))
    tang[1:-1] = hd[:-1] + turn * seg[1:] ** 2 / (seg[:-1] ** 2 + seg[1:] ** 2)
    if len(xy) > 2:  # end tangents mirror the next node's, as on an arc (a straight stays straight)
        tang[0] = hd[0] - np.angle(np.exp(1j * (tang[1] - hd[0])))
        tang[-1] = hd[-1] + np.angle(np.exp(1j * (hd[-1] - tang[-2])))
    out, idx = [xy[0]], [0]
    for k in range(len(seg)):
        L = seg[k]
        n = max(1, int(np.ceil(L / step)))
        t = np.arange(1, n + 1) / n
        h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        a, b = xy[k], xy[k + 1]
        ta = L * np.array([np.cos(tang[k]), np.sin(tang[k])])
        tb = L * np.array([np.cos(tang[k + 1]), np.sin(tang[k + 1])])
        pts = h00[:, None] * a + h10[:, None] * ta + h01[:, None] * b + h11[:, None] * tb
        out.extend(pts)
        idx.append(len(out) - 1)
    return np.array(out), np.array(idx)


def fit_line(xy, tol=0.5, step=10.0, sigma=0.15, dense=0.5, min_radius=250.0, relax_span=80.0):
    """Smoothing cubic spline through the nodes `xy` (n, 2), continuous in curvature.

    The spline is fitted to points every `step` metres along a smooth curve through the nodes
    (see densify), so it neither bows on long segments nor kinks at vertices. The smoothing level
    starts at `sigma` metres of assumed noise and is halved until 95% of the nodes lie within
    0.8 * `tol` metres and none lies further than 4 * tol.

    Then jogs: where a mapped centre line steps sideways (a few metres over a few tens of metres,
    typically where lanes are added), following it within tolerance makes a bend tighter than
    any freeway has. Wherever the fit is tighter than `min_radius`, the points within
    `relax_span` metres lose weight and the spline is fitted again, a few rounds at most, as
    long as 95% of the nodes stay within `tol`."""
    xy = np.asarray(xy, dtype=np.float64)
    keep = np.r_[True, np.hypot(*np.diff(xy, axis=0).T) > 0.01]  # drop repeated nodes
    pts, _ = densify(xy[keep], step)
    chord = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    u = np.arange(chord[0], chord[-1] + dense, dense)
    u[-1] = min(u[-1], chord[-1])

    def attempt(sig, w):
        tck, _ = splprep([pts[:, 0], pts[:, 1]], u=chord, w=w, k=3, s=len(pts) * sig**2, quiet=2)
        P = np.column_stack(splev(u, tck))
        arc = np.r_[0, np.cumsum(_arc_between(tck, u[:-1], u[1:]))]
        a, d = _project(P, arc, cKDTree(P), xy)
        return Fit(tck, u, arc, P, a, d, sig)

    w = np.ones(len(pts))
    while True:
        fit = attempt(sigma, w)
        d = fit.node_distance
        if (np.percentile(d, 95) <= tol * 0.8 and d.max() <= 4 * tol) or sigma < 0.01:
            break
        sigma /= 2
    for _ in range(4):
        dx, dy = splev(u, fit.tck, der=1)
        ddx, ddy = splev(u, fit.tck, der=2)
        k = np.abs(dx * ddy - dy * ddx) / np.hypot(dx, dy) ** 3
        bad = u[k > 1 / min_radius]
        if not len(bad):
            break
        near = np.zeros(len(pts), dtype=bool)
        for b in bad[:: max(1, int(relax_span / dense / 4))]:
            near |= np.abs(chord - b) < relax_span
        w2 = np.where(near, w * 0.3, w)
        trial = attempt(sigma, w2)
        if np.percentile(trial.node_distance, 95) > tol:
            break
        fit, w = trial, w2
    return fit


def stations(fit, a0, a1, spacing=4.0, multiple=16):
    """Uniform stations from arc length a0 to at most a1 on the fit: s = i * spacing from 0, and the
    count chosen so (count - 1) is a multiple of `multiple`. Returns a dict of arrays: s, x, y,
    heading (rad from +x, counter-clockwise), curvature (1/m, positive left)."""
    n_seg = int(np.floor((a1 - a0) / spacing + 1e-9))
    n_seg -= n_seg % multiple
    s = np.arange(n_seg + 1) * spacing
    u = fit.u_at(a0 + s)
    x, y = splev(u, fit.tck)
    dx, dy = splev(u, fit.tck, der=1)
    ddx, ddy = splev(u, fit.tck, der=2)
    heading = np.arctan2(dy, dx)
    curvature = (dx * ddy - dy * ddx) / np.hypot(dx, dy) ** 3
    return {"s": s, "x": np.asarray(x), "y": np.asarray(y), "heading": heading, "curvature": curvature}
