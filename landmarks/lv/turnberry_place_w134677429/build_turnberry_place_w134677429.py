"""Low-poly model of a 38-storey condominium slab tower (Las Vegas), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint): a 65.6 x 25.0 m rectangle, long axis bearing 135 deg
  - facade (cream piers, dark glass strips, balcony bands, stepped top with the centre highest):
    read off the Commons search sheet (Turnberry-Place-May-21-2010.JPG); tier heights are estimates (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "turnberry_place_w134677429"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 145.0            # project data
HALF_L, HALF_W = 32.8, 12.5   # footprint.json
TURN = -45.0              # long axis runs NW-SE (bearing 135)
BASE_TOP = 7.0            # (est.)
# stepped top, (half length, top height) per tier (est. from photo: ends lowest, centre highest)
TIERS = [(HALF_L, 119.0), (23.0, 130.0), (13.0, 139.0)]
PENT = (7.0, 7.5, HEIGHT)  # mechanical penthouse half length, half width, top
PIERS = [(-29.4, 3.4), (-15.0, 3.0), (0.0, 4.5), (15.0, 3.0), (29.4, 3.4)]  # (centre along axis, half width) (est.)
BANDS = [16.0 + 9.0 * i for i in range(12)]  # balcony / slab bands (est.)

COLORS = {
    "Wall": "E6DFCF",
    "Glass": "2A3A44",
    "Base": "CFC6B2",
    "Crown": "EFE9DC",
    "Roof": "9A9690",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.05 + 0.12 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Base":
        return kit.scaled(WARM, 0.30)
    if material == "Crown":
        return kit.scaled(WARM, 0.55)
    return (0.0, 0.0, 0.0)


A = math.radians(TURN)
U = (math.cos(A), math.sin(A))


def along(d):
    return (U[0] * d, U[1] * d)


def build_body(b):
    b.block((0, 0), HALF_L, HALF_W, BURY, BASE_TOP, "Base", turn_deg=TURN)
    z0 = BASE_TOP
    for half, top in TIERS:
        b.block((0, 0), half - 0.4, HALF_W - 0.5, z0, top, "Glass", turn_deg=TURN, top="Roof")
        z0 = top
    # cream piers running the full width, each as tall as the tier it stands in
    for c, hw in PIERS:
        top = max(t for h, t in TIERS if abs(c) - hw < h - 0.5)
        hw2 = hw
        b.block(along(c), hw2, HALF_W, BASE_TOP, top + 1.2, "Wall", turn_deg=TURN, top="Roof")
    # end piers of the upper tiers
    for (_, below), (half, top) in zip(TIERS, TIERS[1:]):
        for s in (-1, 1):
            b.block(along(s * (half - 1.5)), 1.5, HALF_W - 0.2, below - 1.0, top + 1.2, "Wall", turn_deg=TURN, top="Roof")
    # balcony bands
    for z in BANDS:
        b.block((0, 0), HALF_L - 0.2, HALF_W - 0.25, z, z + 1.1, "Wall", turn_deg=TURN)
    # lit caps on the tiers and the penthouse
    for half, top in TIERS[:2]:
        b.block((0, 0), half - 0.2, HALF_W - 0.3, top - 2.5, top + 0.4, "Crown", turn_deg=TURN, top="Roof")
    hl, hw, top = PENT
    b.block((0, 0), TIERS[2][0] - 0.2, HALF_W - 0.3, TIERS[2][1] - 2.5, TIERS[2][1] + 0.4, "Crown", turn_deg=TURN, top="Roof")
    b.block((0, 0), hl, hw, TIERS[2][1], top, "Crown", turn_deg=TURN, top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("CondoTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
