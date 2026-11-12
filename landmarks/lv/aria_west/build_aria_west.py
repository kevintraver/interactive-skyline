"""Low-poly model of a 163 m curved hotel tower (Las Vegas, id w134930090), built with landmark_kit.

Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 163.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (exact mapped outline, offset 0,0)
  - podium height, band spacing, crown step heights, colors, night light: (est.) read off Commons photos
    in refs/ (Dec 2013 day view; night views 23564756081 and "Las Vegas (2013) 51")
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "aria_west"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 163.0        # project data
PODIUM_TOP = 14.0     # (est.) low base storeys
BODY_TOP = 150.0      # (est.) main roof line; crown screen steps above it
CROWN_STEP = 157.0    # (est.) intermediate crown step
BAND_Z = [PODIUM_TOP + i * (BODY_TOP - PODIUM_TOP) / 15 for i in range(1, 15)]  # (est.) white sunshade bands
BAND_H = 0.8

COLORS = {
    "Glass": "6F8FA8",     # blue-silver curtain wall
    "Band": "E4E6E8",      # white horizontal sunshades / spandrels
    "Podium": "8A8F94",
    "Crown": "C9D2DA",     # pale crown screen
    "CrownEdge": "F4F6F8", # lit roof edge
    "Fin": "DDE3EA",       # slab-end vertical fin
    "Roof": "70757A",
}
ROUGHNESS = {"Glass": 0.3, "Crown": 0.4}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)       # app lit-window pattern supplies the light
    if material == "Band":
        return kit.scaled(COOL, 0.10)
    if material == "Crown":
        return kit.scaled(COOL, 0.22)
    if material == "CrownEdge":
        return kit.scaled(COOL, 0.95)       # bright white roof-edge line in night photos
    if material == "Fin":
        return kit.scaled((0.62, 0.66, 1.0), 0.8)  # blue-white vertical light strip at slab ends
    if material == "Podium":
        return kit.scaled(WARM, 0.25 * math.exp(-max(point[2], 0.0) / 12.0) + 0.05)
    return (0.0, 0.0, 0.0)


def end_fin(b, a, c, z1):
    """Thin vertical fin just outside the slab-end edge a->c."""
    (ax, ay), (cx, cy) = a, c
    dx, dy = cx - ax, cy - ay
    n = math.hypot(dx, dy)
    nx, ny = dy / n, -dx / n  # outward for a counter-clockwise... sign fixed by caller order
    t = 1.0
    k = min(1.0, 3.0 / n)  # (est.) strip about 3 m wide, centered on the end wall
    mx, my = (ax + cx) / 2, (ay + cy) / 2
    ax, ay, cx, cy = mx - dx * k / 2, my - dy * k / 2, mx + dx * k / 2, my + dy * k / 2
    quad = [(ax, ay), (cx, cy), (cx + nx * t, cy + ny * t), (ax + nx * t, ay + ny * t)]
    b.extrude(quad, PODIUM_TOP, z1, "Fin")


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(kit.scale_polygon(fp, 1.04), BURY, PODIUM_TOP, "Podium", top="Roof")
    b.extrude(fp, PODIUM_TOP, BODY_TOP, "Glass", top="Roof")
    for z in BAND_Z:
        b.extrude(kit.scale_polygon(fp, 1.012), z, z + BAND_H, "Band")
    # crown: two set-back steps with bright edges
    c1 = kit.scale_polygon(fp, 0.985)
    b.extrude(kit.scale_polygon(fp, 1.012), BODY_TOP, BODY_TOP + 1.2, "CrownEdge")
    b.extrude(c1, BODY_TOP + 1.2, CROWN_STEP, "Crown", top="Roof")
    c2 = kit.scale_polygon(fp, 0.93)
    b.extrude(c2, CROWN_STEP, HEIGHT - 1.2, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(fp, 0.945), HEIGHT - 1.2, HEIGHT, "CrownEdge", top="Roof")
    # slab-end fins (north end edge 0-1, south end edge 11-12), outward = away from centroid
    cx = sum(p[0] for p in fp) / len(fp); cy = sum(p[1] for p in fp) / len(fp)
    for i, j in ((0, 1), (11, 12)):
        a, c = fp[i], fp[j]
        mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2
        dx, dy = c[0] - a[0], c[1] - a[1]
        if (dy * (mx - cx) - dx * (my - cy)) < 0:
            a, c = c, a
        end_fin(b, a, c, CROWN_STEP)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
