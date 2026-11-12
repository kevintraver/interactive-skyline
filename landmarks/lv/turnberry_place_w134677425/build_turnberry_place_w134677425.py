"""Low-poly model of a boomerang-plan condo tower (Las Vegas, id w134677425), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the footprint center. No logos or signs are modeled.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json (mapped outline, chevron), installs with offset 0,0
  - facade (cream piers and balcony bands over blue-green glass, stepped crown): Wikimedia Commons search
    sheet refs/search.json/commons_sheet.jpg (Turnberry-Place-May-21-2010.JPG); band/pier spacing and
    crown step heights are estimates
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "turnberry_place_w134677425"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 145.0      # project data
SHOULDER = 127.0    # top of main shaft (est. from photo, ~88% of height)
STEP1 = 137.0       # first crown step (est.)
BASE_TOP = 7.0      # lobby base (est.)
BAND_STEP = 8.0     # balcony band every ~2 floors (est., simplified)
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {
    "Wall": "F0EADC",
    "Glass": "3E6670",
    "Crown": "EDE8DC",
    "Roof": "9A9A96",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.55)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    # shaft and stepped crown, one closed solid
    b.loft(kit.footprint_rings(PLAN, [BURY, SHOULDER, (SHOULDER, -3.0), STEP1, (STEP1, -7.0), HEIGHT]),
           ["Glass", "Roof", "Crown", "Roof", "Crown"])
    # base
    b.extrude(kit.offset_polygon(PLAN, 1.5), BURY, BASE_TOP, "Wall", top="Roof")
    # balcony bands
    band = kit.offset_polygon(PLAN, 0.6)
    z = BASE_TOP + BAND_STEP
    while z < SHOULDER - 2:
        b.extrude(band, z, z + 1.3, "Wall")
        z += BAND_STEP
    b.extrude(band, SHOULDER - 2.0, SHOULDER + 0.6, "Crown")
    # vertical piers between glass strips
    b.fins(PLAN, BASE_TOP, SHOULDER - 1.0, 4.6, 0.9, 2.7, "Wall")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
