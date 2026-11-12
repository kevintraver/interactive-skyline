"""Low-poly model of a curved bronze-glass resort tower (Las Vegas, id w205501268), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_wynn.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown sign zone is a plain band.

Sources:
  - height 187.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (mapped outline), simplified to 0.5 m tolerance
  - crown band (~8% of height), base band, stripe look: read off refs/Las-Vegas-Wynn-Hotel-8733.jpg (est.)
  - stripe count is reduced (real facade has one pale spandrel line per floor, ~45) to fit the budget (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "wynn"
MAX_TRIS = 3_000

HEIGHT = 187.0             # project data
BASE_TOP = 9.0             # plain base band (est. from photo)
CROWN_BOTTOM = 172.0       # plain crown band where signage sits (est. ~8% of height, photo)
CAP = 1.2                  # pale roof-edge line (est.)
STRIPE = 1.1               # pale spandrel stripe height, exaggerated to read at distance (est.)
SIMPLIFY_TOL = 0.5         # m

COLORS = {
    "BronzeGlass": "74503C",
    "Stripe": "E6D8B8",
    "CrownBand": "5E4032",
    "BaseBand": "4A352B",
}
ROUGHNESS = {"BronzeGlass": 0.3, "CrownBand": 0.35}
GOLD = (1.0, 0.72, 0.30)


def glow(material, point, center):
    if center[2] > HEIGHT - 0.01 or center[2] < 0.0:   # roof and underside stay dark
        return (0.0, 0.0, 0.0)
    if material == "Stripe":      # gold-lit horizontal lines (night photo Las_Vegas_NV_Wynn_.jpg)
        return kit.scaled(GOLD, 0.95)
    if material == "BronzeGlass":
        return kit.scaled(GOLD, 0.04)
    if material == "CrownBand":
        return kit.scaled(GOLD, 0.12)
    if material == "BaseBand":
        return kit.scaled(GOLD, 0.15)
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    """Douglas-Peucker on a closed ring, split at its two farthest-apart points."""
    def dp(seg):
        if len(seg) < 3:
            return list(seg)
        (x0, y0), (x1, y1) = seg[0], seg[-1]
        length = math.hypot(x1 - x0, y1 - y0) or 1e-9
        dist = [abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / length for x, y in seg]
        i = max(range(1, len(seg) - 1), key=dist.__getitem__)
        if dist[i] <= tol:
            return [seg[0], seg[-1]]
        return dp(seg[:i + 1])[:-1] + dp(seg[i:])
    a = min(range(len(pts)), key=lambda i: pts[i][1])
    ring = pts[a:] + pts[:a]
    b = max(range(len(ring)), key=lambda i: ring[i][1])
    return dp(ring[:b + 1])[:-1] + dp(ring[b:] + ring[:1])[:-1]


def build_body(b):
    vol = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]
    plan = simplify(list(vol["outline"]), SIMPLIFY_TOL)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(plan, plan[1:] + plan[:1]))
    if area < 0:
        plan.reverse()
    n = len(plan)
    stripes = int(min(24, ((MAX_TRIS - 2 * n) / (2 * n) - 3) // 2))
    pitch = (CROWN_BOTTOM - BASE_TOP) / stripes
    zs, mats = [min(vol["bottom"], -2.0), BASE_TOP], ["BaseBand"]
    for i in range(stripes):
        z = BASE_TOP + i * pitch
        zs += [z + STRIPE, z + pitch]
        mats += ["Stripe", "BronzeGlass"]
    zs += [HEIGHT - CAP, HEIGHT]
    mats += ["CrownBand", "Stripe"]
    rings = [[(x, y, z) for x, y in plan] for z in zs]
    b.loft(rings, mats, cap=True)
    print(f"plan points {n}, stripes {stripes}")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={'BronzeGlass': 1.0})  # lit windows at night (orchestrator)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
