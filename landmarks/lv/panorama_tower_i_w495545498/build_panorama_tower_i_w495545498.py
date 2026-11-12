"""Low-poly model of Panorama Tower I (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 120.3 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint): curved slab tower + low garage podium (16.8 m, mapped)
    + three small stair/lift cores (17.8-25.8 m, mapped)
  - facade (blue-green glass, pale slab bands, pale end piers, low rooftop crown): Wikimedia Commons
    search sheet "Panorama Towers Las Vegas" (refs/search.json/commons_sheet.jpg); band count and sizes est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "panorama_tower_i_w495545498"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 120.3      # project data (osm-height)
ROOF = 116.5        # main parapet top (est.)
BASE_TOP = 16.8     # podium level (mapped)
BAND = 1.0          # pale slab band height (est.)
N_BANDS = 16

COLORS = {
    "Frame": "DDE0DC",   # pale slab bands and piers
    "Glass": "3E7C8C",   # blue-green glazing
    "Podium": "B9B4A8",  # garage concrete
    "Roof": "8C9094",
    "Crown": "C9D2D4",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(COOL, 0.08)
    if material == "Podium":
        return kit.scaled(WARM, 0.12)
    if material == "Crown":
        return kit.scaled(COOL, 0.45)
    return (0.0, 0.0, 0.0)


def thin(points, min_gap):
    """Drop points closer than min_gap to the previously kept one."""
    out = [points[0]]
    for p in points[1:]:
        if ((p[0] - out[-1][0]) ** 2 + (p[1] - out[-1][1]) ** 2) ** 0.5 >= min_gap:
            out.append(p)
    if len(out) > 3 and ((out[0][0] - out[-1][0]) ** 2 + (out[0][1] - out[-1][1]) ** 2) ** 0.5 < min_gap:
        out.pop()
    return out


def build_body(b):
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    plan = thin(list(vols[0]["outline"]), 4.5)
    podium = thin(list(vols[4]["outline"]), 1.5)
    b.extrude(podium, BURY, BASE_TOP, "Podium", top="Roof")
    for v in vols[1:4]:  # stair / lift cores on the garage deck
        b.extrude(kit.offset_polygon(list(v["outline"]), -0.3), BASE_TOP - 0.5, v["top"], "Podium", top="Roof")

    levels, mats = [BURY, BASE_TOP], ["Podium"]
    step = (ROOF - BASE_TOP) / N_BANDS - BAND
    z = BASE_TOP
    for _ in range(N_BANDS):  # glass run, then a pale band; the last band is the parapet
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)
    # pale vertical piers along the facade (est. spacing from photos)
    b.fins(plan, BASE_TOP, ROOF, 22.0, 0.5, 1.6, "Frame")
    # low mechanical penthouse / lit crown
    b.extrude(kit.scale_polygon(plan, 0.72), ROOF, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
