"""Low-poly model of a curved residential tower (Las Vegas, id w134918082), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 138.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), curved slab ~75 x 20 m, 31 corners
  - facade (white walls and balcony bands, blue-green glass, stepped crown rising to the middle):
    refs/commons_sheet.jpg (Commons search sheet, items 0, 1, 7); section heights estimated from it
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "west_tower_w134918082"
MAX_TRIS = 2_500

BURY = -2.9
HEIGHT = 138.0             # project data
BASE_TOP = 8.0             # (est.) lobby/base band
BODY_TOP = 112.0           # (est.) main roofline, ~0.81 of height in photos
STEP1_TOP = 124.0          # (est.) first crown step
STEP2_TOP = 132.0          # (est.) second crown step
CENTER = (-3.0, -3.0)      # a point inside the slab, mid-arc: crown steps shrink toward it
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {
    "Wall": "ECE8DF",
    "Glass": "4A6C7A",
    "Crown": "F2EEE6",
    "Roof": "9A9A96",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(WARM, 0.05 + 0.35 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Crown":  # uplit crown
        return kit.scaled(COOL, 0.5)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 0.9), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(PLAN, BASE_TOP, BODY_TOP, "Glass", top="Roof")
    b.fins(PLAN, BASE_TOP, BODY_TOP, 9.5, 0.8, 3.2, "Wall")                # white piers between glass strips
    for z in (19.5, 31.0, 42.5, 54.0, 65.5, 77.0, 88.5, 100.0):                                  # (est.) balcony slab bands
        b.extrude(kit.offset_polygon(PLAN, 0.9), z, z + 1.5, "Wall")
    b.extrude(kit.offset_polygon(PLAN, 0.9), BODY_TOP - 1.0, BODY_TOP + 1.5, "Crown", top="Roof")


def build_crown(b):
    s1 = kit.scale_polygon(PLAN, 0.74, CENTER)
    b.extrude(s1, BODY_TOP + 1.5, STEP1_TOP, "Glass", top="Roof")
    b.extrude(kit.scale_polygon(PLAN, 0.76, CENTER), STEP1_TOP, STEP1_TOP + 1.5, "Crown", top="Roof")
    s2 = kit.scale_polygon(PLAN, 0.48, CENTER)
    b.extrude(s2, STEP1_TOP + 1.5, STEP2_TOP, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(PLAN, 0.24, CENTER), STEP2_TOP, HEIGHT, "Crown", top="Roof")


PARTS = {"body": build_body, "crown": build_crown}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w134918082")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
