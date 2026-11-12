"""Low-poly model of a curved Las Vegas hotel tower (id w27998223), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks, murals and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height: project data (osm-height) 129.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (curved slab, rounded ends)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): blue glass with red glass on the
    rounded ends and a red band under the roof, vertical neon strips at night (red at ends, blue-violet
    in the middle), small roof penthouse. Band heights and podium height are estimates.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "rio_masquerade_tower_w27998223"
MAX_TRIS = 2_500
BURY = -2.0
HEIGHT = 129.0     # project data
H_BASE = 9.0       # est. base band
H_RED = 112.0      # est. bottom of red top band
H_PARAPET = 122.0  # est. main roof
END_X = 40.0       # est. where the red end glass starts (photo ratio)
H_END = 55.0       # est. bottom of red end glass

COLORS = {
    "GlassBlue": "2A4FA0",
    "GlassRed": "9A3A34",
    "Base": "CDBFA6",
    "Rim": "B24A3C",
    "Roof": "77757A",
    "Strip": "3A3550",
}
ROUGHNESS = {"GlassBlue": 0.25, "GlassRed": 0.3}
WINDOWS = {"GlassBlue": 1.0, "GlassRed": 1.0}
RED, VIOLET, WARM = (1.0, 0.16, 0.10), (0.42, 0.30, 1.0), (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "GlassBlue":
        return kit.scaled(VIOLET, 0.03)
    if material == "GlassRed":
        return kit.scaled(RED, 0.03)
    if material == "Strip":  # neon strips: red on the ends, blue-violet in the middle
        return kit.scaled(RED if abs(point[0]) > END_X - 6.0 else VIOLET, 0.9)
    if material == "Rim":
        return kit.scaled(RED, 0.7)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels = [BURY, H_BASE, (H_BASE, 0.6), (H_BASE + 1.5, 0.6), (H_BASE + 1.5, 0.0), H_RED,
              H_PARAPET - 1.5, (H_PARAPET - 1.5, 0.6), (H_PARAPET, 0.6), (H_PARAPET, -5.0), (HEIGHT, -5.0)]
    mats = ["Base", "Base", "Rim", "Base", "GlassBlue", "GlassRed", "Rim", "Rim", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # red glass on the rounded ends, upper part (a thin skin just outside the blue body)
    for sign in (1.0, -1.0):
        end = [p for p in plan if sign * p[0] > END_X]
        b.extrude(kit.scale_polygon(end, 1.03), H_END, H_RED, "GlassRed")

    b.fins(kit.offset_polygon(plan, 0.3), H_BASE + 1.5, H_PARAPET - 1.5, 8.5, 0.45, 0.7, "Strip")
    return b.finish("Tower_w27998223")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
