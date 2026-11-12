"""Low-poly model of a 145 m Las Vegas condo-hotel slab tower (id w95223231), built with landmark_kit.

Sources:
  - height 145.0 m: project data (osm-height), trusted.
  - plan: skyline_tool.py footprint (footprint.json); the 11-point outline is a 59 x 25.4 m rectangle with
    collinear points, long axis bearing 45 deg; its 4 corners are used.
  - facade (white balcony bands over tan-gold glass, central gold glass strip, arched white crown with
    fins): read off the Wikimedia Commons search sheet refs/search.json/commons_sheet.jpg; proportions est.
Logos and signage are not modeled.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_signature_at_mgm_g_w95223231"
MAX_TRIS = 2500
BURY = -2.0
HEIGHT = 145.0            # project data
PODIUM_TOP = 7.0          # est.
BODY_TOP = 131.0          # est. from photos (crown ~8% of height)
PARAPET_TOP = 134.0       # est.
FLOORS = 24               # band pairs (est.; real tower has ~38 floors, merged for budget)
BAND = 1.9                # balcony band height, est.

PLAN = [(-30.03, -11.75), (12.04, 29.76), (29.99, 11.73), (-12.08, -29.77)]  # footprint.json corners
UX, UY = 0.7118, 0.7024   # long axis unit vector (bearing 45.4 deg)
WX, WY = 0.7024, -0.7118  # across
HALF_L, HALF_D = 29.55, 12.72


def uw(u, w):
    return (u * UX + w * WX, u * UY + w * WY)


def rect(u0, u1, w0, w1):
    return [uw(u0, w0), uw(u1, w0), uw(u1, w1), uw(u0, w1)]


COLORS = {
    "Band": "ECE6D6",
    "Glass": "A8925C",
    "StripGlass": "B08E3C",
    "Crown": "F2EEE2",
    "Roof": "8F8B82",
    "Base": "D9D2C0",
}
ROUGHNESS = {"Glass": 0.35, "StripGlass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "StripGlass":
        return kit.scaled(WARM, 0.22)
    if material == "Crown":
        return kit.scaled(WARM, 0.55)
    if material == "Band":
        return kit.scaled(WARM, 0.06)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(kit.offset_polygon(PLAN, 1.5), BURY, PODIUM_TOP, "Base", top="Roof")
    levels, mats = [PODIUM_TOP], []
    step = (BODY_TOP - PODIUM_TOP) / FLOORS
    for i in range(FLOORS):
        z = PODIUM_TOP + i * step
        levels += [z + step - BAND, z + step]
        mats += ["Glass", "Band"]
    b.loft(kit.footprint_rings(PLAN, levels), mats)
    # central gold glass strip on both long faces, standing 0.7 m proud
    b.extrude(rect(-4.5, 4.5, -HALF_D - 0.7, HALF_D + 0.7), PODIUM_TOP, BODY_TOP + 1.0, "StripGlass", top="Crown")
    # white corner piers wrapping the four slab corners (end walls keep their bands)
    for su in (-1, 1):
        for sw in (-1, 1):
            u0, u1 = sorted((su * (HALF_L - 2.2), su * (HALF_L + 0.4)))
            w0, w1 = sorted((sw * (HALF_D - 2.2), sw * (HALF_D + 0.4)))
            b.extrude(rect(u0, u1, w0, w1), PODIUM_TOP, BODY_TOP, "Band")


def build_crown(b):
    b.extrude(kit.offset_polygon(PLAN, 0.8), BODY_TOP, PARAPET_TOP, "Crown", top="Roof")
    # arched centerpiece across the full depth: profile along the long axis
    n, half = 8, 16.0
    rings = []
    for i in range(n + 1):
        u = -half + 2 * half * i / n
        zt = PARAPET_TOP + 1.0 + (HEIGHT - 3.0 - PARAPET_TOP - 1.0) * math.cos(math.pi * u / (2 * half))
        w = HALF_D + 1.0
        rings.append([(*uw(u, -w), PARAPET_TOP), (*uw(u, w), PARAPET_TOP), (*uw(u, w), zt), (*uw(u, -w), zt)])
    b.loft(rings, "Crown")
    # vertical fins rising through the arch (tallest in the middle reaches the full height)
    for u, top in ((0.0, HEIGHT), (-3.2, HEIGHT - 2.5), (3.2, HEIGHT - 2.5)):
        for w in (-HALF_D - 1.3, HALF_D + 1.3):
            b.extrude(rect(u - 0.5, u + 0.5, w - 0.6, w + 0.6), BODY_TOP - 14.0, top, "Crown")


PARTS = {"body": build_body, "crown": build_crown}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
