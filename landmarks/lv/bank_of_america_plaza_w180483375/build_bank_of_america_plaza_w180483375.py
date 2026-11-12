"""Low-poly model of an office tower at w180483375 (Las Vegas downtown), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 73.4 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): 51 x 33 m slab with a small south-west core bay
  - facade: Wikimedia Commons search returned no usable photo; a plausible downtown office facade
    (dark reflective glass with pale spandrel bands, stone lobby base, recessed mechanical penthouse).
    All section heights and band counts are estimates.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bank_of_america_plaza_w180483375"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 73.4       # project data (lidar)
BASE_TOP = 8.0      # two-storey lobby base (est.)
ROOF = 68.6         # main roof / parapet top (est.)
BAND = 1.0          # spandrel band height (est.)
N_BANDS = 15        # office floors above the lobby (est., ~17 storeys total)

COLORS = {
    "Frame": "C9C4B8",   # pale spandrel bands and piers
    "Glass": "3F5868",   # dark blue-grey reflective glazing
    "Base": "A9A296",    # stone lobby base
    "Roof": "7E8286",
    "Plant": "9A9C9E",   # mechanical penthouse
}
ROUGHNESS = {"Glass": 0.25}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(COOL, 0.07)
    if material == "Base":
        return kit.scaled(WARM, 0.14)
    if material == "Plant":
        return kit.scaled(COOL, 0.10)
    return (0.0, 0.0, 0.0)


def banded(b, plan, z0, z1, n):
    levels, mats = [z0], []
    step = (z1 - z0) / n - BAND
    z = z0
    for _ in range(n):
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = list(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])
    b.extrude(plan, BURY, BASE_TOP, "Base", top="Roof")
    tower = kit.offset_polygon(plan, -0.8)
    banded(b, tower, BASE_TOP, ROOF - 1.4, N_BANDS)
    b.extrude(tower, ROOF - 1.4, ROOF, "Frame", top="Roof")          # parapet
    b.fins(tower, BASE_TOP, ROOF, 8.5, 0.5, 0.6, "Frame")            # pale piers (est. spacing)
    b.extrude(kit.scale_polygon(plan[:4], 0.6), ROOF, HEIGHT, "Plant", top="Roof")  # mechanical penthouse
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
