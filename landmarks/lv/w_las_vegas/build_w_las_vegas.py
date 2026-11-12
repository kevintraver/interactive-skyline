"""Low-poly model of the L-plan gold-glass hotel tower at the south end of the Las Vegas Strip (id w118347176).

    python <skill>/scripts/run_blender.py build_w_las_vegas.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown band is a plain surface.

Sources:
  - height 148.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), extruded exactly
  - crown band ~8% of height, fins stopping ~12% below the crown, staggered fin tops, podium height:
    ratios read off refs/Delano_Hotel_Las_Vegas.jpg and refs/The_Hotel_at_Mandalay_Bay.jpg (est.)
  - fin spacing / width / depth: (est.) from the same photos (about 11 fins on the 80 m face)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "w_las_vegas"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 148.0        # project data
PODIUM_TOP = 9.0      # est. from photo
CROWN_BASE = 136.0    # est.: crown band = 12 m (8% of height, photo ratio)
FIN_BASE = PODIUM_TOP
FIN_TOP_HI = 124.0    # est.: tallest fins stop ~12 m under the crown
FIN_TOP_LO = 112.0    # est.: fins near the corners are shorter (staggered tops in the photo)
FIN_HALF_W = 0.7      # est.
FIN_DEPTH = 0.9       # est. projection from the glass
FIN_SPACING = 7.0     # est.

COLORS = {
    "GoldGlass": "E0B02A",
    "CrownBand": "E4E2DC",
    "Fin": "E6E0D0",
    "Podium": "CDBE9C",
    "Roof": "8C8A84",
}
ROUGHNESS = {"GoldGlass": 0.25}
WARM, WHITE = (1.0, 0.80, 0.50), (1.0, 0.96, 0.88)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "GoldGlass":
        return kit.scaled(WARM, 0.03)   # the app's lit windows supply the light
    if material == "CrownBand":
        return kit.scaled(WHITE, 0.55)  # floodlit band
    if material == "Fin":
        return kit.scaled(WARM, 0.10)
    if material == "Podium":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def fins_along(b: kit.Builder, a, c, normal) -> None:
    """Vertical fins on the wall from a to c (axis-aligned faces), projecting along `normal`."""
    length = ((c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2) ** 0.5
    n = max(2, int(length // FIN_SPACING))
    for i in range(n):
        t = (i + 0.5) / n
        x, y = a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t
        edge = min(i, n - 1 - i)
        top = FIN_TOP_LO if edge == 0 else FIN_TOP_HI
        cx, cy = x + normal[0] * FIN_DEPTH / 2, y + normal[1] * FIN_DEPTH / 2
        hx = FIN_HALF_W if normal[0] == 0 else FIN_DEPTH
        hy = FIN_HALF_W if normal[1] == 0 else FIN_DEPTH
        b.block((cx, cy), hx, hy, FIN_BASE, top, "Fin")


def build_body(b: kit.Builder) -> None:
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(kit.scale_polygon(plan, 1.03), BURY, PODIUM_TOP, "Podium", top="Roof")
    b.extrude(plan, PODIUM_TOP, CROWN_BASE, "GoldGlass")
    b.extrude(kit.scale_polygon(plan, 1.008), CROWN_BASE, HEIGHT, "CrownBand", top="Roof")
    # long faces of the L (coordinates from footprint.json)
    fins_along(b, (-28.0, -24.0), (-28.0, 48.0), (-1, 0))    # west face
    fins_along(b, (-25.0, -26.7), (50.0, -27.9), (0, -1))    # south face
    fins_along(b, (-3.0, -8.2), (51.0, -8.5), (0, 1))        # north face of east wing
    fins_along(b, (-7.0, -5.0), (-7.5, 48.0), (1, 0))        # east face of north wing


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"GoldGlass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("HotelTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
