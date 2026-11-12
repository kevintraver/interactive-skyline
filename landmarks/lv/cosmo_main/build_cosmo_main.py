"""Low-poly model of a Las Vegas Strip resort hotel tower (east tower, id w134795273), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_cosmo_main.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: the crown screen is a plain dark panel.

Sources:
  - height 184.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (exact mapped outline, offset 0,0)
  - crown screen height/slope, podium height, band count: read off
    refs/Cosmopolitan_-_North_-_2011-06-04.jpg (est.)
  - which side of the crown is high (east): est. from the same photo (taken from the north)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "cosmo_main"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 184.0          # project data
ROOF = 170.0            # top of room floors (est., photo ratio ~0.92)
CROWN_LOW = 174.0       # low (west) edge of the sloped crown screen (est.)
PODIUM_TOP = 24.0       # plain base below the banded floors (est.)
BANDS = 44              # white slab-edge bands, one per ~3.3 m (est.; real tower has ~50 floors)
BAND_T = 0.9            # band thickness, exaggerated to read from afar
BAND_OUT = 1.018        # bands project ~0.5 m beyond the glass

COLORS = {
    "Glass": "2B3948",       # dark blue-grey curtain wall
    "Band": "D9DDE0",        # white balcony / slab edges
    "BandAccent": "D9DDE0",  # same color; lit blue at night
    "Base": "8E9499",        # podium-level wall
    "CrownPanel": "1B222B",  # dark sloped screen wall (signage omitted)
    "Roof": "5A5F64",
}
ROUGHNESS = {"Glass": 0.3, "CrownPanel": 0.4}

WARM, COOL, BLUE = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0), (0.15, 0.3, 1.0)
ACCENT_BANDS = {5, 11, 16, 22, 27, 33, 38}


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "Glass":
        return kit.scaled(WARM, 0.07)
    if material == "Band":
        return kit.scaled(COOL, 0.16)
    if material == "BandAccent":
        return kit.scaled(BLUE, 0.9)
    if material == "CrownPanel":  # soft wash at the top edge, no sign
        return kit.scaled(COOL, 0.02 + 0.12 * max(0.0, (point[2] - ROOF) / (HEIGHT - ROOF)))
    if material == "Base":
        return kit.scaled(WARM, 0.08)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(outline, BURY, PODIUM_TOP, "Base")
    b.extrude(kit.scale_polygon(outline, 0.995), PODIUM_TOP, ROOF, "Glass", top="Roof")
    proud = kit.scale_polygon(outline, BAND_OUT)
    step = (ROOF - PODIUM_TOP - 2.0) / (BANDS - 1)
    for i in range(BANDS):
        z = PODIUM_TOP + 1.0 + i * step
        b.extrude(proud, z, z + BAND_T, "BandAccent" if i in ACCENT_BANDS else "Band")

    # Crown: screen wall whose top is one tilted plane, low on the west, full height on the east.
    ring = kit.scale_polygon(outline, 0.97)[::-1]  # counter-clockwise
    xs = [p[0] for p in ring]
    x0, x1 = min(xs), max(xs)
    top = [(x, y, CROWN_LOW + (HEIGHT - CROWN_LOW) * (x - x0) / (x1 - x0)) for x, y in ring]
    b.loft([[(x, y, ROOF - 0.5) for x, y in ring], top], "CrownPanel")


PARTS = {"body": build_body}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={'Glass': 1.0})  # lit windows at night (orchestrator)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("ResortTowerEast")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
