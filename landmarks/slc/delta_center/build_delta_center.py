"""Low-poly model of Delta Center (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 42.1 m: project lidar data; wing tops from mapped footprint volumes
  - glass bands/colors: read from refs/Delta_Center_2023.jpg and Delta_Center_with_Arena_Station.jpg (est. band heights)
  - footprint: footprint.json (mapped volumes)
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

STEM = "delta_center"
MAX_TRIS = 5_000
BURY = -2.0
HEIGHT = 42.1

COLORS = {
    "Panel": "A8A49C",   # gray precast panels
    "Glass": "3E6E92",   # blue glass
    "Roof": "B4B6B8",
    "Concrete": "8E8B85",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Panel":
        return kit.scaled(WARM, 0.05)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Concrete":
        return kit.scaled(WARM, 0.08)
    return (0.0, 0.0, 0.0)


FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]


def build_body(b):
    main = FP[0]["outline"]
    b.extrude(main, BURY, HEIGHT, "Panel", top="Roof")
    # Horizontal glass bands wrapping the arena (heights est. from photos).
    for z0, z1 in ((10.0, 12.0), (18.0, 24.0)):
        b.extrude(kit.offset_polygon(main, 0.25), z0, z1, "Glass", top="Panel")
    # Parapet cap
    b.extrude(kit.offset_polygon(main, 0.4), HEIGHT - 1.2, HEIGHT, "Roof", top="Roof")


def build_wings(b):
    for i, v in enumerate(FP[1:], 1):
        if i == 9:
            continue  # inside the main mass
        top = v["top"]
        if top > 10:
            b.extrude(v["outline"], BURY, top, "Panel", top="Roof")
            b.extrude(kit.offset_polygon(v["outline"], 0.25), 6.0, min(top - 6.0, 24.0), "Glass", top="Panel")
        else:
            b.extrude(v["outline"], BURY, top, "Concrete", top="Roof")


def part_files():
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "wings": build_wings, **part_files()}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
