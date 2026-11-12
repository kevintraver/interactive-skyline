"""Low-poly model of a 132 m leaning condo tower (Las Vegas, id w52134835), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled.

Sources:
  - height 132.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), a parallelogram, offset 0,0
  - lean 5 degrees along the long axis: widely published figure for these twin towers; the direction
    (top towards south) is estimated. The plan is centered at mid-height so the lean stays near the mapped plan.
  - facade (patchwork of yellow and grey glass panels, clear glass lobby, flat top with thin parapet):
    read off Wikimedia Commons search thumbnails ("Veer Towers Las Vegas.jpg", "DSC34298, Veer Towers
    Residences"); patch sizes est.
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "veer_towers_west_w52134835"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 132.0          # project data
LOBBY_TOP = 10.0        # clear glass lobby (est. from photo)
PARAPET = 1.5           # est.
LEAN_DEG = 5.0          # published
LEAN_DIR = (0.0, -1.0)  # top leans south (est.)
ROWS = 24               # patch rows, about 5 m (est.)
CELL = 5.2              # patch width along the wall (est.)

COLORS = {
    "Glass": "5F7480",      # grey-blue glazing
    "GoldGlass": "C9A63A",  # yellow fritted panels
    "Lobby": "8FA9B0",      # clear glass base
    "Frame": "B9BCBC",
    "Roof": "7E8286",
}
ROUGHNESS = {"Glass": 0.3, "GoldGlass": 0.4, "Lobby": 0.25}
WINDOWS = {"Glass": 1.0, "GoldGlass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material in ("Glass", "GoldGlass"):
        return kit.scaled(WARM, 0.03)
    if material == "Lobby":
        return kit.scaled(WARM, 0.35)
    if material == "Frame":
        return kit.scaled(COOL, 0.10)
    return (0.0, 0.0, 0.0)


def shift(z):
    d = math.tan(math.radians(LEAN_DEG)) * (z - HEIGHT / 2)
    return LEAN_DIR[0] * d, LEAN_DIR[1] * d


def patch_materials(n_cols):
    """Material per (row, column): yellow and grey patches 1-3 cells wide and 1-3 rows tall."""
    rng = random.Random(52134835)
    rows, current, left = [], None, 0
    for _ in range(ROWS):
        if left == 0:
            current, j = [], 0
            while j < n_cols:
                run = rng.randint(1, 3)
                current += [rng.choice(("GoldGlass", "GoldGlass", "Glass"))] * run
                j += run
            current, left = current[:n_cols], rng.randint(1, 3)
        rows.append(current)
        left -= 1
    return rows


def build_body(b):
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    plan = kit.densify(kit.ccw_polygon(outline), CELL)
    n = len(plan)
    body_top = HEIGHT - PARAPET
    levels = [BURY, LOBBY_TOP] + [LOBBY_TOP + (body_top - LOBBY_TOP) * (i + 1) / ROWS for i in range(ROWS)]
    levels.append(HEIGHT)
    patches = patch_materials(n)
    band_mats = [["Lobby"] * n] + patches + [["Frame"] * n]

    rings = []
    for z in levels:
        dx, dy = shift(max(z, 0.0))
        rings.append([b.bm.verts.new((x + dx, y + dy, z)) for x, y in plan])
    for lower, upper, mats in zip(rings, rings[1:], band_mats):
        for j in range(n):
            k = (j + 1) % n
            b.face([lower[j], lower[k], upper[k], upper[j]], mats[j])
    # caps as fans, so the collinear wall points never make zero-area triangles
    for ring, z, mat, flip in ((rings[0], levels[0], "Roof", True), (rings[-1], levels[-1], "Roof", False)):
        cx = sum(v.co.x for v in ring) / n
        cy = sum(v.co.y for v in ring) / n
        c = b.bm.verts.new((cx, cy, z))
        for j in range(n):
            k = (j + 1) % n
            b.face([c, ring[k], ring[j]] if flip else [c, ring[j], ring[k]], mat)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
