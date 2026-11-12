"""Low-poly model of a Las Vegas resort podium (id w134068317), built procedurally with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the footprint center. No logos or signs are modeled.

Sources:
  - height 42.8 m: project data (lidar), trusted
  - plan: skyline_tool.py footprint (footprint.json), extruded as mapped, offset 0,0
  - the mapped plan is the whole low-rise casino/convention podium: the full outline is modeled low
    (PODIUM_H, est.), with only an inner roof block reaching the lidar height; section heights and
    colors are estimates (no photo pass)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "fontainebleau_resort_c_w134068317"
MAX_TRIS = 2_500
BURY = -2.0
HEIGHT = 42.8      # project data (lidar)
PODIUM_H = 20.0    # est.
HALL_H = 33.0      # est.
CORNICE_LIFT = 0.3  # cornice top above the podium roof, so the two never share a plane

COLORS = {"Wall": "E4E6E8", "Glass": "2B4A63", "Band": "3A4650", "Roof": "9A9EA2", "Accent": "BFD4E6"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.55, 0.75, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(COOL, 0.04 + 0.22 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Accent":
        return kit.scaled(COOL, 0.7)
    if material == "Band":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    # full mapped plan, low: painted podium with a dark glazed ground band and a lit cornice line
    b.extrude(outline, BURY, PODIUM_H, "Wall", top="Roof")
    skin = kit.offset_polygon(outline, 0.4)
    b.extrude(skin, 1.0, 6.5, "Band")
    # the cornice is a closed solid: its top would sit in the roof's plane and z-fight with it (striped, flickering
    # roof, bright at night), so it rises a little above the roof and its top becomes the roof surface instead
    b.extrude(skin, PODIUM_H - 1.2, PODIUM_H + CORNICE_LIFT, "Accent", top="Roof")
    # east convention / theatre block: glass facade with painted crown
    hall = rect(15.0, -100.0, 145.0, 100.0)
    b.extrude(hall, PODIUM_H, HALL_H - 2.0, "Glass")
    b.extrude(kit.offset_polygon(hall, 0.5), HALL_H - 2.0, HALL_H, "Wall", top="Roof")
    # west wing: lower painted block over the casino floor
    west = rect(-85.0, -105.0, 5.0, 85.0)
    b.extrude(west, PODIUM_H, 27.0, "Wall", top="Roof")
    b.extrude(rect(-70.0, -90.0, -10.0, 70.0), 27.0, 29.0, "Band", top="Roof")
    # roof block reaching the lidar height
    top = rect(40.0, -60.0, 120.0, 60.0)
    b.extrude(top, HALL_H, HEIGHT - 1.2, "Wall")
    b.extrude(kit.offset_polygon(top, 0.4), HEIGHT - 1.2, HEIGHT, "Accent", top="Roof")
    return b.finish("Resort_w134068317")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
