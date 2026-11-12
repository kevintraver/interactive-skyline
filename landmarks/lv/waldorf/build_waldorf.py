"""Low-poly model of a two-wing glass hotel tower on the Las Vegas Strip (id w52194829), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_waldorf.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown corner that carries one is plain.

Sources:
  - height 164.4 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), the mapped V-shaped two-wing outline
  - recessed dark sky-lobby band at ~0.40-0.44 of the height: read off refs/Mandarin_Oriental_Las_Vegas_NV.jpg
  - roof step between the wings (~4 m), which wing is taller, fin spacing and depth: (est.) from
    refs/Mandarin_Oriental_-_East_-_2011-06-04.jpg
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "waldorf"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 164.4            # project data (lidar)
BAND_Z0, BAND_Z1 = 66.0, 72.5   # recessed sky-lobby band, photo ratio x height
ROOF_LOW = 160.4          # lower (north-west) wing roof (est. one storey below the top)
BAND_INSET = 0.965        # band recess, scale about the plan center (est.)
FIN_SPACING = 4.5         # bold stand-in for the many gold mullion fins (est.)
FIN_HALF = 0.4

COLORS = {
    "FacadeGlass": "5F8496",   # blue-green reflective curtain wall
    "GoldFin": "B59C64",       # champagne-gold vertical fins
    "LobbyBand": "15181B",     # dark recessed sky-lobby glazing
    "Roof": "74777A",
}
ROUGHNESS = {"FacadeGlass": 0.3, "LobbyBand": 0.3}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "FacadeGlass":   # the app's lit-window pattern supplies the light
        return kit.scaled(WARM, 0.03)
    if material == "LobbyBand":     # the sky lobby glows warm at night
        return kit.scaled(WARM, 0.4)
    if material == "GoldFin":
        return kit.scaled(WARM, 0.05)
    return (0.0, 0.0, 0.0)


def fins(b: kit.Builder, outline, z0: float, z1: float) -> None:
    pts = list(outline)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2
    if area < 0:
        pts.reverse()
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 6.0:
            continue
        nx, ny = (y1 - y0) / length, -(x1 - x0) / length   # outward for a counter-clockwise outline
        count = max(1, round(length / FIN_SPACING))
        for i in range(count):
            t = (i + 0.5) / count
            x = x0 + (x1 - x0) * t + nx * 0.15
            y = y0 + (y1 - y0) * t + ny * 0.15
            b.strut((x, y, z0), (x, y, z1), FIN_HALF, (nx, ny, 0.0), "GoldFin")


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = fp["volumes"][0]["outline"]
    # the south-east wing (first ten points of the outline, closed along the crease) stands a storey taller
    tall_wing = [outline[i] for i in (0, 1, 2, 3, 4, 5, 13, 14, 15, 16)]
    b.extrude(outline, BURY, BAND_Z0, "FacadeGlass", top="Roof")
    b.extrude(kit.scale_polygon(outline, BAND_INSET, (0.0, 0.0)), BAND_Z0 - 0.1, BAND_Z1 + 0.1, "LobbyBand")
    b.extrude(outline, BAND_Z1, ROOF_LOW, "FacadeGlass", top="Roof")
    b.extrude(tall_wing, ROOF_LOW - 0.1, HEIGHT, "FacadeGlass", top="Roof")
    fins(b, outline, 0.0, BAND_Z0 - 0.3)
    fins(b, outline, BAND_Z1 + 0.3, ROOF_LOW - 0.5)


PARTS = {"body": build_body}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"FacadeGlass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
