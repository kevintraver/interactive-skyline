"""Low-poly model of unnamed building w397861269 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 76.0 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), a 72 x 49 m eight-sided block
  - facade, bands, plinth, cap and penthouse: estimated (no photos; plausible Las Vegas hotel tower)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w397861269"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 76.0            # project data (lidar)
BASE_TOP = 7.0           # (est.) plinth / lobby level
CAP_Z0 = 71.5            # (est.) parapet band; roof at 73, penthouse to 76
ROOF = 73.0              # (est.)
BANDS = [18.0, 29.0, 40.0, 51.0, 62.0]  # (est.) spandrel bands
PENTHOUSE = (0.0, -2.0, 22.0, 14.0)   # (est.) central mechanical block: cx, cy, size x, size y
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Wall": "D9CDB8", "Glass": "2B3A46", "Band": "C2B49C", "Cap": "E8DFCF", "Roof": "77787A"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.35 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(WARM, 0.6)
    if material == "Band":
        return kit.scaled(WARM, 0.07)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 1.0), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(PLAN, BASE_TOP, CAP_Z0, "Glass")
    for z in BANDS:
        b.extrude(kit.offset_polygon(PLAN, 0.2), z, z + 1.0, "Band")
    b.extrude(kit.offset_polygon(PLAN, 0.3), CAP_Z0, ROOF, "Cap", top="Roof")
    cx, cy, sx, sy = PENTHOUSE
    b.block((cx, cy), sx, sy, ROOF, HEIGHT, "Wall", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w397861269")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
