"""Low-poly model of a 122 m downtown Las Vegas hotel slab tower (id w132157010), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled (sign areas plain).

Sources:
  - height 122.0 m: project data (osm-height), trusted
  - plan and part heights (casino 9.6/11 m, garage 41.6 m, tower 122 m): footprint.json, offset 0,0
  - facade (cream concrete slab, dark window bands on the long faces, plain upper sign wall, taller core,
    cream garage with dark open decks, dark red street-level base): read off Wikimedia Commons search
    thumbnails ("The D Las Vegas.jpg", "The D Las Vegas from Carson & 3rd"); band counts est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_d_las_vegas_w132157010"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 122.0       # project data
GARAGE_TOP = 41.6    # footprint.json
ROOMS_TOP = 100.0    # top of the window bands; plain wall above (est. from photo, ~0.82 H)
MAIN_TOP = 116.0     # main parapet (est.)
BAND = 2.0           # cream spandrel between window bands (est.)
N_BANDS = 12         # grouped floors (est.)

COLORS = {
    "Wall": "EFE8D8",    # cream concrete
    "Glass": "2E3A44",   # dark hotel glazing
    "Deck": "4A4640",    # shadowed open garage decks
    "Base": "7E2A26",    # dark red street-level base
    "Roof": "8C8A84",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled((1.0, 0.45, 0.35), 0.55)
    if material == "Deck":
        return kit.scaled(WARM, 0.12)
    if material == "Wall":
        return kit.scaled(COOL, 0.35 if z > ROOMS_TOP + 0.5 else 0.08)
    return (0.0, 0.0, 0.0)


def banded(b, plan, z0, z1, n, band, fill, levels=None, mats=None):
    """Loft `plan` from z0 to z1 as n runs of `fill` separated by cream bands."""
    levels, mats = list(levels or []) + [z0], list(mats or [])
    run = (z1 - z0) / n - band
    z = z0
    for _ in range(n):
        levels += [z + run, z + run + band]
        mats += [fill, "Wall"]
        z += run + band
    return levels, mats


def build_body(b):
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    casino_w, garage, tower, casino_e = (v["outline"] for v in vols)

    # low casino blocks (grown 0.15 m so shared walls don't z-fight with the tower and garage)
    for plan, top in ((casino_w, 11.0), (casino_e, 9.6)):
        b.extrude(kit.offset_polygon(plan, 0.15), BURY, top - 1.5, "Base")
        b.extrude(kit.offset_polygon(plan, 0.15), top - 1.5, top, "Wall", top="Roof")

    # parking garage: cream slabs with dark open decks
    g = kit.offset_polygon(garage, -0.15)
    levels, mats = banded(b, g, 6.0, GARAGE_TOP, 8, 2.0, "Deck", [BURY], ["Base"])
    b.loft(kit.footprint_rings(g, levels), mats)

    # hotel slab: window bands, then the plain upper wall (sign area left blank)
    levels, mats = banded(b, tower, GARAGE_TOP + 2.0, ROOMS_TOP, N_BANDS, BAND, "Glass", [BURY], ["Wall"])
    levels += [MAIN_TOP]
    mats += ["Wall"]
    b.loft(kit.footprint_rings(tower, levels), mats)
    # taller service core / mechanical crown
    b.extrude(kit.scale_polygon(tower, 0.55), MAIN_TOP, HEIGHT, "Wall", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
