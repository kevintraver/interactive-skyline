"""Low-poly model of unnamed building w128632721 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 72.0 m: project data (osm-height)
  - plan: skyline_tool.py footprint (footprint.json), a ~20 x 66 m north-south slab with a notched SW corner
  - facade, bands, plinth, end piers, cap and penthouse: estimated (no photos; plausible Las Vegas hotel slab)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w128632721"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 72.0            # project data (osm-height)
BASE_TOP = 6.0           # (est.) plinth / lobby level
CAP_Z0 = 67.5            # (est.) parapet band
ROOF = 69.0              # (est.) roof; penthouse to 72
BANDS = [16.0, 26.0, 36.0, 46.0, 56.0]  # (est.) spandrel bands
PENTHOUSE = ((0.0, 2.0), 5.5, 14.0)     # (est.) mechanical block: center, half x, half y
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Wall": "D6CBB7", "Glass": "2C3B47", "Band": "BFB29B", "Cap": "E6DDCD", "Roof": "77787A"}
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
        return kit.scaled(WARM, 0.6)
    if material == "Band":
        return kit.scaled(WARM, 0.07)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 1.0), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(PLAN, BASE_TOP, CAP_Z0, "Glass")
    for z in BANDS:
        b.extrude(kit.offset_polygon(PLAN, 0.2), z, z + 1.0, "Band")
    # (est.) solid end piers on the short north and south ends
    b.block((0.2, 31.9), 4.0, 0.5, BASE_TOP, CAP_Z0, "Wall")
    b.block((1.5, -34.3), 3.5, 0.5, BASE_TOP, CAP_Z0, "Wall")
    b.extrude(kit.offset_polygon(PLAN, 0.3), CAP_Z0, ROOF, "Cap", top="Roof")
    c, hx, hy = PENTHOUSE
    b.block(c, hx, hy, ROOF, HEIGHT, "Wall", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w128632721")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
