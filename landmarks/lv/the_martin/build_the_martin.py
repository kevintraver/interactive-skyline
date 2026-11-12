"""Low-poly model of a slender residential glass tower (Las Vegas), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_the_martin.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground (offset 0,0).
No logos, wordmarks or signage are modeled.

Sources:
  - height 157.0 m: project data (osm-height), trusted.
  - plan: footprint.json (skyline_tool footprint). Volume 2 (top 157.0) is the tower slab, ~67 x 28 m.
    Volume 1 (whole L-shaped lot) is treated as the tower plus a low parking podium on the east side,
    because refs/Panorama_Towers_-_East_-_2010-03-06.jpg and the night photo show one slender slab with a
    low garage beside it. Podium height 20 m (est., ~1/8 of the tower in the night photo).
  - roof step: lower bay 148.2 m (the other height in footprint.json), taller bay 157.0 m; which bay is
    the taller one (north) is estimated. Photos show one end bay about two floors below the other.
  - white balcony bands: one per ~2 floors (est. simplification of the per-floor slab edges in the photos).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_martin"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 157.0           # project data
LOW_ROOF = 148.2         # footprint.json volume 1 top
PODIUM_TOP = 20.0        # est.
BAND_PITCH = 6.8         # est. (2 floors)
BAND_DEPTH = 1.3         # est. white slab-edge band height
SPLIT_Y = -6.63          # the slot between the two end bays (footprint.json notch)

FOOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))
LOT = FOOT["volumes"][0]["outline"]
TOWER_RAW = FOOT["volumes"][1]["outline"]


def simplify(points, min_gap):
    """Drop points closer than min_gap to the last kept one (rounded corners become chamfers)."""
    kept = [points[0]]
    for p in points[1:]:
        if ((p[0] - kept[-1][0]) ** 2 + (p[1] - kept[-1][1]) ** 2) ** 0.5 >= min_gap:
            kept.append(p)
    if ((kept[-1][0] - kept[0][0]) ** 2 + (kept[-1][1] - kept[0][1]) ** 2) ** 0.5 < min_gap:
        kept.pop()
    return kept


TOWER = simplify(TOWER_RAW, 1.6)
# taller (north) bay: the part of the tower plan north of the slot line
NORTH = simplify([p for p in TOWER_RAW if p[1] > SPLIT_Y + 0.5], 1.6)
NORTH = NORTH + [(NORTH[-1][0], SPLIT_Y), (NORTH[0][0], SPLIT_Y)]
# podium: east part of the lot outline, closed by a line running inside the tower
PODIUM = simplify([p for p in LOT if p[0] > -19.6 and not (-19.6 < p[0] < -19.4 and p[1] > -20.0)], 1.6)

COLORS = {  # sRGB, from the daylight photo
    "Glass": "3D5F80",
    "Band": "D9DEE0",
    "Podium": "B9B4A8",
    "Roof": "7E8488",
}
ROUGHNESS = {"Glass": 0.3}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(COOL, 0.03)
    if material == "Band":
        return kit.scaled(COOL, 0.10)
    if material == "Podium":
        return kit.scaled(WARM, 0.14)
    return (0.0, 0.0, 0.0)


def banded(b, outline, z0, z1, top_band=True):
    """Glass shaft with flush white bands, one loft (no hidden caps between bands)."""
    area = sum(a[0] * c[1] - c[0] * a[1] for a, c in zip(outline, outline[1:] + outline[:1]))
    outline = list(outline) if area > 0 else list(outline)[::-1]  # counter-clockwise: walls face out
    levels, mats = [z0], []
    z = max(z0, 0.0) + BAND_PITCH
    while z + BAND_DEPTH < z1 - 4.0:
        levels += [z, z + BAND_DEPTH]
        mats += ["Glass", "Band"]
        z += BAND_PITCH
    if top_band:
        levels += [z1 - 1.8, z1]
        mats += ["Glass", "Band"]
    else:
        levels.append(z1)
        mats.append("Glass")
    rings = [[(x, y, lv) for x, y in outline] for lv in levels]
    b.loft(rings, mats, cap=True)


def build_tower(b):
    banded(b, TOWER, BURY, LOW_ROOF)
    banded(b, NORTH, LOW_ROOF, HEIGHT)


def build_podium(b):
    b.extrude(PODIUM, BURY, PODIUM_TOP, "Podium", top="Roof")
    b.extrude(kit.scale_polygon(PODIUM, 1.012), PODIUM_TOP - 1.2, PODIUM_TOP + 0.6, "Band", top="Roof")


PARTS = {"tower": build_tower, "podium": build_podium}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
