"""Low-poly model of a 35-story hotel tower on the Las Vegas Strip (id w111367828), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign boxes are plain.

Sources:
  - height 109.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), sawtooth three-wing outline, offset 0,0
  - facade: refs/Harrah_s_Las_Vegas_35-story_tower_2009_.jpg: white concrete, punched windows, plain end
    piers that rise about one floor above the roofline (est. 4 m); base and parapet heights est.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "harrah_s_las_vegas_w111367828"
MAX_TRIS = 2_500

BURY = -2.0
H = 109.0        # project data
H_ROOF = 105.0   # est.: end piers stand ~4 m above the main roofline (photo)
H_PARAPET = 102.5  # est.
H_BASE = 7.0     # est. plain base

COLORS = {
    "Wall": "E6E3DC",
    "Glass": "BCC1C6",   # window wall: white concrete with dark punched windows, averaged
    "Pier": "ECE9E2",
    "Roof": "9A9892",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.14)
    if material == "Pier":  # flood-lit plain end walls, brighter toward the top sign boxes
        return kit.scaled(WARM, 0.16 + 0.30 * max(z, 0.0) / H)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.loft(kit.footprint_rings(plan, [BURY, H_BASE, 38.0, 39.2, 70.0, 71.2, H_PARAPET, H_ROOF]),
           ["Wall", "Glass", "Wall", "Glass", "Wall", "Glass", "Wall"])
    # plain end piers of the three wings (east, south-east diagonal, west)
    b.block((38.6, 34.3), 4.0, 10.2, BURY, H, "Pier", top="Roof")
    b.block((14.0, -46.0), 9.8, 4.0, BURY, H, "Pier", turn_deg=45.0, top="Roof")
    b.block((-31.6, -5.0), 4.4, 15.6, BURY, H, "Pier", top="Roof")
    # core / mechanical penthouse at the wing junction (est.)
    b.block((-8.0, -5.0), 7.0, 7.0, H_ROOF - 1.0, H - 0.5, "Wall", top="Roof")
    return b.finish("Tower_w111367828")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
