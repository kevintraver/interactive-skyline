"""Low-poly model of a Y-plan Las Vegas resort hotel tower with low podium (id w33959894), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the cream crown band (sign area) is plain.

Sources:
  - height: project data (osm-height) 112.0 m
  - plan: footprint.json (skyline_tool.py footprint): volume 0 = exact mapped Y-plan tower; volume 1 = podium
    (outer boundary simplified; mapped at 28.7 m, modeled low at 18 m, estimated)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): terracotta walls with a white-framed
    window grid, cream band below a terracotta cornice, flat roof. Band heights estimated from photos.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "treasure_island_hotel__w33959894"
MAX_TRIS = 2_500
BURY = -2.0
H = 112.0          # project data
H_POD = 18.0       # est. (podium/garage modeled low)
H_BASE = 20.0      # est. plain tower base just above podium
H_SIGN0 = 97.0     # est. from photos: cream band ~ top 1/8
H_SIGN1 = 105.0    # est.
H_CORNICE = 109.0  # est.

COLORS = {
    "Wall": "A8523A",    # terracotta
    "Glass": "3B4452",
    "Trim": "EFE6D6",    # white/cream frames and bands
    "Crown": "EADFC8",
    "Podium": "D9C7A8",
    "Roof": "8A8782",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.74, 0.45)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.14 + 0.22 * math.exp(-max(z - H_BASE, 0.0) / 40.0))
    if material == "Trim":
        return kit.scaled(WARM, 0.35)
    if material == "Crown":
        return kit.scaled(WARM, 0.7)
    if material == "Podium":
        return kit.scaled(WARM, 0.3)
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
    plan = fp["volumes"][0]["outline"]
    pod = fp["volumes"][1]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    # podium: outer boundary (points 0..71), closed through the tower's SE wing interior so no wall is coplanar
    outer = simplify(list(pod[:72]), 1.5)
    podium = outer + [(26.0, -62.0), (-15.0, -17.0), pod[-1]]
    b.extrude(podium, BURY, H_POD, "Podium", top="Roof")

    levels = [BURY, H_BASE, (H_BASE, 0.5), (H_BASE + 1.5, 0.5), (H_BASE + 1.5, 0.0)]
    mats = ["Wall", "Trim", "Trim", "Trim"]
    for z in (46.0, 71.5):
        levels += [z, (z, 0.4), (z + 1.2, 0.4), (z + 1.2, 0.0)]
        mats += ["Glass", "Trim", "Trim", "Trim"]
    levels += [H_SIGN0, (H_SIGN0, 0.5), (H_SIGN1, 0.5), (H_SIGN1, 0.0),
               H_CORNICE, (H_CORNICE, 1.0), (H - 1.0, 1.0), (H - 1.0, -2.5), (H, -2.5)]
    mats += ["Glass", "Crown", "Crown", "Crown", "Wall", "Wall", "Wall", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # terracotta piers between the white-framed window columns
    b.fins(plan, H_BASE + 1.5, H_SIGN0, 6.0, 0.6, 3.4, "Wall")
    return b.finish("Resort_w33959894")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
