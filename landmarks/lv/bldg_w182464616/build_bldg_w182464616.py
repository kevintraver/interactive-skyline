"""Low-poly model of an unnamed Las Vegas tower (way 182464616), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
No logos or signage are modeled.

Sources:
  - height 73.3 m: project data (lidar)
  - plan: footprint.json from skyline_tool.py footprint (mapped outline, offset 0,0)
  - floor bands, base height, roof penthouse, colors: estimated (no photos; plausible condo/hotel tower)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w182464616"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 73.3              # project data (lidar)
BASE_TOP = 5.0             # (est.) lobby level
PARAPET = 70.3             # (est.) main roof; penthouse reaches HEIGHT
BAND = 1.0                 # (est.) spandrel band thickness
N_SECTIONS = 5             # (est.) glass sections between bands

COLORS = {
    "Wall": "CFC6B4",
    "Band": "E4DED0",
    "Glass": "2B3A48",
    "Roof": "8C9094",
    "Mech": "A9A69C",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.25)
    if material == "Band":
        return kit.scaled(COOL, 0.35 if z > PARAPET - 3.5 else 0.06)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP], ["Wall"]
    span = (PARAPET - 2.5 - BASE_TOP - BAND) / N_SECTIONS
    z = BASE_TOP
    for i in range(N_SECTIONS):
        levels.append(z + BAND); mats.append("Band")
        z += span
        levels.append(z); mats.append("Glass")
    levels.append(PARAPET); mats.append("Band")   # lit crown band
    b.loft(kit.footprint_rings(plan, levels), mats)
    b.extrude(kit.scale_polygon(plan, 0.6), PARAPET - 0.2, HEIGHT, "Mech", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
