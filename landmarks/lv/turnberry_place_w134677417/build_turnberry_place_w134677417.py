"""Low-poly residential slab tower, Las Vegas (id w134677417), built with landmark_kit.

Sources:
  - height 145.0 m: project data (osm-height)
  - plan: skyline_tool footprint (footprint.json), a 66 x 25 m slab turned 45 degrees; offset 0,0
  - facade (cream walls, vertical glass bays, stepped crown): Commons 'Turnberry-Place-May-21-2010.JPG'
    contact sheet; crown step heights and base height are estimates (est.)
Logos and signage are not modeled.
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "turnberry_place_w134677417"
MAX_TRIS = 2500
BURY = -2.0
HEIGHT = 145.0      # project data
BASE_TOP = 9.0      # (est.) lobby base
SHAFT_TOP = 127.0   # (est.) first crown setback
STEP_TOP = 137.0    # (est.) second crown setback

COLORS = {"Wall": "E6DFCF", "Glass": "3E5A60", "Roof": "B9B3A6", "Crown": "EFE9DA"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.3 * math.exp(-max(z, 0.0) / 12.0))
    return (0.0, 0.0, 0.0)


def inset(plan, d):
    """Shrink the 45-degree slab plan by d meters on every side (negative d grows it)."""
    r = math.sqrt(0.5)
    uv = [((x - y) * r, (x + y) * r) for x, y in plan]
    u0, u1 = min(u for u, _ in uv), max(u for u, _ in uv)
    v0, v1 = min(v for _, v in uv), max(v for _, v in uv)
    cu, cv, hu, hv = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2
    out = []
    for u, v in uv:
        u2, v2 = cu + (u - cu) * (hu - d) / hu, cv + (v - cv) * (hv - d) / hv
        out.append(((u2 + v2) * r, (v2 - u2) * r))
    return out


def ring(plan, z):
    return [(x, y, z) for x, y in kit.ccw_polygon(plan)]


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    p1, p2 = inset(plan, 3.0), inset(plan, 6.5)
    rings = [ring(plan, BURY), ring(plan, BASE_TOP), ring(plan, SHAFT_TOP), ring(p1, SHAFT_TOP),
             ring(p1, STEP_TOP), ring(p2, STEP_TOP), ring(p2, HEIGHT)]
    b.loft(rings, ["Wall", "Glass", "Roof", "Crown", "Roof", "Crown"])
    # cream piers between glass bays, plus floor-group bands
    b.fins(plan, BASE_TOP, SHAFT_TOP + 1.5, 7.0, 0.7, 3.2, "Wall")
    for z in (48.0, 88.0):
        band = inset(plan, -0.35)
        b.loft([ring(band, z), ring(band, z + 1.2)], ["Wall"])
    b.fins(p1, SHAFT_TOP, STEP_TOP - 1.0, 12.0, 0.3, 5.0, "Glass")

def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
