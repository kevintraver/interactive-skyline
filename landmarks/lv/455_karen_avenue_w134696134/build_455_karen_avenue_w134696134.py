"""Low-poly model of 455 Karen Avenue (Las Vegas): a slender octagonal tower, built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. No logos or signage modeled.

Sources:
  - height 51.6 m: project data (lidar)
  - plan: footprint.json (OpenStreetMap way 134696134), a ~10 m octagon; installs at offset 0,0
  - no reference photos found on Wikimedia Commons: facade, bands, base and crown are estimated (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "455_karen_avenue_w134696134"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 51.6          # project data (lidar)
BASE_TOP = 4.5         # (est.) solid ground-level base
CROWN_Z = 48.4         # (est.) solid crown band below the parapet
BAND_STEP = 6.6        # (est.) spandrel band every two 3.3 m floors
BAND_H = 0.7           # (est.)

COLORS = {"Wall": "D9CFBC", "Glass": "2B3946", "Band": "C2B59E", "Roof": "8A8C8E", "Core": "6E7072"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.22 if center[2] > CROWN_Z else 0.10)
    if material == "Band":
        return kit.scaled(WARM, 0.06)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    glass = kit.offset_polygon(plan, -0.25)
    b.extrude(plan, BURY, BASE_TOP, "Wall")
    b.extrude(glass, BASE_TOP, CROWN_Z, "Glass")
    z = BASE_TOP + BAND_STEP
    while z < CROWN_Z - 2.0:
        b.extrude(plan, z, z + BAND_H, "Band")
        z += BAND_STEP
    b.extrude(plan, CROWN_Z, HEIGHT - 0.5, "Wall", top="Roof")
    b.extrude(kit.scale_polygon(plan, 0.45), HEIGHT - 0.5, HEIGHT, "Core")  # (est.) roof plant


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower455")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
