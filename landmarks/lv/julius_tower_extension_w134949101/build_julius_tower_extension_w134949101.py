"""Low-poly model of the Julius Tower Extension (Las Vegas, id w134949101), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the app's footprint center. No logos or signage modeled.

Sources:
  - height 45.0 m: project data, trusted
  - plan: footprint.json (OpenStreetMap way 134949101), extruded as mapped (concave curved slab), offset 0,0
  - facade: Wikimedia Commons search sheet (refs/search.json/commons_sheet.jpg, 1970s views of the resort's
    original crescent towers): cream concrete with continuous horizontal dark window bands, white piers,
    flat roof with a low penthouse. Band count, pier spacing and penthouse size are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "julius_tower_extension_w134949101"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 45.0         # project data
BASE_TOP = 6.0        # (est.) solid ground level
SHAFT_TOP = 41.0      # (est.) main roof parapet
CYCLES = 10           # (est.) window band + spandrel pairs, 3.5 m each (one floor)
BAND = 1.5            # (est.) spandrel height

COLORS = {
    "Wall": "E4DAC2",
    "Glass": "4E6470",
    "Crown": "EFE9DA",
    "Roof": "A09C92",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (1.0, 0.93, 0.80)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(COOL, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Crown":
        return kit.scaled(COOL, 0.20)
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
    b.fins(plan, BASE_TOP, SHAFT_TOP, 7.0, 0.6, 0.8, "Wall")
    # parapet cornice, then a low mechanical penthouse
    b.extrude(kit.offset_polygon(plan, 0.6), SHAFT_TOP - 0.2, SHAFT_TOP + 1.2, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.55), SHAFT_TOP + 1.0, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Julius_Tower_Extension")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
