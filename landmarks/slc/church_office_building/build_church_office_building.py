"""Low-poly model of the Church Office Building (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_church_office_building.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
No signage or logos modeled.

Sources:
  - height 128 m core, 110 m wings, 19 m podium: project data (osm-height), footprint.json volumes
  - plan: mapped footprint (skyline_tool footprint)
  - colors and fin rhythm (est.) read from Commons photos (cream precast piers, dark narrow windows)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "church_office_building"
MAX_TRIS = 5_000

BURY = -2.0
HEIGHT = 128.0   # project data
WING_TOP = 110.0  # project data
PODIUM_TOP = 19.0  # project data
FIN_SPACING = 1.7   # photos: ~27 window strips across the 41 m wing face (1.5 m); 1.7 for the budget
FIN_WIDTH = 1.1     # precast pier; the dark strip between piers is ~0.6 m
FIN_DEPTH = 0.5
PARAPET = 4.0       # solid precast band above the strips (photo)
RECESS_TOP = 23.0   # dark recessed floor between podium roof and tower (photo)
RECESS_INSET = 1.2
CORE_SLOT_BASE = 114.0  # short slots on the core above the wing roofs (photo)
COLONNADE_HALF = 38.0
COLONNADE_TOP = 15.0

COLORS = {"Precast": "E9E4D6", "Glass": "3C424B", "Dark": "2A2E33", "Screen": "5A5D61", "Roof": "9A9C9E"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Precast":
        return kit.scaled(WARM, 0.12 + 0.3 * math.exp(-max(z, 0.0) / 30.0))  # soft floodlight from below
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Dark":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def bounds(poly):
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return min(xs), max(xs), min(ys), max(ys)


def piers(b: kit.Builder, a: float, c: float, fixed: float, sign: int, along_x: bool, z0: float, z1: float) -> None:
    """Precast piers on an axis-aligned wall running a..c at coordinate `fixed`, facing `sign`; the end piers
    are double width so every corner is solid, as in the photos."""
    length = c - a
    n = max(2, round(length / FIN_SPACING))
    pitch = length / n
    for i in range(n + 1):
        w = FIN_WIDTH * (2.0 if i in (0, n) else 1.0)
        t = min(max(a + i * pitch, a + w / 2), c - w / 2)
        off = fixed + sign * (FIN_DEPTH / 2 - 0.05)
        half_d = FIN_DEPTH / 2 + 0.05
        if along_x:
            b.block((t, off), w / 2, half_d, z0, z1, "Precast")
        else:
            b.block((off, t), half_d, w / 2, z0, z1, "Precast")


def build_podium(b: kit.Builder, podium) -> None:
    b.extrude(podium, BURY, PODIUM_TOP, "Precast", top="Roof")
    x0, x1, y0, y1 = bounds(podium)
    # recessed entrance colonnades (north street front, south plaza front): dark recess, cream columns
    for y, sign in ((y1, 1), (-25.82, -1)):
        b.block((0.0, y + sign * 0.1), COLONNADE_HALF, 0.2, 1.0, COLONNADE_TOP, "Dark")
        n = 12
        for i in range(n + 1):
            x = -COLONNADE_HALF + 2 * COLONNADE_HALF * i / n
            b.block((x, y + sign * 0.35), 0.7, 0.45, 0.0, COLONNADE_TOP, "Precast")


def build_tower(b: kit.Builder, core, west, east) -> None:
    for vol, top in ((west, WING_TOP), (east, WING_TOP), (core, HEIGHT)):
        b.extrude(kit.offset_polygon(vol, -RECESS_INSET), PODIUM_TOP - 0.5, RECESS_TOP, "Dark")  # shadow floor
        b.extrude(vol, RECESS_TOP, top, "Glass", top="Roof")
        b.extrude(kit.offset_polygon(vol, FIN_DEPTH), top - PARAPET, top, "Precast", top="Roof")  # solid cap band
        b.extrude(kit.offset_polygon(vol, FIN_DEPTH), RECESS_TOP, RECESS_TOP + 1.5, "Precast")     # sill band
    z0 = RECESS_TOP + 1.5
    for wing, outer_sign in ((west, -1), (east, 1)):
        x0, x1, y0, y1 = bounds(wing)
        # low mechanical screen on each wing roof, set back from the edge (photo)
        b.block(((x0 + x1) / 2 + outer_sign * 1.0, (y0 + y1) / 2), (x1 - x0) / 2 - 3.5, (y1 - y0) / 2 - 4.0,
                WING_TOP - 0.2, WING_TOP + 3.0, "Screen", top="Roof")
        zt = WING_TOP - PARAPET
        piers(b, y0, y1, x0 if outer_sign < 0 else x1, outer_sign, False, z0, zt)  # broad 41 m face
        piers(b, x0, x1, y0, -1, True, z0, zt)
        piers(b, x0, x1, y1, 1, True, z0, zt)
    x0, x1, y0, y1 = bounds(core)
    piers(b, x0, x1, y0, -1, True, z0, HEIGHT - PARAPET)                          # south face, full height
    # north face of the core: plain precast (service core) with two columns of small windows
    b.block(((x0 + x1) / 2, y1 + FIN_DEPTH / 2 - 0.05), (x1 - x0) / 2, FIN_DEPTH / 2 + 0.05, z0, HEIGHT - PARAPET, "Precast")
    for x in (x0 + 5.5, x0 + 9.5):
        b.block((x, y1 + FIN_DEPTH), 0.5, 0.08, z0 + 3.0, HEIGHT - PARAPET - 3.0, "Glass")
    # core above the wing roofs: plain band, then a row of short slots under the cap
    for x, sign in ((x0, -1), (x1, 1)):
        b.block((x + sign * (FIN_DEPTH / 2 - 0.05), (y0 + y1) / 2), FIN_DEPTH / 2 + 0.05, (y1 - y0) / 2,
                WING_TOP - 0.5, CORE_SLOT_BASE, "Precast")
        piers(b, y0, y1, x, sign, False, CORE_SLOT_BASE, HEIGHT - PARAPET)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    podium, core, west, east = [v["outline"] for v in fp["volumes"]]
    build_podium(b, podium)
    build_tower(b, core, west, east)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
