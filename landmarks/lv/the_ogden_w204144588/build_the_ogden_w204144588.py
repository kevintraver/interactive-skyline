"""Low-poly model of The Ogden (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 82.2 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): one 91 x 42 m rectangle, long edge bearing 117.6.
    It covers the whole block (garage podium + tower), so the full plan is modeled low (podium).
  - facade (tan stucco with cream floor bands and punched windows, parking podium, massing stepping up to
    a taller center with a small rooftop block): Wikimedia Commons search sheet, "The Ogden (Las Vegas,
    January 2013)" and "Streamline Tower (2008).jpg" (refs/search.json/commons_sheet.jpg).
    Podium height, step heights and tower plan inset are estimates read off those thumbnails.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_ogden_w204144588"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 82.2       # project data (lidar)
POD_TOP = 20.0      # garage podium, ~6 levels (est. from photo)
WING_TOP = 60.0     # outer wings (est.)
MID_TOP = 70.0      # middle step (est.)
CORE_TOP = 77.5     # central mass (est.)
BAND = 1.7          # cream floor band (est.)

# local axes of the footprint rectangle: U along the long edge (bearing 117.6), V across
UX, UY = 0.8862, -0.4633
VX, VY = 0.4633, 0.8862

COLORS = {
    "Stucco": "C9A98A",   # tan walls
    "Trim": "E6D9C2",     # cream floor bands and piers
    "Glass": "4E5A66",    # window strips
    "Podium": "BFA58A",
    "Roof": "8C8A86",
    "Crown": "D9C8AC",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Trim":
        return kit.scaled(WARM, 0.10)
    if material == "Podium":
        return kit.scaled(WARM, 0.16)
    if material == "Crown":
        return kit.scaled(WARM, 0.35)
    if material == "Stucco":
        return kit.scaled(WARM, 0.06)
    return (0.0, 0.0, 0.0)


def rect(u0, u1, v0, v1):
    return [(u * UX + v * VX, u * UY + v * VY) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]


def banded(b, plan, z0, z1, n):
    levels, mats = [z0], []
    step = (z1 - z0) / n - BAND
    z = z0
    for _ in range(n):
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Trim"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = list(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])
    # garage podium over the whole mapped block, with a cream cornice
    b.extrude(plan, BURY, POD_TOP - 1.2, "Podium")
    b.extrude(plan, POD_TOP - 1.2, POD_TOP, "Trim", top="Roof")
    # tower, stepped up toward the center
    wing = rect(-36.0, 36.0, -14.0, 13.0)
    mid = rect(-24.0, 24.0, -15.0, 14.0)
    core = rect(-12.0, 12.0, -16.0, 15.0)
    banded(b, wing, POD_TOP, WING_TOP, 6)
    b.fins(wing, POD_TOP, WING_TOP, 4.5, 2.3, 0.4, "Stucco")
    banded(b, mid, POD_TOP, MID_TOP, 7)
    b.fins(mid, POD_TOP, MID_TOP, 4.5, 2.3, 0.4, "Stucco")
    banded(b, core, POD_TOP, CORE_TOP, 8)
    b.fins(core, POD_TOP, CORE_TOP, 4.5, 2.3, 0.4, "Stucco")
    # rooftop mechanical block
    b.extrude(rect(-8.0, 8.0, -9.0, 9.0), CORE_TOP, HEIGHT, "Crown", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
