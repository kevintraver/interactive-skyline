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

STEM = "560_east_south_temple"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 43.8             # project lidar data (footprint.json volume top)

# ---------------------------------------------------------------------- style
# No photos found on Commons: plan from footprint.json, massing/colors estimated (mid-rise office slab).
COLORS = {"Precast": "CFC9BC", "Glass": "34495A", "Roof": "7A7D80", "Base": "8E8A80"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    if material == "Precast":
        return kit.scaled(COOL, 0.04 + 0.12 * math.exp(-max(z, 0.0) / 15.0))
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def outline():
    return kit.ccw_polygon(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])


def build_body(b):
    o = outline()
    BASE_H = 6.0
    TOP = HEIGHT - 1.2
    b.extrude(o, BURY, BASE_H, "Base", top="Precast")
    b.extrude(kit.scale_polygon(o, 0.985), BASE_H, TOP, "Glass")   # glass core, bands stand proud of it
    z = BASE_H
    while z < TOP - 3.0:
        b.extrude(o, z, z + 0.7, "Precast", top="Precast", bottom="Precast")
        z += 4.2
    b.extrude(o, TOP - 1.0, TOP, "Precast", top="Roof", bottom="Precast")
    b.block((0.0, 0.0), 14.0, 9.0, TOP, HEIGHT, "Roof", top="Roof")


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
