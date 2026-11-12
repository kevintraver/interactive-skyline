"""Low-poly model of unnamed building w207630739 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 74.1 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), a 22 x 45 m slab, long axis bearing ~28 deg
    (two collinear points on the east edge dropped)
  - facade, bands, plinth, end walls' color, cap and penthouse: estimated (no photos; plausible
    Las Vegas hotel/condo slab of this height)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w207630739"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 74.1            # project data (lidar)
BASE_TOP = 6.5           # (est.) plinth / lobby level
CAP_Z0 = 69.6            # (est.) parapet band
ROOF = 71.0              # (est.) main roof; penthouse to 74.1
BANDS = [18.0, 28.5, 39.0, 49.5, 60.0]  # (est.) spandrel bands
_RAW = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
PLAN = [_RAW[0], _RAW[1], _RAW[4], _RAW[5]]   # four corners of the slab

COLORS = {"Wall": "D6CBB9", "Glass": "2A3B48", "Band": "BFB29C", "Cap": "E6DECF", "Roof": "77787A"}
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
    b.extrude(kit.scale_polygon(PLAN, 0.45), ROOF, HEIGHT, "Wall", top="Roof")  # (est.) mechanical penthouse


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w207630739")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
