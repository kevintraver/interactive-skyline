"""Low-poly model of a 123 m curved condo slab tower with a parking podium (Las Vegas, id w495545510).

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled.

Sources:
  - height 123.1 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0; volume 3 = tower, volume 4 = garage podium
    (16.8 m, mapped; its two small light-well holes and the 3 small infill volumes are folded into the deck)
  - facade (blue-green glass, pale horizontal balcony bands, flat roof with a low mechanical penthouse):
    read off Wikimedia Commons search thumbnails ("Panorama Towers Las Vegas December", "Panorama Towers -
    East - 2010-03-06"); band count and penthouse size est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "panorama_tower_ii_w495545510"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 123.1      # project data
ROOF = 118.5        # main roof / parapet top (est.)
BASE_TOP = 16.8     # podium level (mapped)
BAND = 1.1          # pale balcony band height (est.)
N_BANDS = 12

COLORS = {
    "Frame": "DDE0DC",   # pale slab bands
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
    """Drop points closer than min_gap to the previously kept one (rounded corners -> single corners)."""
    out = [points[0]]
    for p in points[1:]:
        if ((p[0] - out[-1][0]) ** 2 + (p[1] - out[-1][1]) ** 2) ** 0.5 >= min_gap:
            out.append(p)
    if len(out) > 3 and ((out[0][0] - out[-1][0]) ** 2 + (out[0][1] - out[-1][1]) ** 2) ** 0.5 < min_gap:
        out.pop()
    return out


def build_body(b):
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    plan = thin([tuple(p) for p in vols[3]["outline"]], 2.5)
    podium = thin([tuple(p) for p in vols[4]["outline"]], 1.5)
    b.extrude(podium, BURY, BASE_TOP, "Podium", top="Roof")

    levels, mats = [BURY, BASE_TOP], ["Podium"]
    step = (ROOF - BASE_TOP) / N_BANDS - BAND
    z = BASE_TOP
    for _ in range(N_BANDS):  # glass run, then a pale band; the last band is the parapet
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)
    # low mechanical penthouse / lit crown
    b.extrude(kit.scale_polygon(plan, 0.7), ROOF, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
