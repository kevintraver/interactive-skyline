"""Low-poly model of an unnamed curved resort wing (OSM way 463856739, Las Vegas Strip, CityCenter block).

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
No logos, wordmarks or signage are modeled.

Sources:
  - height 38.3 m: project data (lidar)
  - plan: skyline_tool.py footprint (footprint.json), crescent about 110 x 15 m
  - facade: no usable exterior photo on Wikimedia Commons (interiors only, showing a tall glass curtain
    wall); band heights, colors and roof units are estimates (est.) for a glazed low-rise resort wing
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hotel_building_w463856_w463856739"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 38.3              # project data (lidar)
BASE_TOP = 5.0             # est. stone base
PARAPET = 35.8             # est. solid crown band start
BANDS = [12.4, 20.0, 27.6]  # est. spandrel bands between tall glazed levels
BAND_H = 1.1               # est.

COLORS = {
    "Base": "B9AE9C",
    "Glass": "4A6272",
    "Band": "D5D2CA",
    "Fin": "C4C6C8",
    "Roof": "8E9093",
    "Unit": "A9ABAD",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.22)
    if material == "Band":
        return kit.scaled(COOL, 0.12 if z > PARAPET else 0.06)
    if material == "Fin":
        return kit.scaled(COOL, 0.05)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Base"]
    z = BASE_TOP
    for band in BANDS:
        levels += [band, band + BAND_H]
        mats += ["Glass", "Band"]
    levels += [PARAPET, (PARAPET, 0.35), (HEIGHT - 1.2, 0.35)]
    mats += ["Glass", "Band", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    # roof deck inside the parapet, and two low mechanical units following the crescent (est.)
    b.extrude(kit.offset_polygon(plan, -1.0), HEIGHT - 1.3, HEIGHT - 0.9, "Roof")
    b.block((-30.0, 12.0), 7.0, 2.6, HEIGHT - 1.0, HEIGHT, "Unit", turn_deg=-30.0)
    b.block((22.0, -8.5), 9.0, 2.8, HEIGHT - 1.0, HEIGHT, "Unit", turn_deg=-10.0)
    # mullion fins on the glazed levels
    b.fins(plan, BASE_TOP, PARAPET, 6.5, 0.45, 0.35, "Fin")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("ResortWing")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
