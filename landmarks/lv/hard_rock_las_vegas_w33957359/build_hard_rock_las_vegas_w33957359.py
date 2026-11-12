"""Low-poly model of a Y-plan Las Vegas resort hotel tower with low podium and atrium dome (id w33957359).

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the gold crown band (sign area) is plain.

Sources:
  - height: project data (osm-height) 102.0 m
  - plan: footprint.json (skyline_tool.py footprint): volume 0 = exact mapped Y-plan tower;
    volume 1 = atrium dome (mapped top 26.7 m); volume 2 = casino podium (mapped 19.5 m, outer boundary
    simplified and modeled low at 10 m, estimated)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): white tower with horizontal
    gold-tinted glass stripes and a gold top band. Band heights estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hard_rock_las_vegas_w33957359"
MAX_TRIS = 2_500
BURY = -2.0
H = 102.0          # project data
H_POD = 10.0       # est. (podium modeled low)
H_BASE = 16.0      # est. plain white base
H_CROWN0 = 90.0    # est. gold top band
H_CROWN1 = 98.5    # est.
DOME_C = (146.8, -44.3)   # footprint.json volume 1 center
DOME_R = 23.3
DOME_WALL = 14.0   # est.
DOME_TOP = 26.7    # footprint.json

COLORS = {
    "Wall": "ECE8DF",    # white
    "Glass": "8F7440",   # gold-tinted glass
    "Crown": "C9A24E",   # gold band
    "Podium": "D8CFBD",
    "Dome": "9FB3B8",
    "Roof": "8A8782",
}
ROUGHNESS = {"Glass": 0.25, "Crown": 0.3, "Dome": 0.25}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.78, 0.48)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.22)
    if material == "Crown":
        return kit.scaled((1.0, 0.72, 0.3), 0.75)
    if material == "Podium":
        return kit.scaled(WARM, 0.3)
    if material == "Dome":
        return kit.scaled((0.7, 0.9, 1.0), 0.35)
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    """Douglas-Peucker on an open polyline."""
    if len(pts) < 3:
        return list(pts)
    (ax, ay), (bx, by) = pts[0], pts[-1]
    length = math.hypot(bx - ax, by - ay) or 1e-9
    best, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        d = abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / length
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[:idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = simplify(list(fp["volumes"][0]["outline"]), 0.4)
    pod = simplify(list(fp["volumes"][2]["outline"]), 4.0)
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(pod, BURY, H_POD, "Podium", top="Roof")

    # tower: white base, gold glass stripes between white spandrel bands, gold top band, white parapet
    levels, mats = [BURY, H_BASE], ["Wall"]
    z = H_BASE
    while z + 10.5 <= H_CROWN0 + 0.01:
        levels += [z + 6.5, z + 10.5]
        mats += ["Glass", "Wall"]
        z += 10.5
    levels[-1] = H_CROWN0
    levels += [H_CROWN1, (H_CROWN1, 0.6), (H - 1.0, 0.6), (H - 1.0, -2.0), (H, -2.0)]
    mats += ["Crown", "Wall", "Wall", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # atrium dome: drum + glazed cap
    seg = 14
    prof = [(DOME_R, BURY), (DOME_R, DOME_WALL), (DOME_R * 0.8, DOME_WALL + 7.0),
            (DOME_R * 0.45, DOME_TOP - 2.0), (DOME_R * 0.1, DOME_TOP)]
    b.loft([kit.circle(r, zz, seg, center=DOME_C) for r, zz in prof], ["Podium", "Dome", "Dome", "Dome"])
    return b.finish("Resort_w33957359")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
