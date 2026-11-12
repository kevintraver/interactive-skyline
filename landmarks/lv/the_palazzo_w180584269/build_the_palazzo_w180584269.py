"""Low-poly model of a Las Vegas resort podium (id w180584269), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
No logos or signs are modeled.

Sources:
  - height 35.5 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): the broad casino/retail podium, about 270 x 213 m
  - no usable Commons photos of the podium found: cream stucco walls, glazed arcade storeys, cornice
    bands and set-back roof blocks are estimated (est.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_palazzo_w180584269"
MAX_TRIS = 2_500

BURY = -2.6          # footprint.json volume bottom
HEIGHT = 35.5        # project data (lidar)
BASE_TOP = 6.0       # (est.) street-level plinth
ARCADE_TOP = 16.0    # (est.) glazed arcade / retail storeys
BODY_TOP = 27.0      # (est.) main podium parapet
UPPER_TOP = 32.5     # (est.) set-back upper roof level

COLORS = {
    "Wall": "D9CBAE",
    "Glass": "33424C",
    "Band": "EDE3CC",
    "Roof": "9A968C",
    "Upper": "CFC1A4",
    "Plant": "B5AFA2",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.30 if z < BASE_TOP + 0.5 else 0.12)
    if material == "Band":
        return kit.scaled(WARM, 0.40)
    if material == "Upper":
        return kit.scaled(WARM, 0.10)
    if material == "Plant":
        return kit.scaled(COOL, 0.08)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels = [BURY, BASE_TOP, (BASE_TOP, -0.6), (ARCADE_TOP, -0.6), (ARCADE_TOP, 0.4), (ARCADE_TOP + 1.2, 0.4),
              (ARCADE_TOP + 1.2, 0.0), (BODY_TOP - 1.5, 0.0), (BODY_TOP - 1.5, 0.6), (BODY_TOP, 0.6)]
    mats = ["Wall", "Band", "Glass", "Band", "Band", "Band", "Wall", "Band", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    # pilasters across the glazed arcade (est.)
    b.fins(kit.offset_polygon(plan, -0.6), BASE_TOP, ARCADE_TOP, 22.0, 0.7, 1.6, "Wall")
    # set-back upper level and roof plant (est.)
    upper = kit.scale_polygon(plan, 0.74)
    b.extrude(upper, BODY_TOP - 0.5, UPPER_TOP, "Upper", top="Roof")
    b.block((-40.0, -60.0), 38.0, 14.0, UPPER_TOP - 0.5, HEIGHT, "Plant", top="Roof")
    b.block((50.0, 10.0), 30.0, 16.0, UPPER_TOP - 0.5, HEIGHT, "Plant", turn_deg=-28.0, top="Roof")
    b.block((-30.0, 55.0), 22.0, 12.0, UPPER_TOP - 0.5, HEIGHT - 1.0, "Plant", turn_deg=-28.0, top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Podium_w180584269")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
