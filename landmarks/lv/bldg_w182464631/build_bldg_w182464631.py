"""Low-poly model of unnamed building w182464631 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 74.9 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), a ~47 x 32 m articulated slab with bay projections
  - the 3.5 m wide west spur of the mapped plan is modeled low (est.: canopy / low wing, too thin for a tower)
  - facade, bands, plinth, cap and penthouse: estimated (no photos; plausible Las Vegas condo/hotel tower)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w182464631"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 74.9            # project data (lidar)
BASE_TOP = 7.0           # (est.) plinth / lobby level
SPUR_TOP = 5.5           # (est.) low west wing
CAP_Z0 = 70.4            # (est.) parapet band
ROOF = 71.9              # (est.) roof; penthouse to 74.9
BANDS = [20.0, 33.0, 46.0, 59.0]        # (est.) spandrel bands
PENTHOUSE = (0.5, 0.5, 20.0, 12.0)      # (est.) mechanical block: cx, cy, size x, size y
OUTLINE = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
SPUR_PTS = {(-32.27, -7.45), (-31.92, -9.44), (-31.91, -11.05)}
PLAN = [p for p in OUTLINE if (round(p[0], 2), round(p[1], 2)) not in SPUR_PTS]
SPUR = [(-20.4, -5.39), (-32.27, -7.45), (-31.92, -9.44), (-31.91, -11.05), (-21.41, -10.55)]

COLORS = {"Wall": "D6C9B2", "Glass": "2A3B48", "Band": "BFB199", "Cap": "E6DDCB", "Roof": "77787A"}
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
    assert len(PLAN) == len(OUTLINE) - 3, "spur vertices not found in footprint"
    b.extrude(SPUR, BURY, SPUR_TOP, "Wall", top="Roof")
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
    return b.finish("Bldg_w182464631")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
