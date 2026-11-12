"""Low-poly model of unnamed building w543645430 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 72.5 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), a tapered slab ~86 m long, 24 m deep at the
    south-east end widening to 30 m at the north-west end
  - facade, bands, plinth, cap and penthouse: estimated (no photos; plausible Las Vegas hotel/condo slab)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w543645430"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 72.5            # project data (lidar)
BASE_TOP = 6.5           # (est.) plinth / lobby level
CAP_Z0 = 67.5            # (est.) parapet band
ROOF = 69.0              # (est.) main roof; penthouse to 72.5
BANDS = [17.0, 27.0, 37.0, 47.0, 57.0]  # (est.) spandrel bands
PENTHOUSE_SCALE = 0.45   # (est.) mechanical block, plan scaled about the center
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Wall": "D6CBB7", "Glass": "2C3D4A", "Band": "BFB29B", "Cap": "E6DDCC", "Roof": "77787A"}
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
    b.extrude(kit.offset_polygon(PLAN, 0.3), CAP_Z0, ROOF, "Cap", top="Roof")
    b.extrude(kit.scale_polygon(PLAN, PENTHOUSE_SCALE), ROOF, HEIGHT, "Wall", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w543645430")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
