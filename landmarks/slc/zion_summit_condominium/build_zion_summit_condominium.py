"""Low-poly model of Zion Summit Condominium (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 53.0 m (13 floors): project data (osm-height)
  - plan: mapped footprint (footprint.json, 3 volumes; podium top 6.3 m from the map)
  - no usable Commons photos: floor slabs (4.0 m pitch), parapet, roof box are estimated from the 13 floors
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

STEM = "zion_summit_condominium"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 53.0
FLOORS = 13
PITCH = (HEIGHT - 3.0 - 6.3 - 1.0) / FLOORS  # est.
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))

COLORS = {"Concrete": "CFC8BA", "Glass": "3A4652", "Roof": "8A8A86", "Podium": "A99C8A"}  # est.
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Concrete":
        return kit.scaled(WARM, 0.05 + 0.15 * math.exp(-max(point[2], 0.0) / 15.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b):
    for v in FP["volumes"]:
        out = v["outline"]
        if v["top"] < 20:
            b.extrude(out, v["bottom"], v["top"], "Podium", top="Roof")
            continue
        top = v["top"] - 3.0  # penthouse box reaches the full 53 m
        core = kit.scale_polygon(out, 0.985) if hasattr(kit, "scale_polygon") else out
        b.extrude(core, v["bottom"], top - 0.5, "Glass")
        b.extrude(out, v["bottom"], 6.3, "Concrete")
        for i in range(FLOORS):
            z = 6.3 + i * PITCH
            b.extrude(out, z, z + 0.7, "Concrete")
        b.extrude(out, top - 1.0, top, "Concrete", top="Roof")
        c = kit.scale_polygon(out, 0.35)
        b.extrude(c, top, top + 3.0, "Concrete", top="Roof")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
