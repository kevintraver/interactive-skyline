"""Low-poly model of the east curved hotel tower of a Las Vegas resort (id w134930092), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown band is plain.

Sources:
  - height 183.0 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint), extruded as mapped
  - stepped/sloping roofline, crown band depth, facade colors, night light: read off
    refs/Aria_Las_Vegas_December_2013.jpg and refs/Aria_Hotel_Las_Vegas_23564756081_.jpg (est.)
  - which end is tallest (south) and the low-end height (~150 m): estimated
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "aria_east"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 183.0                       # project data
LOW = 150.0                          # (est.) roof at the low end, ~0.82 of the tip in the side photo
CROWN = 8.0                          # (est.) lit crown band, ~2 floors
BASE = 9.0                           # (est.) darker lobby levels
CUTS = tuple(-50.0 + 10.0 * i for i in range(11))   # 12 strips along the arc, south (tall) to north (low)
# (est.) fine-stepped stand-in for the swooping roofline: flat tip, then a concave fall toward the low end
TOPS = (HEIGHT, HEIGHT) + tuple(round(LOW + (HEIGHT - 4.0 - LOW) * (1 - i / 9.0) ** 1.6, 1) for i in range(10))

COLORS = {
    "Glass": "8FA3AE",     # pale silver-blue curtain wall
    "Crown": "E6DDBF",     # pale gold-white lit parapet band
    "Base": "5E666C",
    "Roof": "7C8084",
    "Fin": "C9D2D8",       # light vertical recess strip at the tall end
}
ROUGHNESS = {"Glass": 0.3, "Fin": 0.4}
WARM = (1.0, 0.86, 0.62)


def glow(material, point, center):
    if material == "Crown":
        return kit.scaled((1.0, 0.95, 0.82), 1.0)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Fin":
        return (0.45, 0.35, 0.9)   # violet LED strip seen in the night photo
    if material == "Base":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def strips(outline):
    """Cut the footprint into bands along north with horizontal lines y = c."""
    rest, out = list(outline), []
    for c in CUTS:
        pieces = kit.split(rest, (0.0, 1.0, c))
        south = [p for p in pieces if min(q[1] for q in p) < c - 0.01 and max(q[1] for q in p) <= c + 0.01]
        north = [p for p in pieces if p not in south]
        out.append(south[0])
        rest = north[0]
    out.append(rest)
    return out


def build_body(b):
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    for poly, top in zip(strips(outline), TOPS):
        b.extrude(poly, BURY, BASE, "Base")
        b.extrude(poly, BASE, top - CROWN, "Glass")
        b.extrude(poly, top - CROWN, top, "Crown", top="Roof")
    # vertical strip on the west (convex) face near the tall south end, proud of the facade
    b.block((-9.6, -44.0), 0.8, 2.0, BASE, HEIGHT - CROWN, "Fin")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("EastTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
