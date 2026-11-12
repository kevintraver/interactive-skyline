"""Low-poly model of the East Tower (Las Vegas, id w134679980), built procedurally with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the app's footprint center. No logos or signage modeled.

Sources:
  - height 138.0 m: project data (osm-height), trusted
  - plan: footprint.json (OpenStreetMap way 134679980), extruded as mapped, offset 0,0
  - facade: Wikimedia Commons search sheet (refs/search.json/commons_sheet.jpg): white concrete tower with
    continuous balcony bands over blue-green glass, vertical white piers, stepped white crown.
    Band spacing, crown step heights and pier spacing are estimated from those photos.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "east_tower_w134679980"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 138.0        # project data
BASE_TOP = 7.0        # (est.) solid lobby base
SHAFT_TOP = 126.0     # (est.) main roof; crown above, from photos about 9% of height
CROWN1_TOP = 133.0    # (est.)
CYCLES = 11           # (est.) glass + balcony band groups (each stands for about 4 floors)
BAND = 4.0            # (est.) white band height

COLORS = {
    "Wall": "E6E2D8",
    "Glass": "55798A",
    "Crown": "EFECE4",
    "Roof": "9A9C9C",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(COOL, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Crown":
        return kit.scaled(COOL, 0.18)
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
    b.fins(plan, BASE_TOP, SHAFT_TOP, 8.0, 0.7, 1.2, "Wall")
    b.extrude(kit.scale_polygon(plan, 0.86), SHAFT_TOP - 0.5, CROWN1_TOP, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.55), CROWN1_TOP - 0.5, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("East_Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
