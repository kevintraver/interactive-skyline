"""Low-poly model of a 17-storey office tower in the Hughes Center, Las Vegas (id w156624462).

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled (the crown sign band is plain).

Sources:
  - height 81.5 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): a 49 m square turned 45 degrees with cut corners;
    extruded as mapped, no podium in the plan.
  - facade: no usable Wikimedia Commons photo was found (search sheet in refs/search.json). Everything
    below is ESTIMATED as a plausible facade for an office tower of this plan and height: tan stone
    spandrels with dark ribbon glass, a taller lobby base, two small setbacks and a plain crown.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "wells_fargo_tower_w156624462"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 81.5        # project data (lidar)
BASE_TOP = 7.0       # lobby base (est.)
SHAFT_TOP = 66.0     # main shaft, 15 office floors (est.)
STEP_TOP = 74.0      # first setback, 2 floors (est.)
CROWN_TOP = 79.0     # plain crown band (est.)
FLOORS = 15
SPANDREL = 1.5       # stone band per floor (est.)

COLORS = {
    "Stone": "C8AE8E",    # tan stone spandrels
    "Base": "B59A7C",
    "Glass": "2F3B46",    # dark ribbon glass
    "Crown": "D2BC9E",
    "Roof": "8A8782",
    "Plant": "9C9388",
}
ROUGHNESS = {"Glass": 0.25}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Stone":
        return kit.scaled(WARM, 0.06)
    if material == "Base":
        return kit.scaled(WARM, 0.18)
    if material == "Crown":
        return kit.scaled(WARM, 0.35)
    return (0.0, 0.0, 0.0)


def banded_levels(z0, z1, n, inset):
    """Levels and materials for n floors of ribbon glass + stone spandrel between z0 and z1."""
    levels, mats = [], []
    floor = (z1 - z0) / n
    for i in range(n):
        z = z0 + i * floor
        levels += [(z, inset), (z + floor - SPANDREL, inset)]
        mats += ["Glass", "Stone"]
    return levels, mats


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = list(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])

    # lobby base, slightly proud of the shaft
    levels = [BURY, BASE_TOP, (BASE_TOP, -0.6)]
    mats = ["Base", "Stone"]
    # main shaft
    lv, mt = banded_levels(BASE_TOP, SHAFT_TOP, FLOORS, -0.6)
    levels += lv[1:]
    mats += mt[:-1] + ["Stone"]
    levels += [SHAFT_TOP, (SHAFT_TOP, -3.0)]
    mats += ["Roof"]
    # first setback: two more floors
    lv, mt = banded_levels(SHAFT_TOP, STEP_TOP, 2, -3.0)
    levels += lv[1:]
    mats += mt[:-1] + ["Stone"]
    levels += [(STEP_TOP, -3.0), (STEP_TOP, -5.5), (CROWN_TOP, -5.5)]
    mats += ["Roof", "Crown"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # corner pilasters: stone fins standing just proud of the ribbon glass
    b.fins(kit.offset_polygon(plan, -0.6), BASE_TOP, SHAFT_TOP, 7.5, 0.35, 1.0, "Stone")

    # rooftop plant
    b.extrude(kit.scale_polygon(plan, 0.5), CROWN_TOP, HEIGHT, "Plant", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
