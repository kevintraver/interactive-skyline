"""Low-poly model of a curved Las Vegas hotel slab tower (id w134938481), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks, murals and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height: project data (osm-height) 120.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (curved slab, rounded ends)
  - facade: Commons search sheet (refs/search/commons_sheet.jpg, photos 3-5): blue glass, red glass on the
    rounded ends and a red band under the roof, vertical neon strips at night (red at the ends,
    blue-violet in the middle), set-back roof penthouse. All band heights are estimates.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "rio_all_suite_hotel_an_w134938481"
MAX_TRIS = 2_500
BURY = -2.0
HEIGHT = 120.0     # project data
H_BASE = 8.0       # est. base band
H_RED = 104.0      # est. bottom of red top band
H_PARAPET = 114.0  # est. main roof
END_X = 36.0       # est. where the red end glass starts (photo ratio)
H_END = 45.0       # est. bottom of red end glass

COLORS = {
    "GlassBlue": "2B55A8",
    "GlassRed": "A03C34",
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
    if material == "Strip":
        return kit.scaled(RED if abs(point[0]) > END_X - 5.0 else VIOLET, 0.9)
    if material == "Rim":
        return kit.scaled(RED, 0.7)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels = [BURY, H_BASE, (H_BASE, 0.6), (H_BASE + 1.5, 0.6), (H_BASE + 1.5, 0.0), H_RED,
              H_PARAPET - 1.5, (H_PARAPET - 1.5, 0.6), (H_PARAPET, 0.6), (H_PARAPET, -4.0), (HEIGHT, -4.0)]
    mats = ["Base", "Base", "Rim", "Base", "GlassBlue", "GlassRed", "Rim", "Rim", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    for sign in (1.0, -1.0):  # red glass skin on the rounded ends, upper part
        end = [p for p in plan if sign * p[0] > END_X]
        b.extrude(kit.scale_polygon(end, 1.03), H_END, H_RED, "GlassRed")

    b.fins(kit.offset_polygon(plan, 0.3), H_BASE + 1.5, H_PARAPET - 1.5, 9.0, 0.45, 0.7, "Strip")
    return b.finish("Tower_w134938481")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
