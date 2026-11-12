"""Low-poly model of an unnamed 80 m building (Las Vegas, id w134921379), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
No logos or signs are modeled.

Sources:
  - height 80.0 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint), a slab with a rounded west end
  - no photos (unnamed building): facade, bands, podium base and penthouse are estimated (est.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w134921379"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 80.0        # project data (osm-height)
BASE_TOP = 7.0       # (est.) lobby / base storeys
BODY_TOP = 76.0      # (est.) main roof parapet
BAND_EVERY = 13.8    # (est.) spandrel band spacing, about every 4 floors
BAND_H = 1.0         # (est.)

COLORS = {
    "Wall": "CFC6B4",
    "Glass": "2B3A48",
    "Band": "B9B2A2",
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
    if material == "Band":
        return kit.scaled(COOL, 0.35 if z > BODY_TOP - 3 else 0.08)
    if material == "Plant":
        return kit.scaled(COOL, 0.12)
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    levels, mats = [BURY, BASE_TOP, (BASE_TOP, -0.5)], ["Wall", "Band"]
    z = BASE_TOP
    while z + BAND_EVERY < BODY_TOP - 3:
        z += BAND_EVERY
        levels += [(z - BAND_H, -0.5), (z - BAND_H, -0.2), (z, -0.2), (z, -0.5)]
        mats += ["Glass", "Band", "Band", "Band"]
    # crown: glass up to a lit parapet band
    levels += [(BODY_TOP - 2.5, -0.5), (BODY_TOP - 2.5, 0.0), (BODY_TOP, 0.0)]
    mats += ["Glass", "Band", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    # roof deck inside the parapet is the loft cap; vertical piers on the facade
    b.fins(kit.offset_polygon(plan, -0.5), BASE_TOP, BODY_TOP - 2.5, 7.5, 0.45, 0.6, "Wall")
    # mechanical penthouse (est.), set well back
    b.extrude(kit.scale_polygon(plan, 0.45), BODY_TOP - 0.5, HEIGHT, "Plant", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w134921379")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
