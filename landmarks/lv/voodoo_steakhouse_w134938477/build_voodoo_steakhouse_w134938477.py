"""Low-poly model of a 130 m hotel tower west of the Las Vegas Strip (id w134938477), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 130.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (56 x 24 m slab with rounded ends), offset 0,0
  - proportions/colors: Wikimedia Commons search sheet (refs/search.json/commons_sheet.jpg): blue glass center,
    red glass rounded ends that stop lower than the center, vertical neon stripes at night (red ends, blue
    center). Section heights below are estimates read off that sheet (est.).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "voodoo_steakhouse_w134938477"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 130.0      # project data
END_TOP = 114.0     # rounded ends stop lower (est. from photos)
BODY_TOP = 124.0    # center glass top (est.)
CROWN_TOP = 127.0   # lit crown band (est.)
PODIUM_TOP = 9.0    # base (est.)
SPLIT = 15.0        # |x| beyond which the plan is the red rounded end (est.)

COLORS = {
    "GlassBlue": "24448C",
    "GlassRed": "A8323C",
    "Stripe": "7A5A78",
    "Crown": "C8506A",
    "Base": "B9A58E",
    "Roof": "6E6A6C",
}
ROUGHNESS = {"GlassBlue": 0.3, "GlassRed": 0.3}
WINDOWS = {"GlassBlue": 1.0, "GlassRed": 1.0}

RED, BLUE, WARM = (1.0, 0.16, 0.12), (0.35, 0.30, 1.0), (1.0, 0.82, 0.58)


def glow(material, point, center):
    x, z = point[0], point[2]
    if material in ("GlassBlue", "GlassRed"):
        return kit.scaled(WARM, 0.03)
    if material == "Stripe":  # neon tubes: red on the ends, blue-violet on the center
        return kit.scaled(RED if abs(x) > SPLIT else BLUE, 0.9)
    if material == "Crown":
        return kit.scaled(RED, 0.7)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def clip_x(poly, x_cut, keep_greater):
    """Sutherland-Hodgman clip of a polygon against the line x = x_cut."""
    inside = (lambda p: p[0] >= x_cut) if keep_greater else (lambda p: p[0] <= x_cut)
    out = []
    for a, c in zip(poly, poly[1:] + poly[:1]):
        if inside(a):
            out.append(a)
        if inside(a) != inside(c):
            t = (x_cut - a[0]) / (c[0] - a[0])
            out.append((x_cut, a[1] + t * (c[1] - a[1])))
    return out


def build_body(b):
    plan = kit.ccw_polygon(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])
    west = clip_x(plan, -SPLIT, False)
    east = clip_x(plan, SPLIT, True)
    mid = clip_x(clip_x(plan, -SPLIT - 0.4, True), SPLIT + 0.4, False)  # overlaps the ends slightly

    b.extrude(kit.offset_polygon(plan, 1.5), BURY, PODIUM_TOP, "Base", top="Roof")
    b.extrude(west, PODIUM_TOP - 0.5, END_TOP, "GlassRed", top="Roof")
    b.extrude(east, PODIUM_TOP - 0.5, END_TOP, "GlassRed", top="Roof")
    b.extrude(mid, PODIUM_TOP - 0.5, BODY_TOP, "GlassBlue", top="Roof")
    # red cap bands on the ends, lit crown on the center, plain rooftop block (sign area left plain)
    b.extrude(kit.offset_polygon(west, 0.3), END_TOP - 2.5, END_TOP + 0.6, "Crown", top="Roof")
    b.extrude(kit.offset_polygon(east, 0.3), END_TOP - 2.5, END_TOP + 0.6, "Crown", top="Roof")
    b.extrude(kit.offset_polygon(mid, 0.3), BODY_TOP - 0.5, CROWN_TOP, "Crown", top="Roof")
    b.block((0.0, 0.0), 10.0, 6.0, CROWN_TOP - 0.5, HEIGHT, "Roof")
    # vertical neon stripes
    b.fins(plan, PODIUM_TOP, END_TOP - 2.5, 5.0, 0.35, 0.5, "Stripe")
    b.fins(mid, END_TOP + 0.6, BODY_TOP - 0.5, 5.0, 0.35, 0.5, "Stripe")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower_w134938477")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
