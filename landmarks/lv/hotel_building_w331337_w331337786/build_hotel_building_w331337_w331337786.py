"""Low-poly model of a hotel building (Las Vegas, id w331337786), built procedurally with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the app's footprint center. No logos or signage modeled.

Sources:
  - height 37.1 m: project data (lidar), trusted
  - plan: footprint.json (OpenStreetMap way 331337786), extruded as mapped, offset 0,0
  - facade: no reference photos (unnamed building); everything else is an estimated, plausible
    painted-concrete hotel block: solid base, glass strips between floor bands, parapet, roof plant.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hotel_building_w331337_w331337786"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 37.1         # project data (lidar)
BASE_TOP = 5.5        # (est.) solid ground floor
SHAFT_TOP = 33.6      # (est.) main roof parapet top
CYCLES = 5            # (est.) glass + band groups (each stands for about 2 floors)
BAND = 1.6            # (est.) painted band height

COLORS = {
    "Wall": "D9CDB6",
    "Base": "B9A98E",
    "Glass": "4E6470",
    "Crown": "E4DAC6",
    "Roof": "9A9892",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Base"):
        return kit.scaled(WARM, 0.05 + 0.22 * math.exp(-max(z, 0.0) / 10.0))
    if material == "Crown":
        return kit.scaled(COOL, 0.14)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Base"]
    step = (SHAFT_TOP - 1.2 - BASE_TOP) / CYCLES
    for i in range(CYCLES):
        z = BASE_TOP + i * step
        levels += [z + step - BAND, z + step]
        mats += ["Glass", "Wall"]
    levels += [SHAFT_TOP]
    mats += ["Crown"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    b.fins(plan, BASE_TOP, SHAFT_TOP - 1.2, 9.0, 0.6, 0.9, "Wall")
    # (est.) roof plant / elevator penthouse reaching the lidar height
    b.extrude([(-17, -7), (9, -7), (9, 7), (-17, 7)], SHAFT_TOP - 0.5, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Hotel_Block")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
