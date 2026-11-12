"""Low-poly model of a curved timeshare tower (Las Vegas, id w568622622), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 76.6 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint). Volume 0 is the curved ~20 m deep tower slab
    (full height); volumes 1-3 are mapped low (to 5 m) entrance canopy / annex parts and are modeled low.
  - facade: no usable Commons photo found; (est.) 2000s resort tower: sand stucco piers and floor
    bands over blue-tinted glass, a taller blue-glass top band, plain parapet and mechanical penthouse.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "wyndham_desert_blue_w568622622"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 76.6              # project data (lidar)
BASE_TOP = 8.0             # (est.) stucco base with lobby
BODY_TOP = 71.5            # (est.) main roofline
LOW_TOP = 5.0              # footprint.json volumes 1-3
VOLUMES = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
TOWER = VOLUMES[0]["outline"]
LOW = [v["outline"] for v in VOLUMES[1:]]

COLORS = {
    "Wall": "D9C7A6",
    "Glass": "3F6A8C",
    "Base": "C9B592",
    "Crown": "E3D6BC",
    "Roof": "9A9A96",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)
BLUE = (0.35, 0.6, 1.0)


def glow(material, point, center):
    z = point[2]
    if material in ("Wall", "Base"):
        return kit.scaled(WARM, 0.05 + 0.30 * math.exp(-max(z, 0.0) / 15.0))
    if material == "Crown":
        return kit.scaled(BLUE, 0.45)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_low(b):
    for outline in LOW:
        b.extrude(outline, BURY, LOW_TOP, "Base", top="Roof")


def build_tower(b):
    b.extrude(kit.offset_polygon(TOWER, 0.6), BURY, BASE_TOP, "Base", top="Roof")
    b.extrude(TOWER, BASE_TOP, BODY_TOP, "Glass", top="Roof")
    b.fins(TOWER, BASE_TOP, BODY_TOP - 7.0, 9.0, 1.2, 0.9, "Wall")       # (est.) stucco piers
    z = BASE_TOP + 9.0
    while z < BODY_TOP - 10.0:                                            # (est.) bands every 3 floors
        b.extrude(kit.offset_polygon(TOWER, 0.7), z, z + 1.0, "Wall")
        z += 9.0
    b.extrude(kit.offset_polygon(TOWER, 0.9), BODY_TOP - 7.0, BODY_TOP - 6.0, "Wall")
    b.extrude(kit.offset_polygon(TOWER, 1.0), BODY_TOP - 1.2, BODY_TOP + 1.2, "Crown", top="Roof")  # parapet
    b.extrude(kit.offset_polygon(TOWER, -6.0), BODY_TOP + 1.2, HEIGHT, "Crown", top="Roof")        # penthouse


PARTS = {"low": build_low, "tower": build_tower}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w568622622")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
