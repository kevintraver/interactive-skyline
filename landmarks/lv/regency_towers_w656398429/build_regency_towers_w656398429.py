"""Low-poly model of a residential tower (Las Vegas, id w656398429), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 97.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint). The mapped outline is an 86 x 108 m lot-sized shape,
    far too deep for a condo slab, so it is modeled as a low podium/garage (est. 7 m) and the tower is an
    (est.) 21 m deep chevron slab following the outline's bent east edge (55 m + 42 m legs).
  - facade: no usable Commons photo found; (est.) 1970s condo tower: white concrete balcony bands and
    piers over dark glass, plain mechanical penthouse.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "regency_towers_w656398429"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 97.0              # project data
PODIUM_TOP = 7.0           # (est.)
BODY_TOP = 91.0            # (est.) main roofline
LOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
# (est.) chevron slab along the east edge of the mapped outline, inset ~1.5 m, 21 m deep
TOWER = [(26.5, -43.0), (39.5, 8.4), (30.8, 45.0), (9.8, 44.0), (18.5, 8.4), (5.5, -39.0)]

COLORS = {
    "Wall": "ECE8DF",
    "Glass": "34485A",
    "Podium": "CFC8BA",
    "Crown": "E4DFD4",
    "Roof": "9A9A96",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material in ("Wall", "Podium"):
        return kit.scaled(WARM, 0.05 + 0.30 * math.exp(-max(z, 0.0) / 15.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.40)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_podium(b):
    b.extrude(LOT, BURY, PODIUM_TOP, "Podium", top="Roof")


def build_tower(b):
    b.extrude(TOWER, PODIUM_TOP, BODY_TOP, "Glass", top="Roof")
    b.fins(TOWER, PODIUM_TOP, BODY_TOP, 7.5, 0.9, 1.4, "Wall")            # (est.) concrete piers
    z = PODIUM_TOP + 6.0
    while z < BODY_TOP - 4.0:                                              # (est.) balcony slab bands, every 2 floors
        b.extrude(kit.offset_polygon(TOWER, 1.1), z, z + 1.1, "Wall")
        z += 6.0
    b.extrude(kit.offset_polygon(TOWER, 1.2), BODY_TOP - 2.0, BODY_TOP + 1.2, "Crown", top="Roof")  # parapet
    b.extrude(kit.offset_polygon(TOWER, -5.0), BODY_TOP + 1.2, HEIGHT, "Crown", top="Roof")        # penthouse


PARTS = {"podium": build_podium, "tower": build_tower}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower_w656398429")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
