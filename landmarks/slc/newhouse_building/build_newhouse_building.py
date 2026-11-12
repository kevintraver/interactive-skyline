"""Low-poly model of <LANDMARK> (<CITY>), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - <height: source>
  - <plan size / footprint: source>
  - <proportions read off <photo file> (side elevation), scaled by the published height>
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

STEM = "newhouse_building"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 50.7  # project data (lidar), footprint volume top
# Plan: skyline_tool.py footprint (mapped outline, rounded NW corner). Proportions estimated from Commons photos
# "Newhouse Building (4)", "(3)": 2-storey stone base, 9-storey shaft, heavy cornice (est.). No signage modeled.
COLORS = {"Base": "B9B1A0", "Shaft": "A89F8E", "Band": "CFC8B8", "Cornice": "C2BAA8", "Roof": "6E6E6E"}
ROUGHNESS = {"Shaft": 0.9}
WINDOWS = {"Shaft": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Shaft":
        return kit.scaled(WARM, 0.03)
    if material in ("Base", "Band", "Cornice"):
        return kit.scaled(WARM, 0.12 + 0.35 * math.exp(-max(z, 0.0) / 14.0) + (0.2 if z > HEIGHT - 6 else 0.0))
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    out = kit.offset_polygon(fp, 0.4)
    b.extrude(out, BURY, 10.0, "Base", top="Band")
    b.extrude(fp, 10.0, HEIGHT - 4.0, "Shaft")
    for z in (22.0, 34.0):
        b.extrude(kit.offset_polygon(fp, 0.25), z, z + 0.7, "Band")
    b.extrude(kit.offset_polygon(fp, 0.8), HEIGHT - 4.0, HEIGHT - 1.6, "Cornice", top="Band")
    b.extrude(kit.offset_polygon(fp, -1.0), HEIGHT - 1.6, HEIGHT, "Cornice", top="Roof")


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
