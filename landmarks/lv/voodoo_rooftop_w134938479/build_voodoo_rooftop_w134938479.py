"""Low-poly model of the rooftop-lounge core of a Las Vegas hotel tower (id w134938479), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
Logos, wordmarks, wraps and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 131.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (mapped outline, offset 0,0)
  - facade (blue glass core, red glass flanks, red parapet band, set-back rooftop level, vertical neon
    lines by night): read off the Wikimedia Commons search contact sheet (refs/search.json/commons_sheet.jpg);
    all section heights below are estimates (est.) from those photos
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "voodoo_rooftop_w134938479"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 131.0        # project data (osm-height)
BASE_TOP = 8.0        # plain base band (est.)
SHAFT_TOP = 117.0     # top of the glass shaft (est.)
BAND_TOP = 121.5      # red parapet band under the rooftop level (est.)
DECK_TOP = 126.5      # set-back rooftop lounge level (est.)
FLOOR_BANDS = [36.0, 63.0, 90.0]  # thin spandrel bands (est.)

COLORS = {
    "Glass": "2B4F9E",      # blue reflective glass
    "GlassRed": "9C3A32",   # red glass on the flanks
    "Band": "B2473A",       # red spandrel / parapet
    "Base": "8A7F78",
    "Fin": "C9CCD6",        # neon-carrying mullions
    "Lounge": "2A2F45",
    "Roof": "6E7076",
}
ROUGHNESS = {"Glass": 0.3, "GlassRed": 0.3, "Lounge": 0.35}
WINDOWS = {"Glass": 1.0, "GlassRed": 1.0}

VIOLET, RED, WARM = (0.45, 0.35, 1.0), (1.0, 0.18, 0.12), (1.0, 0.82, 0.58)


def glow(material, point, center):
    x, y, z = point
    if material in ("Glass", "GlassRed"):
        return kit.scaled(WARM, 0.03)
    if material == "Fin":  # vertical neon lines: violet-blue at the center, red on the east/west flanks
        return kit.scaled(RED if abs(x) > 8.5 else VIOLET, 0.9)
    if material == "Band":
        return kit.scaled(RED, 0.35)
    if material == "Lounge":
        return kit.scaled(WARM, 0.22)
    if material == "Base":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Base"]
    z = BASE_TOP
    for fb in FLOOR_BANDS:
        levels += [fb, fb + 1.5]
        mats += ["Glass", "Band"]
    levels += [SHAFT_TOP, (SHAFT_TOP, 0.5), (BAND_TOP, 0.5)]
    mats += ["Glass", "Roof", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    # red glass flanks: thin skins on the east and west faces (where the wings meet the core)
    for sx in (1, -1):
        flank = [(px, py) for px, py in plan if sx * px > 9.0]
        ys = sorted(py for _, py in flank)
        b.block((sx * 11.0, (ys[0] + ys[-1]) / 2), 1.6, (ys[-1] - ys[0]) / 2 - 1.0, BASE_TOP, SHAFT_TOP - 9.0,
                "GlassRed", top="Band")
    # neon mullions
    b.fins(plan, BASE_TOP, SHAFT_TOP, 4.2, 0.35, 0.3, "Fin")
    # set-back rooftop lounge level, roof slab and a small mechanical box up to the full height
    b.extrude(kit.scale_polygon(plan, 0.8, (0.0, 0.0)), BAND_TOP, DECK_TOP, "Lounge", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.9, (0.0, 0.0)), DECK_TOP, DECK_TOP + 0.8, "Band", top="Roof")
    b.block((0.0, 0.5), 4.5, 3.5, DECK_TOP + 0.8, HEIGHT, "Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
