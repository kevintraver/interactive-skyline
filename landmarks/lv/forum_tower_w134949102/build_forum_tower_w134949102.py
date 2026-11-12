"""Low-poly model of a 1970s hotel tower at a Las Vegas Strip resort (id w134949102), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 71.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), bent two-wing outline, offset 0,0
  - facade: Wikimedia Commons search sheet (Caesars Palace views, not downloaded): white concrete,
    dark recessed window strips, flat roof with low mechanical penthouses. Band, base, parapet and
    penthouse heights are all estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "forum_tower_w134949102"
MAX_TRIS = 2_500

BURY = -2.0
H = 71.0          # project data
H_ROOF = 67.0     # est. main parapet; penthouses reach H
H_BASE = 7.0      # est. plain base
COLORS = {
    "Wall": "E9E5DC",
    "Glass": "C2C5C6",   # white piers with dark window strips, averaged
    "Roof": "98958E",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":  # flood-lit white concrete, brighter at the crown
        return kit.scaled(WARM, 0.12 + 0.22 * max(point[2], 0.0) / H)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.loft(kit.footprint_rings(plan, [BURY, H_BASE, 26.0, 27.2, 45.0, 46.2, 63.0, H_ROOF]),
           ["Wall", "Glass", "Wall", "Glass", "Wall", "Glass", "Wall"])
    # mechanical penthouses (est.): east wing, and west wing turned with it
    b.block((22.0, -9.5), 10.0, 5.0, H_ROOF - 1.0, H, "Wall", top="Roof")
    b.block((-17.0, 12.0), 4.5, 9.0, H_ROOF - 1.0, H, "Wall", turn_deg=-27.0, top="Roof")
    # plain white end walls of the two wings (est., standing 0.3 m proud)
    b.block((39.9, -9.6), 0.8, 12.2, BURY, H_ROOF, "Wall", top="Roof")
    b.block((-25.5, 30.5), 12.2, 0.8, BURY, H_ROOF, "Wall", turn_deg=27.2, top="Roof")
    return b.finish("Tower_w134949102")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
