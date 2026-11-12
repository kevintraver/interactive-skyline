"""Low-poly model of Wells Fargo Center (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_wells_fargo_center.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 128.7 m: project data (osm-height); crown top 125 m is the mapped main volume top, antenna to 128.7 (est.)
  - footprint: skyline_tool.py footprint (13 mapped volumes, kept at their heights; tower plan clipped from the
    big outline, est.); podium heights from the mapped volumes
  - colors, crown flare, notch in east face: Wells_Fargo_Center_SLC_UT_east_side_2024-09-01.jpg (est.)
  - floor height ~4.9 m (24 floors, est.). Signage on the crown is NOT modeled (plain panel).
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

# Split for parallel part-modelers? Move the dimensions, COLORS, ROUGHNESS and glow below into spec.py,
# replace them here with `from spec import *`, and let each modeler write part_<name>.py (assets/part_template.py).

STEM = "wells_fargo_center"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 128.7             # project data
SHAFT_TOP = 117.6          # 24 floors x 4.9 (est.)
CROWN_TOP = 125.0          # mapped main volume top

COLORS = {
    "Stone": "CFC6B6",
    "Glass": "27456E",
    "Podium": "9A948A",
    "CrownPanel": "2F5A62",
    "Roof": "7A7D80",
    "Mast": "8C9094",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Stone":
        return kit.scaled(COOL, 0.04 + 0.12 * math.exp(-max(center[2], 0.0) / 25.0))
    if material == "Podium":
        return kit.scaled(WARM, 0.10)
    if material == "CrownPanel":  # lit crown edge wash
        return kit.scaled(COOL, 0.3)
    return (0.0, 0.0, 0.0)


FLOOR = 4.9
TOWER = [(-18.5, 6.0), (14.5, 6.0), (17.6, -13.5), (1.5, -30.0), (-18.5, -30.0)]  # est., inside mapped outline


def build_podium(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    b.extrude(vols[0]["outline"], BURY, 6.3, "Podium", top="Roof")
    for i in (1, 2, 3, 4, 7, 8, 9, 10, 11):
        v = vols[i]
        b.extrude(v["outline"], BURY, max(v["top"], 6.3) + 0.0, "Podium", top="Roof")
    # the two mapped 60 m slivers and the 9 m drum are folded into the tower and left out


def build_tower(b):
    levels, mats = [BURY], []
    z = 0.0
    levels.append(0.0)
    mats.append("Stone")
    for _ in range(24):
        levels += [(z + 3.7, 0.0), (z + 3.7, 0.25), (z + 4.9, 0.25), (z + 4.9, 0.0)]
        mats += ["Glass", "Stone", "Stone", "Stone"]
        z += FLOOR
    b.loft(kit.footprint_rings(TOWER, levels), mats)
    b.fins(TOWER, 6.0, SHAFT_TOP, 4.6, 0.35, 0.9, "Stone")


def build_crown(b):
    rings = kit.footprint_rings(TOWER, [SHAFT_TOP, (SHAFT_TOP + 0.01, 0.0), (CROWN_TOP - 0.8, 1.8), (CROWN_TOP, 1.8)])
    b.loft(rings, ["CrownPanel", "CrownPanel", "Roof"])
    b.block((-1.0, -8.0), 0.6, 0.6, CROWN_TOP, HEIGHT, "Mast")


PARTS = {"podium": build_podium, "tower": build_tower, "crown": build_crown}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
