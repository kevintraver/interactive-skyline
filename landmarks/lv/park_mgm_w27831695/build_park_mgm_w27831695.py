"""Low-poly model of a tri-wing (Y-plan) Las Vegas resort hotel tower (id w27831695), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas (crown walls) are plain.

Sources:
  - height: project data (osm-height) 110.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (three wings, all tower)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): white/cream walls with a regular
    window grid, crown wall with raised blocks at the wing ends and the hub, warm floodlight at night.
    Band, cornice and crown heights are estimates read off that sheet.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "park_mgm_w27831695"
MAX_TRIS = 2_500
BURY = -2.0
H = 110.0          # project data
H_BASE = 9.0       # est.
H_CORNICE = 97.0   # est. from photo sheet
H_CROWN = 103.0    # est. crown wall top; raised end blocks reach H

COLORS = {
    "Wall": "ECE7DA",
    "Glass": "3C4858",
    "Band": "F3EFE4",
    "Crown": "EEE8D8",
    "Base": "D6CDB8",
    "Roof": "8C8A86",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.80, 0.48)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.16 + 0.30 * math.exp(-max(z - H_BASE, 0.0) / 45.0))
    if material == "Band":
        return kit.scaled(WARM, 0.40)
    if material == "Crown":
        return kit.scaled(WARM, 0.60)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels, mats = [BURY, H_BASE, (H_BASE, 0.6), (H_BASE + 1.5, 0.6), (H_BASE + 1.5, 0.0)], \
        ["Base", "Band", "Band", "Band"]
    for z in (38.0, 68.0):
        levels += [z, (z, 0.5), (z + 1.2, 0.5), (z + 1.2, 0.0)]
        mats += ["Glass", "Band", "Band", "Band"]
    levels += [H_CORNICE, (H_CORNICE, 0.9), (H_CORNICE + 1.8, 0.9), (H_CORNICE + 1.8, 0.0),
               H_CROWN, (H_CROWN, -2.5), (H_CROWN + 1.0, -2.5)]
    mats += ["Glass", "Band", "Band", "Band", "Crown", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # cream piers between the window columns
    b.fins(plan, H_BASE + 1.5, H_CORNICE, 7.0, 0.6, 4.0, "Wall")

    # raised crown blocks at the three wing ends and the hub (plain: no signs)
    b.block((-83.0, -0.5), 8.0, 8.5, H_CROWN - 1.0, H, "Crown", top="Roof")
    b.block((41.5, -72.0), 8.0, 8.5, H_CROWN - 1.0, H, "Crown", turn_deg=-59.5, top="Roof")
    b.block((41.5, 72.0), 8.0, 8.5, H_CROWN - 1.0, H, "Crown", turn_deg=59.5, top="Roof")
    b.block((6.0, 0.0), 9.0, 9.0, H_CROWN - 1.0, H, "Crown", top="Roof")
    return b.finish("Resort_w27831695")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
