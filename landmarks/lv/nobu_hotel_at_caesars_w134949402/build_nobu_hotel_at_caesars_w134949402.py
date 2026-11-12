"""Low-poly model of a 40 m hotel slab at a Las Vegas Strip resort (id w134949402), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the app's footprint center. No logos or signage modeled.

Sources:
  - height 40.0 m: project data, trusted
  - plan: footprint.json (OpenStreetMap way 134949402), extruded as mapped, offset 0,0
  - facade: Wikimedia Commons search sheet (refs/search.json/commons_sheet.jpg): cream concrete slab with
    horizontal dark window bands, vertical piers, a plain cornice and a small roof penthouse.
    Band count, pier spacing, cornice and penthouse sizes are estimated from those photos.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "nobu_hotel_at_caesars_w134949402"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 40.0         # project data
BASE_TOP = 5.5        # (est.) solid ground floor
SHAFT_TOP = 35.5      # (est.) top of window bands
CORNICE_TOP = 37.5    # (est.) plain cornice / parapet
CYCLES = 9            # (est.) one glass + spandrel pair per floor
BAND = 1.3            # (est.) cream spandrel height

COLORS = {
    "Wall": "E4DCCB",
    "Glass": "3F4E58",
    "Cornice": "EEE8DA",
    "Roof": "9A9892",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 10.0))
    if material == "Cornice":
        return kit.scaled(WARM, 0.16)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Wall"]
    step = (SHAFT_TOP - BASE_TOP) / CYCLES
    for i in range(CYCLES):
        z = BASE_TOP + i * step
        levels += [z + step - BAND, z + step]
        mats += ["Glass", "Wall"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    b.fins(plan, BASE_TOP, SHAFT_TOP, 7.5, 0.6, 0.9, "Wall")
    b.extrude(kit.scale_polygon(plan, 1.02), SHAFT_TOP - 0.3, CORNICE_TOP, "Cornice", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.45), CORNICE_TOP - 0.3, HEIGHT, "Cornice", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Hotel_Slab")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
