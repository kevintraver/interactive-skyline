"""Low-poly model of an X-plan Las Vegas resort hotel tower with a mansard roof (id w27831697), landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height: project data (osm-height) 112.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (four-wing X)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): cream stone walls with a regular
    window grid, blue-grey mansard roof above a cornice, warm gold floodlight at night.
    Band, cornice and mansard heights are estimated from those photos.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "le_boulevard_at_paris_w27831697"
MAX_TRIS = 2_500
BURY = -2.0
H = 112.0          # project data
H_BASE = 9.0       # est. plain base
H_CORNICE = 96.0   # est. (mansard about 1/7 of height in photos)
H_MANSARD = 108.0  # est. top of steep mansard slope

COLORS = {
    "Wall": "E6DCC2",
    "Glass": "3C4656",
    "Band": "F0E8D2",
    "Base": "CDC2A8",
    "Mansard": "5E7388",
    "Roof": "4C5C6C",
}
ROUGHNESS = {"Glass": 0.3, "Mansard": 0.5}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.76, 0.40)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.18 + 0.30 * math.exp(-max(z - H_BASE, 0.0) / 45.0))
    if material == "Band":
        return kit.scaled(WARM, 0.45)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    if material == "Mansard":
        return kit.scaled((0.55, 0.70, 1.0), 0.10)
    return (0.0, 0.0, 0.0)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels = [BURY, H_BASE, (H_BASE, 0.6), (H_BASE + 1.5, 0.6), (H_BASE + 1.5, 0.0)]
    mats = ["Base", "Band", "Band", "Band"]
    for z in (38.0, 66.0, 86.0):
        levels += [z, (z, 0.5), (z + 1.5, 0.5), (z + 1.5, 0.0)]
        mats += ["Glass", "Band", "Band", "Band"]
    levels += [H_CORNICE, (H_CORNICE, 1.0), (H_CORNICE + 2.0, 1.0), (H_CORNICE + 2.0, -0.5),
               (H_MANSARD, -4.0), (H, -7.0)]
    mats += ["Glass", "Band", "Band", "Band", "Mansard", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # cream piers between the window columns
    b.fins(plan, H_BASE + 1.5, H_CORNICE, 6.5, 0.7, 4.3, "Wall")
    return b.finish("Resort_w27831697")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
