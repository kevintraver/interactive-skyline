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

STEM = "kimpton_hotel_monaco_slc"
MAX_TRIS = 3_000

# Sources: height 65.2 m = project data (osm-height); footprint = skyline_tool footprint (OSM).
# Estimated: tower/wing split (tower = west part facing the main street, east strip is a low brick wing ~20 m),
# base 14 m, cornice at 61 m, colors read off Commons photos of the former bank building (tan stone shaft,
# darker stone base, brick wing). Brand signs and awnings left out.
BURY = -2.0
HEIGHT = 65.2
TOWER = [(-27.94, 11.23), (3.93, 11.1), (3.93, -10.78), (-10.99, -10.72), (-11.02, -19.25), (-28.06, -19.18)]
WING = [(3.93, 11.1), (39.61, 10.98), (39.56, -3.55), (3.94, -3.41)]
WING_H = 20.0
BASE_H = 14.0
CORNICE_Z = 60.0

COLORS = {
    "Stone": "C9BCA0",
    "BaseStone": "A0927A",
    "Brick": "A5694A",
    "Glass": "A89E88",
    "Roof": "6E6B66",
}
ROUGHNESS = {"Glass": 0.5}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point, center):
    z = point[2]
    if material in ("Stone", "BaseStone", "Brick"):
        return kit.scaled(WARM, 0.05 + 0.35 * math.exp(-max(z, 0.0) / 14.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    out = kit.offset_polygon
    b.extrude(TOWER, BURY, BASE_H, "BaseStone", top="BaseStone")
    b.extrude(WING, BURY, WING_H, "Brick", top="Roof")
    b.extrude(WING_H and kit.offset_polygon(WING, 0.4), WING_H, WING_H + 1.0, "Stone", top="Roof")
    b.extrude(out(TOWER, 0.35), BASE_H, BASE_H + 0.8, "Stone", top="Stone")
    b.extrude(TOWER, BASE_H + 0.8, CORNICE_Z, "Glass")
    z = BASE_H + 0.8 + 8.8
    while z < CORNICE_Z - 2:
        b.extrude(out(TOWER, 0.25), z, z + 0.6, "Stone")
        z += 8.8
    b.extrude(out(TOWER, 0.8), CORNICE_Z, CORNICE_Z + 1.8, "Stone", top="Stone")
    b.extrude(out(TOWER, -0.3), CORNICE_Z + 1.8, HEIGHT, "Stone", top="Roof")


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
