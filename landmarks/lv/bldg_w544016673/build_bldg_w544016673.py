"""Low-poly model of an unnamed 76.8 m building (Las Vegas, id w544016673), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
No logos or signs are modeled.

Sources:
  - height 76.8 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): tower volume (to 76.8 m) and a low podium wing
    (to 20.8 m, mapped height)
  - no photos (unnamed building): facade, bands, base and penthouse are estimated (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w544016673"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 76.8        # project data (lidar)
PODIUM_TOP = 20.8    # footprint.json volume 2
BASE_TOP = 7.0       # (est.) lobby / base storeys
BODY_TOP = 73.3      # (est.) main roof parapet
BAND_EVERY = 13.0    # (est.) spandrel band spacing, about every 4 floors
BAND_H = 1.0         # (est.)

COLORS = {
    "Wall": "D2C8B6",
    "Glass": "2C3D4C",
    "Band": "BDB5A4",
    "Podium": "C4B9A6",
    "Roof": "8C9094",
    "Plant": "A9A69C",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.30 if z < BASE_TOP + 0.5 else 0.10)
    if material == "Podium":
        return kit.scaled(WARM, 0.22)
    if material == "Band":
        return kit.scaled(COOL, 0.35 if z > BODY_TOP - 3 else 0.08)
    if material == "Plant":
        return kit.scaled(COOL, 0.12)
    return (0.0, 0.0, 0.0)


def clean(poly, tol=0.3):
    """Drop repeated / near-coincident points of a mapped outline."""
    out = []
    for p in poly:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(tuple(p))
    if len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def build_tower(b, plan):
    levels, mats = [BURY, BASE_TOP, (BASE_TOP, -0.5)], ["Wall", "Band"]
    z = BASE_TOP
    while z + BAND_EVERY < BODY_TOP - 3:
        z += BAND_EVERY
        levels += [(z - BAND_H, -0.5), (z - BAND_H, -0.2), (z, -0.2), (z, -0.5)]
        mats += ["Glass", "Band", "Band", "Band"]
    levels += [(BODY_TOP - 2.5, -0.5), (BODY_TOP - 2.5, 0.0), (BODY_TOP, 0.0)]
    mats += ["Glass", "Band", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    b.fins(kit.offset_polygon(plan, -0.5), BASE_TOP, BODY_TOP - 2.5, 8.0, 0.45, 0.6, "Wall")
    # mechanical penthouse (est.), set well back, up to the lidar height
    b.extrude(kit.scale_polygon(plan, 0.45), BODY_TOP - 0.5, HEIGHT, "Plant", top="Roof")


def build_podium(b, plan):
    # low wing / garage: plain walls with a lit parapet band
    b.extrude(plan, BURY, PODIUM_TOP - 1.2, "Podium", top="Roof")
    b.extrude(plan, PODIUM_TOP - 1.2, PODIUM_TOP, "Band", top="Roof")


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_tower(b, clean(vols[0]["outline"]))
    build_podium(b, clean(vols[1]["outline"]))
    return b.finish("Bldg_w544016673")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
