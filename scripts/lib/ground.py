"""The terrain surface as the browser draws it, for checking that a road is never below it.

heights.py answers what the runtime's height queries answer: bilinear in the finest grid that
holds the point. The meshes on screen differ from that in two ways that matter to a road set on
top: each grid cell is drawn as two triangles split along the (i+1, j)-(i, j+1) diagonal, and a
coarser grid still draws, 8 m sunk, under a finer one, with its ring of cells along the finer
grid's edge only partly sunk (terrainMesh in main.js, buildWideMesh in src/world/terrain). So
the highest drawn surface at a point is the maximum over every grid's triangles there.

    from lib.ground import drawn_surface
    top = drawn_surface(heights)        # heights from lib.heights.load_heights
    top(x, y)                           # metres above sea level (no curvature), vectorised
"""
import numpy as np

SINK = 8.0  # as main.js and widemesh.js


def _axis_flags(n, start, step, lo, hi):
    """inside / cut flags along one axis, exactly as the meshes compute them."""
    v = start + np.arange(n) * step
    inside = (v > lo) & (v < hi)
    cut = (v > lo + step) & (v < hi - step) & (v + step > lo + step) & (v + step < hi - step)
    return inside, cut


class _DrawnGrid:
    def __init__(self, g, hole):
        self.g = g
        self.h = g.raw.astype(np.float64) * g.scale  # (ny, nx)
        self.cut = np.zeros((g.ny, g.nx), dtype=bool)
        if hole is not None:
            hx = (hole.x0, hole.x0 + (hole.nx - 1) * hole.step)
            hy = (hole.y0, hole.y0 + (hole.ny - 1) * hole.step)
            inx, cutx = _axis_flags(g.nx, g.x0, g.step, *hx)
            iny, cuty = _axis_flags(g.ny, g.y0, g.step, *hy)
            self.h = self.h - SINK * (iny[:, None] & inx[None, :])
            self.cut = cuty[:, None] & cutx[None, :]

    def sample(self, x, y):
        g = self.g
        fx = (x - g.x0) / g.step
        fy = (y - g.y0) / g.step
        out = np.full(np.shape(x), -np.inf)
        ok = (fx >= 0) & (fx <= g.nx - 1) & (fy >= 0) & (fy <= g.ny - 1)
        i = np.clip(np.floor(fx).astype(np.intp), 0, g.nx - 2)
        j = np.clip(np.floor(fy).astype(np.intp), 0, g.ny - 2)
        ax, ay = fx - i, fy - j
        ok &= ~self.cut[j, i]
        a, b = self.h[j, i], self.h[j, i + 1]
        d, e = self.h[j + 1, i], self.h[j + 1, i + 1]
        lower = ax + ay <= 1
        z = np.where(lower, a + ax * (b - a) + ay * (d - a), e + (1 - ax) * (d - e) + (1 - ay) * (b - e))
        return np.where(ok, z, out)


def drawn_surface(heights):
    """A function (x, y) -> the highest terrain the browser draws there, metres above sea level."""
    grids = list(heights.grids.values())  # finest first: near, far, wide
    drawn = [_DrawnGrid(g, grids[k - 1] if k > 0 else None) for k, g in enumerate(grids)]

    def top(x, y):
        x, y = np.broadcast_arrays(np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64))
        out = np.full(x.shape, -np.inf)
        for d in drawn:
            out = np.maximum(out, d.sample(x, y))
        return out

    return top
