"""Low-poly model of a downtown Las Vegas hotel (id w544016661), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the footprint center. No logos or signs: sign areas plain.

Sources:
  - height 47.0 m: project data (trusted); volume tops 47.0 / 39.4 / 35.9 / 16.2 m: footprint.json (skyline_tool)
  - plan: footprint.json volumes, extruded as mapped (offset 0,0)
  - facade (white piers with dark vertical window strips, red roofline band, low casino base with red bands):
    Wikimedia Commons "File:The Cal.jpg" (search sheet only); pier spacing, band heights are estimates
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "california_hotel_and_c_w544016661"
MAX_TRIS = 2500
BURY = -2.0

COLORS = {"Wall": "E6E0D2", "Glass": "27343C", "Roof": "8A8C8E", "Trim": "B8332C", "Base": "D9CDB8"}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)
RED = (1.0, 0.25, 0.15)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "Trim":   # red roofline / canopy bands (plain light, no sign)
        return kit.scaled(RED, 0.75)
    if material == "Base":   # street-level spill
        return kit.scaled(WARM, 0.35)
    return (0.0, 0.0, 0.0)


def clean(outline, tol=0.6):
    out = []
    for p in outline:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    while len(out) > 3 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def tower(b, plan, top, spacing):
    """Glass body with white piers (fins), solid parapet and a red roofline band."""
    b.extrude(plan, BURY, top - 2.2, "Glass", top="Roof")
    b.fins(plan, BURY, top - 2.2, spacing, 0.5, spacing * 0.5, "Wall")
    b.extrude(kit.offset_polygon(plan, 0.5), top - 2.2, top - 1.0, "Wall", top="Roof", bottom="Wall")
    b.extrude(kit.offset_polygon(plan, 0.7), top - 1.0, top, "Trim", top="Roof", bottom="Trim")


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    east, west, south, podium = (clean(v["outline"]) for v in vols)
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    # low casino / garage podium (mapped at 16.2 m): plain, red band at the edge
    b.extrude(podium, BURY, 14.8, "Base", top="Roof")
    b.extrude(podium, 14.8, 16.2, "Trim", top="Roof", bottom="Trim")

    tower(b, west, 47.0, 7.0)    # original tower, full height
    tower(b, east, 39.4, 7.0)    # east tower
    # south-east block (mapped at 35.9 m): same pier facade, wider spacing (est.)
    tower(b, south, 35.9, 9.0)
    # mechanical penthouse on the west tower (est.), kept below the trusted height
    cx = sum(p[0] for p in west) / len(west)
    cy = sum(p[1] for p in west) / len(west)
    b.block((cx, cy), 14.0, 5.0, 46.0, 46.9, "Wall", turn_deg=62.5, top="Roof")
    return b.finish("Tower_w544016661")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
