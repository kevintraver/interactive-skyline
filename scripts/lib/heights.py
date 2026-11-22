"""The ground the browser draws, for the data pipeline. Twin of src/world/terrain (heightfield.js
and index.js) with every grid loaded: near where it contains the point, else far, else wide.

The arithmetic follows heightField() in main.js step for step, in float64, so a height from here
equals the browser's to the last bit and a road set against it sits where it was put.

    from lib.heights import load_heights
    hs = load_heights("lv")
    hs.height_at(x, y)   # metres above sea level, vectorised
    hs.ground_y(x, y)    # scene Y
"""
import json
from pathlib import Path

import numpy as np

from .frame import curve_drop

ROOT = Path(__file__).resolve().parents[2]
ORDER = ("near", "far", "wide")  # finest first


class Grid:
    """One height grid: sample() and contains() exactly as heightField() in main.js."""

    def __init__(self, name, g, raw):
        self.name = name
        self.nx, self.ny = g["nx"], g["ny"]
        self.x0, self.y0, self.step, self.scale = g["x0"], g["y0"], g["step"], g["scale"]
        self.raw = raw.reshape(self.ny, self.nx)  # row 0 = south
        self.x1 = self.x0 + (self.nx - 1) * self.step
        self.y1 = self.y0 + (self.ny - 1) * self.step

    @property
    def extents(self):
        """(x0, y0, x1, y1) in map metres."""
        return (self.x0, self.y0, self.x1, self.y1)

    def at(self, i, j):
        return self.raw[j, i] * self.scale

    def sample(self, x, y):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        fx = np.maximum(0, np.minimum(self.nx - 1.001, (x - self.x0) / self.step))
        fy = np.maximum(0, np.minimum(self.ny - 1.001, (y - self.y0) / self.step))
        i, j = np.floor(fx), np.floor(fy)
        ax, ay = fx - i, fy - j
        i, j = i.astype(np.intp), j.astype(np.intp)

        def lerp(a, b, t):
            return (1 - t) * a + t * b

        return lerp(lerp(self.at(i, j), self.at(i + 1, j), ax), lerp(self.at(i, j + 1), self.at(i + 1, j + 1), ax), ay)

    def contains(self, x, y, inset=0):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        return (
            (x > self.x0 + inset) & (x < self.x0 + (self.nx - 1) * self.step - inset)
            & (y > self.y0 + inset) & (y < self.y0 + (self.ny - 1) * self.step - inset)
        )


class Heights:
    def __init__(self, meta, grids, base):
        self.meta = meta
        self.base = base
        self.grids = grids  # name -> Grid, finest first

    @property
    def extents(self):
        """Each grid's (x0, y0, x1, y1) in map metres."""
        return {n: g.extents for n, g in self.grids.items()}

    def grid(self, name):
        return self.grids.get(name)

    def height_at(self, x, y):
        """Metres above sea level: the finest grid that contains the point, else the coarsest one's clamped edge."""
        x, y = np.broadcast_arrays(np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64))
        grids = list(self.grids.values())
        out = grids[-1].sample(x, y)
        taken = np.zeros(x.shape, dtype=bool)
        for g in grids[:-1]:
            m = ~taken & g.contains(x, y)
            if m.any():
                out = np.where(m, g.sample(x, y), out)
            taken |= m
        return out[()] if out.ndim == 0 else out

    def ground_y(self, x, y):
        """Scene Y of the ground, as groundY in main.js (and in src/world/terrain) computes it."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        return self.height_at(x, y) - self.base - curve_drop(x, y)


def load_heights(city, root=ROOT):
    """Every grid of a city from public/data/<city>/, with its base from data/cities.json."""
    root = Path(root)
    base = json.loads((root / "data" / "cities.json").read_text())[city]["base"]
    folder = root / "public" / "data" / city
    meta = json.loads((folder / "terrain.json").read_text())
    grids = {}
    for name in ORDER:
        if g := meta["grids"].get(name):
            grids[name] = Grid(name, g, np.fromfile(folder / g["file"], dtype="<u2"))
    return Heights(meta, grids, base)
