"""Low-poly model of a curved blue-glass resort tower (Las Vegas, id w134068318), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_fontainebleau.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 224.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (exact OSM outline)
  - belt heights, crown tilt and crown band depth: (est.) read off refs/Fontainebleau_Las_Vegas_signage.jpg
    and refs/Fontainebleau_Las_Vegas.jpg (two lighter belts at about 1/3 and 2/3, tilted bright rim)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "fontainebleau"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
HEIGHT = 224.0             # project data
RIM = 5.0                  # crown band depth (est.)
TILT_DROP = 16.0           # roof plane drop from the south curve to the north wing tips (est., photos)
BELTS = (72.0, 145.0)      # lighter spandrel belts (est. 1/3 and 2/3 of height, signage photo)
BELT_H = 4.5               # (est.)
BASE_TOP = 14.0            # darker base band (est.)

FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))
OUTLINE = FP["volumes"][0]["outline"]
Y_MIN = min(p[1] for p in OUTLINE)
Y_MAX = max(p[1] for p in OUTLINE)

# ---------------------------------------------------------------------- style
COLORS = {
    "GlassBlue": "2F6FB0",
    "GlassBase": "1E3550",
    "Belt": "9CC0DE",
    "CrownBand": "E6EEF4",
    "Roof": "8C9094",
}
ROUGHNESS = {"GlassBlue": 0.25, "GlassBase": 0.3}
WARM, BLUE, COOL = (1.0, 0.82, 0.58), (0.15, 0.45, 1.0), (0.6, 0.8, 1.0)


def glow(material, point, center):
    if material == "CrownBand":   # blue-lit crown rim in the night photo
        return kit.scaled(BLUE, 1.3)
    if material == "Belt":
        return kit.scaled(COOL, 0.18)
    if material == "GlassBlue":   # lit rooms, slightly stronger toward the top
        return kit.scaled(WARM, 0.03 + 0.04 * max(point[2], 0.0) / HEIGHT)
    if material == "GlassBase":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


# -------------------------------------------------------------------- helpers
def ccw(points):
    pts = list(points)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts if area > 0 else pts[::-1]


def offset(points, d):
    """Grow a polygon outward by d (miter joins)."""
    pts = ccw(points)
    n = len(pts)
    out = []
    for i in range(n):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[(i + 1) % n]
        ax, ay = x1 - x0, y1 - y0
        bx, by = x2 - x1, y2 - y1
        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
        n1 = (ay / la, -ax / la)
        n2 = (by / lb, -bx / lb)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        k = d / max(0.3, (mx * n1[0] + my * n1[1]))
        out.append((x1 + mx * k, y1 + my * k))
    return out


def roof_z(x, y):
    """Tilted roof plane: highest over the south curve, lowest at the north wing tips."""
    t = (y - Y_MIN) / (Y_MAX - Y_MIN)
    return HEIGHT - RIM / 2 - TILT_DROP * t


def tilted(b, points, z_low, z_high, material, top=None):
    """Closed prism whose bottom and top are functions of (x, y)."""
    pts = ccw(points)
    lower = [b.bm.verts.new((x, y, z_low(x, y))) for x, y in pts]
    upper = [b.bm.verts.new((x, y, z_high(x, y))) for x, y in pts]
    n = len(pts)
    for j in range(n):
        k = (j + 1) % n
        b.face([lower[j], lower[k], upper[k], upper[j]], material)
    b.face(upper, top or material)
    b.face(lower[::-1], material)


# --------------------------------------------------------------------- parts
def build_body(b):
    b.extrude(offset(OUTLINE, 0.5), BURY, BASE_TOP, "GlassBase")
    tilted(b, OUTLINE, lambda x, y: BURY, roof_z, "GlassBlue", top="Roof")
    for z in BELTS:
        b.extrude(offset(OUTLINE, 0.4), z, z + BELT_H, "Belt")


def build_crown(b):
    half = RIM / 2
    tilted(b, offset(OUTLINE, 0.6), lambda x, y: roof_z(x, y) - half - 3.0,
           lambda x, y: roof_z(x, y) + half, "CrownBand", top="Roof")


PARTS = {"body": build_body, "crown": build_crown}


# facade glass that gets the app's lit-window pattern at night (added by the orchestrator)
WINDOWS = {'GlassBlue': 1.0}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
