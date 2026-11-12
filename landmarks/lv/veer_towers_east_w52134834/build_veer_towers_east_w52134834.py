"""Low-poly model of a leaning residential tower (Las Vegas, id w52134834), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 132.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), ~30 x 40 m parallelogram (5th point collinear, dropped)
  - lean about 5 degrees from vertical: widely published figure; direction (north) and the split of the
    shift between base and top are estimated
  - facade (staggered yellow panels on grey-blue glass, horizontal sunshade lines, clear glass lobby,
    flat top): Commons search sheet (Veer Towers East.jpg, Veer Towers (2).JPG); section heights estimated
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "veer_towers_east_w52134834"
MAX_TRIS = 2_500

BURY = -4.5
HEIGHT = 132.0             # project data
LOBBY_TOP = 11.0           # (est.) clear glass lobby
BODY_TOP = 129.0           # (est.) roof deck below the parapet screen
LEAN = math.tan(math.radians(5.0))   # published 5 degree lean
SHIFT0 = -3.5              # (est.) plan shift at ground so the tower stays near the mapped plan
ROWS = 24                  # (est.) ~5 m panel groups
COLS = (10, 8, 10, 8)    # columns per side (narrow vertical strips, as in the photos)
PLAN = kit.ccw_polygon(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"][:4])

COLORS = {
    "Glass": "5E7480",
    "Panel": "C9A51E",
    "Lobby": "8FA7AE",
    "Shade": "C8CCCC",
    "Roof": "8C8C88",
}
ROUGHNESS = {"Glass": 0.3, "Panel": 0.4, "Lobby": 0.25}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Panel":
        return kit.scaled((1.0, 0.78, 0.25), 0.10)
    if material == "Lobby":
        return kit.scaled(WARM, 0.4)
    if material == "Shade":
        return kit.scaled(WARM, 0.06)
    return (0.0, 0.0, 0.0)


def shift(z):
    return SHIFT0 + LEAN * max(z, 0.0)


def moved(poly, z):
    return [(x, y + shift(z)) for x, y in poly]


def ring(z):
    pts = []
    for i, n in enumerate(COLS):
        (x0, y0), (x1, y1) = PLAN[i], PLAN[(i + 1) % 4]
        for k in range(n):
            t = k / n
            pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + shift(z), z))
    return pts


def build_body(b):
    rng = random.Random(52134834)
    lobby = kit.offset_polygon(PLAN, -1.0)
    b.loft([[(x, y, BURY) for x, y in moved(lobby, 0)], [(x, y, LOBBY_TOP) for x, y in moved(lobby, LOBBY_TOP)]],
           "Lobby")
    zs = [LOBBY_TOP + (HEIGHT - LOBBY_TOP) * r / ROWS for r in range(ROWS + 1)]
    rings = [[b.bm.verts.new(p) for p in ring(z)] for z in zs]
    n = len(rings[0])
    yellow = [rng.random() < 0.5 for _ in range(n)]
    for r in range(ROWS):
        # staggered vertical runs: each column keeps its color for a few rows, as in the photos
        yellow = [(not y) if rng.random() < 0.22 else y for y in yellow]
        for j in range(n):
            k = (j + 1) % n
            top_row = r == ROWS - 1
            mat = "Glass" if top_row or not yellow[j] else "Panel"
            b.face((rings[r][j], rings[r][k], rings[r + 1][k], rings[r + 1][j]), mat)
    b.face(rings[0][::-1], "Shade")
    b.face(rings[-1], "Roof")
    for r in range(0, ROWS, 2):                       # (est.) horizontal sunshade lines
        z = zs[r]
        b.extrude(moved(kit.offset_polygon(PLAN, 0.5), z), z - 0.25, z + 0.25, "Shade")
    core = kit.scale_polygon(PLAN, 0.45)              # (est.) rooftop mechanical screen, kept below the parapet
    b.extrude(moved(core, HEIGHT), HEIGHT - 0.5, HEIGHT - 0.05, "Roof")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w52134834")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
