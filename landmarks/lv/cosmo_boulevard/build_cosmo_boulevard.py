"""Low-poly model of the east (boulevard-side) hotel tower of a two-tower resort, Las Vegas.

    python <skill>/scripts/run_blender.py build_cosmo_boulevard.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the mapped footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown panel is a plain dark surface.

Sources:
  - height 184.0 m: project data (osm-height), trusted
  - podium plan: footprint.json (skyline_tool.py footprint, id w472669744), exact
  - tower slab plan (72 x 30 m at base, flaring to 78 x 33 m), its position on the podium, podium height,
    crown slope and band spacing: (est.) read off refs/Cosmopolitan_-_North_-_2011-06-04.jpg and the night photo
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "cosmo_boulevard"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 184.0                 # project data
PODIUM_TOP = 22.0              # (est.) north photo
SHAFT_TOP = 170.0              # (est.) roof line at the low (west) end of the crown
CROWN_LOW = 174.0              # (est.) crown parapet, west end
TOWER_CENTER = (8.0, -6.0)     # (est.) slab sits toward the east end of the podium
BASE_HALF = (36.0, 15.0)       # (est.) half sizes at podium level
TOP_HALF = (39.0, 16.5)        # (est.) the slab flares outward toward the top (north photo)
BAND_COUNT = 20                # bold stand-in for ~50 balcony slab edges
BAND_THICK = 1.0
BAND_OUT = 0.7

COLORS = {
    "Glass": "2B3640",        # dark grey-blue glass
    "Band": "C9CCCB",         # pale balcony slab edges
    "Podium": "D6D3CB",       # off-white podium walls
    "PodiumRoof": "8E9092",
    "CrownPanel": "1B2026",   # dark screen wall at the top, left plain
}
ROUGHNESS = {"Glass": 0.3, "CrownPanel": 0.4}

WARM, BLUE = (1.0, 0.82, 0.58), (0.25, 0.35, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)       # the app's lit windows supply the light
    if material == "Band":
        return kit.scaled(BLUE, 0.30)       # blue LED streaks along the balcony edges (night photo)
    if material == "Podium":
        return kit.scaled(WARM, 0.14)
    if material == "CrownPanel":
        return kit.scaled(BLUE, 0.03)
    return (0.0, 0.0, 0.0)


def half_at(z):
    t = (z - PODIUM_TOP) / (SHAFT_TOP - PODIUM_TOP)
    return (BASE_HALF[0] + (TOP_HALF[0] - BASE_HALF[0]) * t, BASE_HALF[1] + (TOP_HALF[1] - BASE_HALF[1]) * t)


def rect(z, grow=0.0, zs=None):
    hx, hy = half_at(min(z, SHAFT_TOP))
    hx, hy = hx + grow, hy + grow
    cx, cy = TOWER_CENTER
    corners = [(cx - hx, cy - hy), (cx + hx, cy - hy), (cx + hx, cy + hy), (cx - hx, cy + hy)]
    zs = zs or [z] * 4
    return [(x, y, zz) for (x, y), zz in zip(corners, zs)]


def build_podium(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    b.extrude(fp["volumes"][0]["outline"], BURY, PODIUM_TOP, "Podium", top="PodiumRoof")


def build_tower(b):
    b.loft([rect(PODIUM_TOP - 1.0), rect(PODIUM_TOP + 40), rect(SHAFT_TOP)], "Glass")
    step = (SHAFT_TOP - PODIUM_TOP) / BAND_COUNT
    for i in range(1, BAND_COUNT + 1):
        z = PODIUM_TOP + i * step
        b.loft([rect(z - BAND_THICK, BAND_OUT), rect(z, BAND_OUT)], "Band")


def build_crown(b):
    # sloped screen wall: low at the west end, rising to the full height at the east end
    low = rect(SHAFT_TOP - 0.5, -1.2)
    high = rect(SHAFT_TOP, -1.2, zs=[CROWN_LOW, HEIGHT, HEIGHT, CROWN_LOW])
    b.loft([low, high], "CrownPanel")


PARTS = {"podium": build_podium, "tower": build_tower, "crown": build_crown}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("EastTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
