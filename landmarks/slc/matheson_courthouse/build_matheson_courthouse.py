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

STEM = "matheson_courthouse"
MAX_TRIS = 3_000

# Sources: height 36.2 m and volume tops from project footprint (lidar); plan from skyline_tool footprint.
# Photos (Commons refs/commons_sheet.jpg): light gray granite/precast, pale green glass, colonnaded rotunda.
# Estimated: rotunda center (28.3, 0) radius 11.3 (fit to footprint arc), column count/size, window strips.
BURY = -2.0
HEIGHT = 36.2
ROT_C = (28.3, 0.0)

COLORS = {"Stone": "BDBAB2", "Glass": "7FA39B", "Roof": "8A8C8E", "Column": "CFCCC4"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Stone":
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 14.0))
    if material == "Column":
        return kit.scaled(WARM, 0.5)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        b.extrude(v["outline"], v["bottom"], v["top"], "Stone", top="Roof")


def build_details(b):
    # window strips on the two long wings (east and west faces)
    for (y0, y1, ztop) in ((-73.0, -37.0, 25.0), (37.0, 73.0, 24.5)):
        y = y0 + 3.0
        while y + 4.0 < y1:
            for x in (27.5, -3.5):
                xs = x + (0.0 if x > 0 else -0.3)
                b.extrude([(xs, y), (xs + 0.3, y), (xs + 0.3, y + 4.0), (xs, y + 4.0)], 3.0, ztop - 2.0, "Glass")
            y += 7.0
    # rotunda colonnade and cornice
    for i in range(14):
        a = math.radians(-100 + i * (200 / 13))
        c = (ROT_C[0] + 11.6 * math.cos(a), ROT_C[1] + 11.6 * math.sin(a))
        b.prism(0.6, 0.0, 22.0, 6, "Column", center=c)
    b.prism(12.3, 22.0, 23.2, 24, "Column", center=ROT_C)


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "details": build_details, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
