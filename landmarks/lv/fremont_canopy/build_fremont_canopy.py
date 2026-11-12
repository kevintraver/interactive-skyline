"""Low-poly model of the barrel-vault LED canopy over Fremont Street (downtown Las Vegas), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_fremont_canopy.py -- --out .

Units are meters. LOCAL axes: +X runs ALONG THE STREET (toward Fourth Street, east-south-east), +Y across it,
+Z up; origin at the canopy's center on the ground. The app places it with extra.json: rotation_deg (counter-
clockwise from east) turns local +X onto the street's direction.
No logos, text or show content: the LED surface is a plain material named LedCanopy that the app animates.

Sources:
  - Centerline, length and width: OpenStreetMap (Overpass, research/osm_overpass.json). Covered pedestrian ways
    1427207960 + 1427207961 + 14322022 run straight from 36.1716055,-115.1461334 (Main St) to
    36.1698114,-115.1419927 (Fourth St): 422 m, direction -28.15 deg from east (compass 118.15). Roof outline
    way 1428180251 (building=roof) is 24.5-25.5 m wide at both ends. The street does not bend (max deviation
    of the nodes from the chord is under 0.3 m), so the vault is one straight run.
  - Published: about 1,375 ft (419 m) long, 90 ft (27 m) high at the peak (Wikipedia); matches OSM. The task's
    "about 460 m" (1,500 ft) is the older rounded figure; OSM/Wikipedia 420 m used.
  - Section shape, columns: refs/Fremont_Street_Experience_-_44239219381.jpg (deep near-semi-elliptical vault
    springing at about half the peak height; round columns in pairs set in from the edges, each branching
    into a fan of struts). 16 columns (8 pairs) is the published count; spring height 14.5 m, column inset,
    shell depth and rib sizes are (est.) from that photo.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "fremont_canopy"
MAX_TRIS = 5_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
LENGTH = 422.0            # OSM covered ways, Main St to Fourth St
HALF_L = LENGTH / 2
HALF_W = 12.5             # OSM roof outline, 24.5-25.5 m wide
PEAK = 27.0               # published 90 ft, top of structure
RIB_OUT = 0.6             # (est.) steel ribs stand this far above the skin
SHELL = 1.0               # (est.) depth of the space frame + screen, drawn as one shell
ARC_T0 = math.radians(5)  # (est.) the section is a semi-ellipse cut 5 deg above its horizontal axis
ZC = 13.5                 # (est.) ellipse center height; edges land at about 14.6 m
B_OUT = PEAK - RIB_OUT - ZC
A_OUT = HALF_W / math.cos(ARC_T0)
ARC_SEGS = 12
BAYS = 24                 # lengthwise divisions of the skin
COLUMN_PAIRS = 8          # published: 16 columns
COLUMN_Y = 6.5            # (est.) columns stand about a quarter of the width in from each edge
COLUMN_R = 0.9            # (est., bold)
COLUMN_TOP = 12.0         # (est.) where the fan of struts starts
RIBS = 17                 # (est.) arched ribs on the outside, every 26 m

# ---------------------------------------------------------------------- style
COLORS = {
    "LedCanopy": "39414E",   # the screen skin, dark by day; the app animates materials named Led*
    "Steel": "9DA2A8",       # ribs, edge beams
    "Column": "DEDBD2",      # painted columns and struts
}
ROUGHNESS = {"LedCanopy": 0.4}
WINDOWS = {}


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "LedCanopy":  # moderate neutral base; the app supplies the moving colors
        return (0.40, 0.43, 0.52)
    if material == "Column":     # lit by the street and the screen above
        return kit.scaled((1.0, 0.86, 0.70), 0.12)
    return kit.scaled((0.8, 0.88, 1.0), 0.04)


# --------------------------------------------------------------------- shape
def arc_point(j: int, inset: float) -> tuple[float, float]:
    """(y, z) of arc station j (0 = south edge .. ARC_SEGS = north edge) on the ellipse shrunk by `inset`."""
    t = math.pi - ARC_T0 - (math.pi - 2 * ARC_T0) * j / ARC_SEGS
    return ((A_OUT - inset) * math.cos(t), ZC + (B_OUT - inset) * math.sin(t))


def underside_z(y: float) -> float:
    a, bb = A_OUT - SHELL, B_OUT - SHELL
    return ZC + bb * math.sqrt(max(0.0, 1.0 - (y / a) ** 2))


def build_vault(b: kit.Builder) -> None:
    """The LED shell: a closed crescent section swept along the street."""
    section = [arc_point(j, 0.0) for j in range(ARC_SEGS + 1)] + \
              [arc_point(j, SHELL) for j in range(ARC_SEGS, -1, -1)]
    n = len(section)
    xs = [-HALF_L + LENGTH * i / BAYS for i in range(BAYS + 1)]
    rings = [[b.bm.verts.new((x, y, z)) for y, z in section] for x in xs]
    for lower, upper in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            b.face((lower[j], lower[k], upper[k], upper[j]), "LedCanopy")
    for ring, flip in ((rings[0], False), (rings[-1], True)):  # end caps as quads across the shell depth
        for j in range(ARC_SEGS):
            quad = (ring[j], ring[n - 1 - j], ring[n - 2 - j], ring[j + 1])
            b.face(quad[::-1] if flip else quad, "Steel")


def build_ribs(b: kit.Builder) -> None:
    """Arched steel ribs on the outside of the skin, and the two edge beams."""
    half = 0.5
    for i in range(RIBS):
        x = -HALF_L + half + (LENGTH - 2 * half) * i / (RIBS - 1)
        rings = []
        for j in range(ARC_SEGS + 1):
            (y0, z0), (y1, z1) = arc_point(j, 0.4), arc_point(j, -RIB_OUT)
            rings.append([(x - half, y0, z0), (x + half, y0, z0), (x + half, y1, z1), (x - half, y1, z1)])
        b.loft(rings, "Steel")
    edge_z = arc_point(0, 0.0)[1]
    for side in (-1, 1):
        b.block((0.0, side * (HALF_W - 0.3)), HALF_L + 0.6, 0.8, edge_z - 1.6, edge_z + 0.5, "Steel")


def build_columns(b: kit.Builder) -> None:
    """Eight pairs of round columns, each opening into a fan of four struts under the vault."""
    spacing = LENGTH / COLUMN_PAIRS
    reach = 10.0  # (est.) how far along the street the fan spreads
    for i in range(COLUMN_PAIRS):
        x = -HALF_L + spacing * (i + 0.5)
        for side in (-1, 1):
            y = side * COLUMN_Y
            ring = [(px, py) for px, py, _ in kit.circle(COLUMN_R, 0.0, 8, center=(x, y))]
            b.extrude(ring, BURY, COLUMN_TOP + 0.6, "Column")
            for dx in (-reach, reach):
                for ty in (side * 9.8, side * 2.5):
                    top = (x + dx, ty, underside_z(ty) + 0.4)
                    b.strut((x, y, COLUMN_TOP), top, 0.3, (0.0, side, 0.3), "Column")


PARTS = {"vault": build_vault, "ribs": build_ribs, "columns": build_columns}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("LedCanopyVault")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
