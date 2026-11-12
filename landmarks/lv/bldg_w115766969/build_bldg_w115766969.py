"""Low-poly model of unnamed structure w115766969 (Las Vegas), built procedurally with landmark_kit.

Sources:
  - height 86.4 m: interactive-skyline project data (osm-levels), trusted as given
  - plan: footprint.json from skyline_tool.py footprint (a 4.6 x 4.3 m parallelogram), offset 0,0
  - everything else (bands, glass strip heights, cap) is estimated: no photos, no name in the data.
    A 4.6 m plan at 86 m is a slender pylon/shaft, so it is modeled as one, with plain faces (no signs).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w115766969"
MAX_TRIS = 2_500
BURY = -2.0
HEIGHT = 86.4            # project data (osm-levels)
BASE_TOP = 6.0           # (est.) wider plinth
LANTERN_Z0 = 70.0        # (est.) glazed upper section
CAP_Z0 = 83.4            # (est.) cap band
BANDS = [20.0, 36.0, 52.0, 68.0]  # (est.) panel joints
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Wall": "CFC8BA", "Glass": "2A3540", "Band": "8E8A82", "Cap": "E6E1D6", "Roof": "6F7276"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(COOL, 0.06 + 0.35 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(WARM, 0.8)
    if material == "Band":
        return kit.scaled(COOL, 0.08)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 0.8), BURY, BASE_TOP, "Band", top="Roof")
    b.extrude(PLAN, BASE_TOP, LANTERN_Z0, "Wall")
    for z in BANDS:
        b.extrude(kit.offset_polygon(PLAN, 0.15), z, z + 0.8, "Band")
    b.extrude(kit.offset_polygon(PLAN, -0.25), LANTERN_Z0, CAP_Z0, "Glass")
    b.extrude(kit.offset_polygon(PLAN, 0.2), CAP_Z0, HEIGHT, "Cap", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w115766969")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
