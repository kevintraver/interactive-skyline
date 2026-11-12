"""Low-poly model of the tall grey showroom block at the Las Vegas market-center campus.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled (sign band left plain).

Sources:
  - height 86.9 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), one volume
  - facade (dark charcoal frame, two pale grey tapered stone panels per face, dark crown band, nearly
    windowless): Wikimedia Commons search sheet refs/search.json/commons_sheet.jpg (photos 3 and 7).
    Panel sizes, taper, slot widths and base height are estimates read off those thumbnails.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "world_market_center_w130585543"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 86.9       # project data (lidar)
BASE_TOP = 7.0      # dark entrance base (est.)
PANEL_TOP = 72.0    # top of pale panels (est. from photo 7: ~83% of height)
CROWN_Z = 76.0      # underside of dark crown band (est.)

COLORS = {
    "Frame": "3B3E44",   # charcoal metal frame
    "Stone": "C9CBC8",   # pale grey tapered panels
    "Glass": "56636E",   # glazed slots between panels
    "Crown": "2E3136",   # dark crown band (sign area left plain)
    "Base": "4A4C50",
    "Roof": "7C7F82",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Stone":
        return kit.scaled(WARM, 0.10)     # facade floodlighting
    if material == "Base":
        return kit.scaled(WARM, 0.15)
    if material == "Crown":
        return kit.scaled(COOL, 0.12)
    return (0.0, 0.0, 0.0)


def slab(b, a, c, t0, t1, u0, u1, z0, z1, out, mat):
    """A panel standing proud of wall a->c: spans t0..t1 of the edge at z0 and u0..u1 at z1."""
    dx, dy = c[0] - a[0], c[1] - a[1]
    ln = math.hypot(dx, dy)
    nx, ny = dy / ln, -dx / ln

    def ring(s0, s1, z):
        p, q = (a[0] + dx * s0, a[1] + dy * s0), (a[0] + dx * s1, a[1] + dy * s1)
        return [(p[0] - nx * 0.5, p[1] - ny * 0.5, z), (p[0] + nx * out, p[1] + ny * out, z),
                (q[0] + nx * out, q[1] + ny * out, z), (q[0] - nx * 0.5, q[1] - ny * 0.5, z)]
    b.loft([ring(t0, t1, z0), ring(u0, u1, z1)], [mat])


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = kit.ccw_polygon(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])
    b.extrude(kit.offset_polygon(plan, 0.6), BURY, BASE_TOP, "Base")
    b.extrude(plan, BASE_TOP, CROWN_Z, "Frame")
    b.extrude(kit.offset_polygon(plan, 0.8), CROWN_Z, HEIGHT, "Crown", top="Roof")
    n = len(plan)
    for i in range(n):
        a, c = plan[i], plan[(i + 1) % n]
        ln = math.hypot(c[0] - a[0], c[1] - a[1])
        if ln < 25:
            continue
        # two tapered pale panels with a glazed slot between and beside them
        slab(b, a, c, 0.05, 0.47, 0.11, 0.45, BASE_TOP, PANEL_TOP, 1.0, "Stone")
        slab(b, a, c, 0.53, 0.95, 0.55, 0.89, BASE_TOP, PANEL_TOP, 1.0, "Stone")
        slab(b, a, c, 0.485, 0.515, 0.485, 0.515, BASE_TOP, PANEL_TOP - 4, 0.3, "Glass")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
