"""Low-poly model of a 142 m curved condo tower (Las Vegas, id w134935559), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled.

Sources:
  - height 142.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0
  - proportions (taller central section, lower wings, white slab bands on blue-green glass, small roof
    crown): read off Wikimedia Commons search thumbnails (Allure-Las-Vegas.jpg, Circus Circus (4067229963).jpg); est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "allure_las_vegas_tower_w134935559"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 142.0      # project data
BASE_TOP = 7.0      # lobby/base band (est.)
MID_TOP = 137.0     # raised central section (est.)
WING_TOP = 127.0    # main roof of the full plan (est. from photo, ~0.9 H)
BAND = 1.4          # white slab band height (est.)
N_BANDS = 7

COLORS = {
    "Frame": "E4E2DC",   # white concrete slabs and base
    "Glass": "3F6F86",   # blue-green glazing
    "Roof": "8C9094",
    "Crown": "D9DCDD",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(COOL, 0.25 if z < BASE_TOP + 0.5 else 0.08)
    if material == "Crown":
        return kit.scaled(COOL, 0.55)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Frame"]
    step = (WING_TOP - BASE_TOP) / (N_BANDS + 1) - BAND   # glass run between slab bands
    z = BASE_TOP
    for _ in range(N_BANDS + 1):  # glass run, then a white band; the last band is the roof parapet
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)
    # white vertical piers between the glazed bays (photo: the wings read mostly white; spacing est.)
    b.fins(plan, BASE_TOP, WING_TOP, 6.5, 0.6, 1.6, "Frame")
    # raised central section, then the roof crown
    mid = kit.scale_polygon(plan, 0.62)
    b.extrude(mid, WING_TOP, MID_TOP - BAND, "Glass")
    b.extrude(mid, MID_TOP - BAND, MID_TOP, "Frame", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.34), MID_TOP, HEIGHT, "Crown", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
