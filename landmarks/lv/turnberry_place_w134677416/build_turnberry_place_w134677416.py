"""Low-poly model of a residential tower (Las Vegas, id w134677416), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), 65.6 x 25 m slab on a 135 deg bearing
  - facade (cream piers, blue-green glass strips, stepped crown with taller center): Commons search sheet
    (Turnberry-Place-May-21-2010.JPG, Turnberry Towers Las Vegas.jpg); section heights estimated from them
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "turnberry_place_w134677416"
MAX_TRIS = 2_500

BURY = -2.8
HEIGHT = 145.0             # project data
BASE_TOP = 9.0             # (est.) lobby/base band
BODY_TOP = 127.0           # (est.) main roofline, ~0.88 of height in photos
STEP_TOP = 136.0           # (est.) first crown step
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"][:4]  # 5th point is collinear

COLORS = {
    "Wall": "E6DFD0",
    "Glass": "3E5F6E",
    "Crown": "EDE7DA",
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
        return kit.scaled(WARM, 0.55)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 1.2), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(PLAN, BASE_TOP, BODY_TOP, "Glass", top="Roof")
    b.fins(PLAN, BASE_TOP, BODY_TOP + 1.5, 6.2, 0.9, 4.3, "Wall")          # cream piers between glass strips
    b.extrude(kit.offset_polygon(PLAN, 0.6), BODY_TOP - 2.0, BODY_TOP + 1.5, "Crown", top="Roof")  # cornice


    for z in (48.0, 88.0):                                                  # (est.) spandrel bands seen in photos
        b.extrude(kit.offset_polygon(PLAN, 1.0), z, z + 1.6, "Wall")


def build_crown(b):
    step = kit.offset_polygon(PLAN, -3.5)
    b.extrude(step, BODY_TOP + 1.5, STEP_TOP, "Glass", top="Roof")
    b.fins(step, BODY_TOP + 1.5, STEP_TOP, 6.2, 0.6, 4.3, "Crown")
    b.extrude(kit.offset_polygon(PLAN, -3.0), STEP_TOP, STEP_TOP + 1.5, "Crown", top="Roof")
    top = kit.scale_polygon(kit.offset_polygon(PLAN, -7.0), 0.6)            # taller central penthouse
    b.extrude(top, STEP_TOP + 1.5, HEIGHT, "Crown", top="Roof")


PARTS = {"body": build_body, "crown": build_crown}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w134677416")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
