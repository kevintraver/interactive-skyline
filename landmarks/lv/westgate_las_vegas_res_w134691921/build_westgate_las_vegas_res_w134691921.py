"""Low-poly model of a Y-plan resort hotel tower (Las Vegas, id w134691921), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the mapped footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 114.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint): volume 0 = tower wings, volume 1 = podium (top 18.1 m)
  - facade: Commons search sheet (white concrete slab with horizontal dark window strips, plain white
    parapet band at the top); band heights and penthouse are estimated
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "westgate_las_vegas_res_w134691921"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 114.0            # project data (osm-height)
PODIUM_TOP = 18.1         # footprint.json volume 1
BASE_TOP = 24.0           # (est.) solid band above the podium
N_BANDS = 14              # (est.) grouped window strips
GLASS_H, WALL_H = 3.2, 2.7  # (est.)
PARAPET_Z = 107.0         # (est.) plain top band (sign area left plain)
PENT_TOP = HEIGHT         # penthouse reaches the mapped height
ROOF_Z = 110.0            # (est.) main roof under the penthouse

COLORS = {
    "Wall": "ECE8DC",
    "Glass": "2A3440",
    "Crown": "F2EEE4",
    "Podium": "D9D2C2",
    "Roof": "9A9C9C",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(COOL, 0.06 + 0.25 * math.exp(-max(z - PODIUM_TOP, 0.0) / 25.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Crown":
        return kit.scaled(COOL, 0.45)
    if material == "Podium":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def dedupe(points, tol=1.0):
    out = []
    for p in points:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    while len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower = dedupe(fp["volumes"][0]["outline"])
    podium = dedupe(fp["volumes"][1]["outline"])
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(podium, BURY, PODIUM_TOP, "Podium", top="Roof")

    levels, mats = [PODIUM_TOP - 1.0, BASE_TOP], ["Wall"]
    z = BASE_TOP
    for _ in range(N_BANDS):
        levels += [z + GLASS_H, z + GLASS_H + WALL_H]
        mats += ["Glass", "Wall"]
        z += GLASS_H + WALL_H
    levels[-1] = PARAPET_Z
    levels.append(ROOF_Z)
    mats.append("Crown")
    b.loft(kit.footprint_rings(tower, levels), mats)

    pent = kit.offset_polygon(tower, -7.0)
    b.extrude(pent, ROOF_Z - 0.5, PENT_TOP, "Crown", top="Roof")
    return b.finish("ResortTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
