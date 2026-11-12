"""Low-poly model of a Las Vegas timeshare tower (id w276427203), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signs are modeled.

Sources:
  - height 113.7 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), volume 0 = tower, volume 1 = 16 m podium
  - facade (cream masonry, punched windows, green mansard crown): Commons search sheet, files
    "Marriott's Grand Chateau.jpg" and "... roof.jpg"; band heights are estimates (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "marriott_s_grand_chate_w276427203"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 113.7            # project data
PODIUM_TOP = 16.0         # footprint.json volume 1
BASE_TOP = 20.0           # (est.) plain base band above the podium
CORNICE_Z0 = 98.0         # (est.) top band under the mansard, from photo ratio
EAVE = 105.0              # (est.) mansard eave
MANSARD_INSET = -3.0      # (est.)
MID_BAND = (58.0, 60.0)   # (est.) belt course

COLORS = {
    "Stone": "E6D9B8",
    "WindowWall": "C4B694",
    "Podium": "D9C9A6",
    "Mansard": "5E9C86",
    "Roof": "9A968C",
}
ROUGHNESS = {"WindowWall": 0.4}
WINDOWS = {"WindowWall": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "WindowWall":
        return kit.scaled(WARM, 0.03)
    if material == "Stone":
        return kit.scaled(WARM, 0.10 + (0.25 if z > CORNICE_Z0 - 1 else 0.0))
    if material == "Mansard":
        return kit.scaled((0.6, 1.0, 0.85), 0.18)
    if material == "Podium":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower = fp["volumes"][0]["outline"]
    podium = fp["volumes"][1]["outline"]

    b.extrude(podium, BURY, PODIUM_TOP, "Podium", top="Roof")
    b.loft(kit.footprint_rings(tower, [BURY, BASE_TOP, MID_BAND[0], MID_BAND[1], CORNICE_Z0, EAVE,
                                       (EAVE, 0.8), (EAVE + 1.2, 0.8), (HEIGHT - 1.0, MANSARD_INSET)]),
           ["Stone", "WindowWall", "Stone", "WindowWall", "Stone", "Stone", "Stone", "Mansard"])
    # flat roof deck inside the mansard, slightly lower
    b.extrude(kit.offset_polygon(tower, MANSARD_INSET - 0.5), HEIGHT - 3.0, HEIGHT, "Roof")
    # cream pilasters between window bays
    b.fins(tower, BASE_TOP, CORNICE_Z0, 6.0, 0.5, 1.2, "Stone")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
