"""Low-poly model of the hotel at Las Vegas Blvd / Flamingo Rd (id w61239326), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signs: sign areas plain.

Sources:
  - height 49.2 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), whole block; installs with offset 0,0
  - massing read off Commons photos (refs/search.json/commons_sheet.jpg, items 1, 5, 6): an east-west slab
    tower with punched windows on the south part of the block, taller blank end wall at the west (Strip) end,
    rooftop club deck; low casino podium around it and a parking garage at the east end. The mapped plan is
    the whole block at full height, so podium and garage are modeled low. Section sizes are estimates (est.).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "vanderpump_w61239326"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 49.2              # project data (lidar)
PODIUM_TOP = 9.0           # est., two tall storeys
GARAGE_TOP = 16.0          # est., five parking levels
TOWER_Z0 = PODIUM_TOP
ROOF = 43.0                # est. from photo 5: slab roof below the end wall and roof structures
FLOORS = 10                # est. hotel floors above the podium
TURN = -1.9                # deg, from footprint longest-edge bearing 91.9
TOWER_C, TOWER_HX, TOWER_HY = (-24.0, -9.0), 37.0, 9.5   # est. slab 74 x 19 m

COLORS = {
    "Wall": "D9C9A6",      # cream painted concrete (photo 5)
    "Base": "C9B893",
    "Glass": "2A3138",
    "Garage": "B9B2A2",
    "Roof": "8E8A82",
    "Shade": "3A3835",
    "Crown": "EFE9DA",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, GOLD = (1.0, 0.82, 0.58), (1.0, 0.70, 0.30)


def glow(material, point, center):
    z = center[2]
    if material == "Wall":   # gold uplighting on the tower (photos 1, 6)
        return kit.scaled(GOLD, 0.32)
    if material == "Base":
        return kit.scaled(WARM, 0.22)
    if material == "Crown":  # white-lit roof deck edge
        return (0.85, 0.85, 0.9)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Garage":
        return kit.scaled(WARM, 0.05)
    return (0.0, 0.0, 0.0)


def rect(c, hx, hy, turn=TURN):
    a = math.radians(turn)
    ca, sa = math.cos(a), math.sin(a)
    return [(c[0] + x * ca - y * sa, c[1] + x * sa + y * ca) for x, y in ((hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy))]


def build_low(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(fp, BURY, PODIUM_TOP, "Base", top="Roof")
    # parking garage: east end of the mapped plan
    east = [p for p in fp if p[0] > 46.0]
    garage = kit.offset_polygon(east + [(46.3, 10.8)], -0.6)
    b.extrude(kit.offset_polygon(garage, -0.4), PODIUM_TOP, GARAGE_TOP - 0.2, "Shade", top="Roof")
    for i in range(4):                  # open parking decks: parapet bands over dark slots (est.)
        z = PODIUM_TOP + 0.02 + i * 1.75
        b.extrude(garage, z + 0.55, z + 1.75, "Garage")


def build_tower(b):
    core = rect(TOWER_C, TOWER_HX, TOWER_HY)
    b.extrude(core, TOWER_Z0, ROOF, "Glass", top="Roof")
    skin = rect(TOWER_C, TOWER_HX + 0.25, TOWER_HY + 0.25)
    fh = (ROOF - TOWER_Z0) / FLOORS
    b.extrude(skin, TOWER_Z0 + 0.01, TOWER_Z0 + 1.6, "Wall")
    for i in range(1, FLOORS):          # spandrel bands between window rows
        z = TOWER_Z0 + i * fh
        b.extrude(skin, z - 0.75, z + 0.75, "Wall")
    b.extrude(skin, ROOF - 1.2, ROOF + 0.3, "Wall")
    b.fins(core, TOWER_Z0 + 1.6, ROOF - 1.2, 3.8, 0.3, 1.5, "Wall")   # piers between windows
    # lit roof-deck edge and rooftop club pavilions (plain)
    b.extrude(rect(TOWER_C, TOWER_HX + 0.5, TOWER_HY + 0.5), ROOF + 0.3, ROOF + 1.6, "Crown", top="Roof")
    b.extrude(rect((-10.0, -9.3), 14.0, 6.0), ROOF + 1.6, ROOF + 4.6, "Wall", top="Roof")
    # taller blank end wall at the west (Strip) end; sign area left plain
    b.extrude(rect((-63.0, -8.0), 3.5, 11.5), PODIUM_TOP, HEIGHT, "Wall", top="Roof")
    # east stair/elevator core
    b.extrude(rect((14.5, -10.3), 2.5, 7.0), PODIUM_TOP, ROOF + 3.5, "Wall", top="Roof")


PARTS = {"low": build_low, "tower": build_tower}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Hotel_w61239326")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
