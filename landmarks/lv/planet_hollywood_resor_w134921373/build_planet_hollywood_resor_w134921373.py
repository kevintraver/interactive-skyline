"""Low-poly model of a chevron-plan Las Vegas resort hotel tower (id w134921373), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas (crown wall) are plain.

Sources:
  - height: project data (osm-height) 122.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (chevron slab, rounded ends)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): cream/white walls with a regular
    window grid, plain tall crown wall, flat roof; floodlit warm gold at night. Band heights estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "planet_hollywood_resor_w134921373"
MAX_TRIS = 2_500
BURY = -2.0
H = 122.0        # project data
H_BASE = 10.0    # est. plain base
H_CORNICE = 106.0  # est. from photos (crown wall ~1/8 of height)
H_CROWN = 117.0  # est.

COLORS = {
    "Wall": "E4DCC8",
    "Glass": "3A4658",
    "Band": "F0EAD8",
    "Crown": "E9E2CF",
    "Base": "CFC5AE",
    "Roof": "8C8A86",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.78, 0.42)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.18 + 0.30 * math.exp(-max(z - H_BASE, 0.0) / 45.0))
    if material == "Band":
        return kit.scaled(WARM, 0.45)
    if material == "Crown":
        return kit.scaled(WARM, 0.65)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels, mats = [BURY, H_BASE, (H_BASE, 0.6), (H_BASE + 1.5, 0.6), (H_BASE + 1.5, 0.0)], \
        ["Base", "Band", "Band", "Band"]
    for z in (34.0, 58.0, 82.0):
        levels += [z, (z, 0.5), (z + 1.5, 0.5), (z + 1.5, 0.0)]
        mats += ["Glass", "Band", "Band", "Band"]
    levels += [H_CORNICE, (H_CORNICE, 0.9), (H_CORNICE + 2.0, 0.9), (H_CORNICE + 2.0, 0.0),
               H_CROWN, (H_CROWN, -3.0), (H, -3.0)]
    mats += ["Glass", "Band", "Band", "Band", "Crown", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # cream piers between the window columns
    b.fins(plan, H_BASE + 1.5, H_CORNICE, 7.5, 0.7, 4.4, "Wall")
    return b.finish("Resort_w134921373")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
