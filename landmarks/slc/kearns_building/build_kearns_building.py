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

STEM = "kearns_building"
MAX_TRIS = 3_000

# Sources: height 50.5 m (project lidar data, trusted); footprint + 8.8 m low volume from skyline_tool footprint
# (project data); cream terra-cotta west (Main St) facade, tan brick sides, cornice read off Commons photos
# Kearns_Building_SLC_4_.jpg and Kearns_Building_Salt_Lake_City_Utah.jpg. Cornice depth, bay layout (est.).
# Signage ("Kearns Building" lettering, shop signs) deliberately not modeled.
BURY = -2.0
HEIGHT = 50.5
LOW = 8.8
CORN = 49.0

COLORS = {"Brick": "C4AD80", "Cream": "E4DECF", "Base": "4A4A4C", "Glass": "26303A", "Roof": "7C7F83"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material in ("Brick", "Cream"):
        return kit.scaled(WARM, 0.04 + 0.30 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    main, low = fp[0]["outline"], fp[1]["outline"]
    b.extrude(main, BURY, CORN, "Brick")
    b.extrude(kit.offset_polygon(main, 0.7), CORN, HEIGHT - 0.4, "Cream")
    b.extrude(kit.offset_polygon(main, 0.3), HEIGHT - 0.4, HEIGHT, "Roof")
    b.extrude(low, BURY, LOW, "Brick", top="Roof")


def build_facade(b):
    # west (Main Street) cream terra-cotta face with dark ground-floor band
    b.block((-24.3, 0.0), 0.35, 16.2, BURY, CORN, "Cream")
    b.block((-24.45, 0.0), 0.35, 16.2, BURY, 6.0, "Base")
    for i in range(9):
        y = -14.4 + i * 3.6
        b.block((-24.68, y), 0.06, 1.2, 8.5, 47.0, "Glass")
    # east face and south/north faces: window strips on brick
    for i in range(9):
        y = -14.4 + i * 3.6
        b.block((24.3, y), 0.06, 1.0, 8.0, 47.0, "Glass")
    for i in range(5):
        x = -21.0 + i * 3.4
        b.block((x, -16.45), 1.0, 0.06, 8.0, 47.0, "Glass")
        b.block((x + 36.0 - 5.0 * 0, -16.2), 1.0, 0.06, 8.0, 47.0, "Glass") if x + 36.0 < 23 else None
    for i in range(12):
        x = -21.0 + i * 3.8
        b.block((x, 16.3), 1.0, 0.06, 8.0, 47.0, "Glass")


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "facade": build_facade, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
