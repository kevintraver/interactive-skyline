"""Low-poly model of a resort hotel slab tower (Las Vegas, id w25723910), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 120.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint): N-S slab 26 x 121 m in 3 volumes
    (center 120.0 m, north wing 100.6 m, south wing 104.1 m: mapped heights)
  - facade (cream walls with a regular window grid, plain base, tall crown frieze under a projecting
    cornice, low blue-grey roof; center block taller than the wings): refs/commons_sheet.jpg item 0;
    band and crown heights estimated from it
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bellagio_spa_tower_w25723910"
MAX_TRIS = 2_500

BURY = -2.0
BASE_TOP = 9.0             # (est.) plain base
FRIEZE = 11.0              # (est.) crown frieze height below the cornice
ROOF_H = 3.5               # (est.) low roof above the cornice


def _dedupe(pts):
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 0.05:
            out.append(tuple(p))
    return out


VOLUMES = [(_dedupe(v["outline"]), v["top"])
           for v in kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]]

COLORS = {
    "Wall": "E6D9B8",
    "Glass": "5A6470",
    "Crown": "EFE4C6",
    "Roof": "8FA3A8",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.80, 0.52)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":  # warm facade floodlighting, strongest near the ground
        return kit.scaled(WARM, 0.10 + 0.30 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.55)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Roof":
        return kit.scaled(WARM, 0.04)
    return (0.0, 0.0, 0.0)


def build_volume(b, plan, top, bands):
    cornice = top - ROOF_H
    body_top = cornice - FRIEZE
    b.extrude(kit.offset_polygon(plan, 0.5), BURY, BASE_TOP, "Wall", top="Roof")
    b.extrude(plan, BASE_TOP, body_top, "Glass", top="Roof")
    b.fins(plan, BASE_TOP, body_top, 6.5, 0.5, 3.9, "Wall")          # cream piers between window strips
    for i in range(1, bands + 1):                                      # (est.) spandrel bands
        z = BASE_TOP + (body_top - BASE_TOP) * i / (bands + 1)
        b.extrude(kit.offset_polygon(plan, 0.5), z, z + 2.4, "Wall")
    b.extrude(kit.offset_polygon(plan, 0.5), body_top, cornice - 1.2, "Crown", top="Roof")   # frieze
    b.extrude(kit.offset_polygon(plan, 1.5), cornice - 1.2, cornice, "Crown", top="Roof")    # cornice
    b.extrude(kit.offset_polygon(plan, -1.5), cornice, top, "Roof", top="Roof")               # low roof


def build_tower(b):
    for i, (plan, top) in enumerate(VOLUMES):
        build_volume(b, plan, top, 9 if i == 0 else 8)


PARTS = {"tower": build_tower}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w25723910")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
