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

STEM = "bldg_w238249914"
MAX_TRIS = 3_000
FOOT = os.path.join(HERE, "footprint.json")

# Sources: height 45.1 m (project lidar data); plan from footprint.json (mapped OSM outline, 1 volume).
# Building not identified (no name in OSM, no Commons photos found): plain mid-rise, colors/bands estimated.
BURY = -2.0
HEIGHT = 45.1
PODIUM = 6.0       # (est.) precast base
FLOOR = 3.6        # (est.) floor-to-floor, drives band spacing

COLORS = {
    "Wall": "C9BFAE",
    "Glass": "3A4A5A",
    "Roof": "7C7F83",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "Wall":
        return kit.scaled(COOL, 0.04 + 0.2 * math.exp(-max(point[2], 0.0) / 12.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    plan = kit.load_footprint(FOOT)["volumes"][0]["outline"]
    b.extrude(plan, BURY, PODIUM, "Wall", top="Wall")
    glass_plan = kit.offset_polygon(plan, -0.3)
    top = HEIGHT - 1.2
    b.extrude(glass_plan, PODIUM, top, "Glass", top="Roof")
    band_plan = kit.offset_polygon(plan, 0.0)
    z = PODIUM + FLOOR
    while z < top - 1.0:
        b.extrude(band_plan, z - 0.35, z + 0.35, "Wall")
        z += FLOOR
    b.extrude(band_plan, top - 0.2, HEIGHT, "Wall", top="Roof")  # parapet cap


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
