"""Low-poly model of a 1970s timeshare hotel slab (Las Vegas, id w699020450), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 37.3 m: project data (lidar), trusted
  - plan: footprint.json from skyline_tool.py footprint (mapped outline)
  - facade: Wikimedia Commons search sheet (2018 day photo, night photo): tan painted concrete slab,
    about 11 floors of window strips between spandrel bands, plain top band; floor heights estimated
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hotel_building_w699020_w699020450"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 37.3        # project data (lidar)
PARAPET = 35.5       # (est.) main roof parapet; roof plant reaches HEIGHT
BASE_TOP = 4.2       # (est.) ground floor / lobby
FLOORS = 10          # (est.) window floors above the base, read off the day photo (~11 storeys)
TOP_BAND = 32.6      # (est.) plain band under the parapet
FLOOR_H = (TOP_BAND - BASE_TOP) / FLOORS
SPANDREL = 1.25      # (est.) solid band per floor

COLORS = {
    "Wall": "CDB594",
    "Spandrel": "B89B78",
    "Glass": "2B333C",
    "Roof": "8A8780",
    "Plant": "A39A8A",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Spandrel"):
        return kit.scaled(WARM, 0.10 if z < BASE_TOP + 1 else 0.04)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    inner = kit.offset_polygon(plan, -0.3)
    b.extrude(plan, BURY, BASE_TOP, "Wall")
    b.extrude(inner, BASE_TOP - 0.1, TOP_BAND + 0.1, "Glass")
    for i in range(1, FLOORS):
        z = BASE_TOP + i * FLOOR_H
        b.extrude(plan, z - SPANDREL / 2, z + SPANDREL / 2, "Spandrel")
    b.extrude(plan, TOP_BAND, PARAPET, "Wall", top="Roof")
    b.fins(inner, BASE_TOP, TOP_BAND, 6.4, 0.35, 0.9, "Wall")
    b.block((-4.0, 0.0), 9.0, 4.5, PARAPET - 0.2, HEIGHT, "Plant", top="Roof")
    return b.finish("HotelSlab")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
