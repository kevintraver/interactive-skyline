"""Low-poly model of the bell-tower replica w43875964 (Las Vegas), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin = footprint center (installs with offset 0,0).
No logos or signage. The relief panels on the attic are left plain; the top figure is a simple gold finial.

Sources:
  - height 96.0 m: project data (osm-height), trusted
  - plan: footprint.json: a square about 16.4 m (incl. base/cornice overhang), turned 8.6 deg; the shaft
    itself is taken as 13.2 m wide (ratio of shaft width to height in refs/Campanile_Tower_-_Venetian_-_2.jpg, est.)
  - section levels (shaft top, arcade band, belfry, attic, spire, finial): ratios read off the same photo,
    cross-checked with refs/Campanile_Tower_and_fountain_at_The_Venetian_Las_Vegas.jpg (est.)
  - colors by day from the aerial photo, night levels from the fountain night photo (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "venetian_campanile"
MAX_TRIS = 5_000

BURY = -2.0
HEIGHT = 96.0
TURN = math.radians(8.6)   # footprint edge bearing 81.4 deg
BASE_TOP = 4.5             # white stone base (est.)
SHAFT_HALF = 6.6
SHAFT_TOP = 46.0           # top of the brick shaft
BAND_TOP = 51.0            # white blind-arcade band
BELFRY_TOP = 61.0          # open arcade storey
ATTIC0, ATTIC1 = 62.5, 70.0
ATTIC_HALF = 5.6
SPIRE0, SPIRE1 = 70.5, 91.5
SPIRE_HALF = 5.9

COLORS = {
    "Brick": "9C5B45",
    "Rib": "8A4D3A",
    "Stone": "EFE8DA",
    "Spire": "C2DDCC",     # pale green copper-look roof
    "Dark": "2B2622",      # belfry openings
    "Gold": "D8A62E",
}
ROUGHNESS = {"Gold": 0.35}
WARM = (1.0, 0.85, 0.62)


def glow(material, point, center):
    z = point[2]
    if material in ("Brick", "Rib"):   # flood-lit from the base, fading upward
        return kit.scaled((1.0, 0.55, 0.38), 0.2 + 0.2 * math.exp(-max(z, 0.0) / 30.0))  # brick-tinted
    if material == "Stone":            # belfry and cornices are the bright part
        return kit.scaled(WARM, 0.5 if z >= SHAFT_TOP - 1 else 0.3)
    if material == "Spire":
        return kit.scaled((0.85, 1.0, 0.85), 0.3)
    if material == "Gold":
        return kit.scaled((1.0, 0.8, 0.35), 0.6)
    if material == "Dark":
        return kit.scaled(WARM, 0.04)
    return (0.0, 0.0, 0.0)


def rot(x, y):
    c, s = math.cos(TURN), math.sin(TURN)
    return (x * c - y * s, x * s + y * c)


def sq(half, z=None):
    pts = [rot(half, -half), rot(half, half), rot(-half, half), rot(-half, -half)]  # counter-clockwise
    return pts if z is None else [(x, y, z) for x, y in pts]


def face_frame(k):
    """Outward normal and tangent (tangent x up = normal) of face k."""
    a = TURN + k * math.pi / 2
    n = (math.cos(a), math.sin(a))
    return n, (-n[1], n[0])


def slab(b, k, half, u, w, proud, z0, z1, material):
    n, t = face_frame(k)

    def pt(uu, v):
        return (t[0] * uu + n[0] * (half + v), t[1] * uu + n[1] * (half + v))
    b.extrude([pt(u - w / 2, -0.4), pt(u + w / 2, -0.4), pt(u + w / 2, proud), pt(u - w / 2, proud)], z0, z1, material)


def arch(b, k, half, u, w, proud, z0, z1, material, seg=4):
    n, t = face_frame(k)
    r = w / 2
    zs = z1 - r
    prof = [(u - r, z0), (u + r, z0)] + [
        (u + r * math.cos(math.pi * i / seg), zs + r * math.sin(math.pi * i / seg)) for i in range(seg + 1)]

    def ring(v):
        return [(t[0] * uu + n[0] * (half + v), t[1] * uu + n[1] * (half + v), z) for uu, z in prof]
    b.loft([ring(-0.4), ring(proud)], material)


def build_tower(b):
    h = SHAFT_HALF
    b.extrude(sq(h + 1.4), BURY, BASE_TOP, "Stone")
    b.extrude(sq(h + 0.7), BASE_TOP, BASE_TOP + 1.2, "Stone")
    b.extrude(sq(h), BASE_TOP + 1.2, SHAFT_TOP, "Brick")
    for k in range(4):
        # brick pilaster strips (lesene) and a column of small white-framed windows, off-center as on the tower
        for u in (-h + 0.7, -2.2, 2.2, h - 0.7):
            slab(b, k, h, u, 1.4, 0.3, BASE_TOP + 1.2, SHAFT_TOP, "Rib")
        for i in range(7):
            z = 11.0 + i * 5.0
            arch(b, k, h, -4.3 + 0.0, 1.1, 0.12, z, z + 2.2, "Stone", seg=2)
    # white band with projecting cornices
    b.extrude(sq(h + 0.5), SHAFT_TOP, BAND_TOP - 1.0, "Stone")
    b.extrude(sq(h + 1.5), BAND_TOP - 1.0, BAND_TOP, "Stone")
    # belfry: four arched openings per face
    b.extrude(sq(h), BAND_TOP, BELFRY_TOP - 1.2, "Stone")
    for k in range(4):
        for i in range(4):
            arch(b, k, h, (i - 1.5) * 2.3, 1.7, 0.1, BAND_TOP + 2.2, BELFRY_TOP - 2.6, "Dark", seg=4)
    b.extrude(sq(h + 1.6), BELFRY_TOP - 1.2, BELFRY_TOP, "Stone")
    b.extrude(sq(h + 0.4), BELFRY_TOP, ATTIC0, "Stone")
    # attic: brick block in a white frame (relief panels left plain)
    a = ATTIC_HALF
    b.extrude(sq(a), ATTIC0, ATTIC1 - 1.0, "Stone")
    for k in range(4):
        slab(b, k, a, 0.0, 2 * a - 2.0, 0.15, ATTIC0 + 1.0, ATTIC1 - 2.0, "Brick")
    b.extrude(sq(a + 0.8), ATTIC1 - 1.0, SPIRE0, "Stone")
    # spire: pale green pyramid with white hips
    tip = 0.45
    b.loft([sq(SPIRE_HALF, SPIRE0), sq(tip, SPIRE1)], "Spire")
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        x0, y0 = rot(sx * SPIRE_HALF, sy * SPIRE_HALF)
        x1, y1 = rot(sx * tip, sy * tip)
        b.strut((x0, y0, SPIRE0 + 0.1), (x1, y1, SPIRE1), 0.75, (x0, y0, 0.0), "Stone")
    # finial: white pedestal, gold figure as a simple tapered form
    b.extrude(sq(0.9), SPIRE1 - 0.6, SPIRE1 + 1.2, "Stone")
    b.loft([sq(0.55, SPIRE1 + 1.2), sq(0.75, SPIRE1 + 3.0), sq(0.2, HEIGHT)], "Gold")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS)
    build_tower(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
