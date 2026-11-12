"""Low-poly model of hotel building w543641711 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 68.7 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), a three-wing zigzag slab about 20 m deep
  - facade: beige painted concrete with continuous horizontal window strips, read off Wikimedia Commons
    search thumbnails (aerial views of the hotel towers); band spacing, plinth, cap, penthouse estimated
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w543641711"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 68.7            # project data (lidar)
BASE_TOP = 6.0           # (est.) plinth
CAP_Z0 = 63.2            # (est.) parapet band
ROOF = 65.2              # (est.) main roof; mechanical penthouse to 68.7
BAND_STEP = 5.7          # (est.) two floors per spandrel band
BAND_H = 2.3             # (est.)
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Wall": "D9CDB4", "Glass": "34424C", "Band": "D2C5AA", "Cap": "E8DFCB", "Roof": "8A8780"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.35 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(WARM, 0.5)
    if material == "Band":
        return kit.scaled(WARM, 0.07)
    return (0.0, 0.0, 0.0)


def penthouse_plan():
    # (est.) mechanical block on the middle wing, aligned with it
    cx, cy, dx, dy, hl, hw = 8.0, 1.4, 0.927, -0.375, 13.0, 5.0
    nx, ny = -dy, dx
    return [(cx + sx * hl * dx + sy * hw * nx, cy + sx * hl * dy + sy * hw * ny)
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.extrude(kit.offset_polygon(PLAN, 0.6), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(PLAN, BASE_TOP, CAP_Z0, "Glass")
    z = BASE_TOP + 3.4
    while z + BAND_H < CAP_Z0:
        b.extrude(kit.offset_polygon(PLAN, 0.25), z, z + BAND_H, "Band")
        z += BAND_STEP
    b.extrude(kit.offset_polygon(PLAN, 0.35), CAP_Z0, ROOF, "Cap", top="Roof")
    b.extrude(penthouse_plan(), ROOF, HEIGHT, "Wall", top="Roof")
    return b.finish("Bldg_w543641711")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
