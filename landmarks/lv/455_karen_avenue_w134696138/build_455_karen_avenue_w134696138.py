"""Low-poly model of the octagonal tower at 455 Karen Avenue (Las Vegas), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
No logos or signage are modeled.

Sources:
  - height 51.4 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), a ~10 m octagon, offset 0,0
  - facade (bands, floor heights, crown): estimated; no Commons photos were found
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "455_karen_avenue_w134696138"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 51.4            # project data (lidar)
BASE_TOP = 4.5           # (est.) solid ground-floor base
CROWN_H = 2.4            # (est.) parapet band
CAP_H = 1.6              # (est.) recessed roof cap, top at HEIGHT
FLOORS = 13              # (est.) ~3.3 m floor to floor
SPANDREL = 1.1           # (est.) concrete band per floor

COLORS = {
    "Wall": "D9D0BE",
    "Band": "C4B9A3",
    "Glass": "2A3540",
    "Roof": "8C8E90",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10 * math.exp(-max(z, 0.0) / 12.0) + 0.02)
    if material == "Band":
        return kit.scaled(WARM, 0.22 if z > HEIGHT - CAP_H - CROWN_H - 0.5 else 0.04)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    shaft_top = HEIGHT - CAP_H - CROWN_H
    floor_h = (shaft_top - BASE_TOP) / FLOORS
    levels, mats = [BURY, BASE_TOP], ["Wall"]
    for i in range(FLOORS):
        z = BASE_TOP + i * floor_h
        levels += [z + floor_h - SPANDREL, z + floor_h]
        mats += ["Glass", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    # crown: parapet band standing 0.3 m proud, then a recessed cap
    b.extrude(kit.offset_polygon(plan, 0.3), shaft_top, shaft_top + CROWN_H, "Band", top="Roof")
    b.extrude(kit.offset_polygon(plan, -1.6), shaft_top + CROWN_H, HEIGHT, "Wall", top="Roof")
    # base plinth slightly proud
    b.extrude(kit.offset_polygon(plan, 0.35), BURY, 1.0, "Band")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Karen_Avenue_Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
