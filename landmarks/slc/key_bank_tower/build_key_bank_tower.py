"""Low-poly model of Key Bank Tower (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_key_bank_tower.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 107 m: project data (osm-height); 26 floors
  - footprint: skyline_tool footprint (tower volume 107 m, podium volume 26.8 m)
  - tan grid facade, flat top with plain crown band, stone podium: read off Commons Slc_key_bank_tower.jpg; crown band height (est.)
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

STEM = "key_bank_tower"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 107.0
PODIUM = 26.8
CROWN = 4.5   # (est.)
COLORS = {"Stone": "9C8F7C", "Glass": "7A6A58", "Band": "B9AC96", "Crown": "C4B8A2", "Roof": "8C8C8C"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)

def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Stone":
        return kit.scaled(WARM, 0.12 + 0.25 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Crown":
        return kit.scaled((1.0, 0.9, 0.7), 0.35)
    return (0.0, 0.0, 0.0)

def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower, pod = fp["volumes"][0]["outline"], fp["volumes"][1]["outline"]
    b.extrude(pod, BURY, PODIUM, "Stone", top="Roof")
    b.extrude(tower, PODIUM, HEIGHT - CROWN, "Glass")
    b.extrude(kit.offset_polygon(tower, 0.5), HEIGHT - CROWN, HEIGHT, "Crown", top="Roof")
    ring = kit.offset_polygon(tower, 0.25)
    n = 26
    step = (HEIGHT - CROWN - PODIUM) / (n - 3)
    z = PODIUM + step
    while z < HEIGHT - CROWN - 1:
        b.extrude(ring, z, z + 0.9, "Band")
        z += step

PARTS = {"body": build_body}

def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())

if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
