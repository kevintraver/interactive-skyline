"""Low-poly model of the Church Office Building (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_church_office_building.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center on the ground.
No signage or logos modeled.

Sources:
  - height 128 m core, 110 m wings, 19 m podium: project data (osm-height), footprint.json volumes
  - plan: mapped footprint (skyline_tool footprint)
  - colors and fin rhythm (est.) read from Commons photos (cream precast piers, dark narrow windows)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "church_office_building"
MAX_TRIS = 5_000

BURY = -2.0
HEIGHT = 128.0   # project data
WING_TOP = 110.0  # project data
PODIUM_TOP = 19.0  # project data
FIN_SPACING = 2.6  # (est.)

COLORS = {"Precast": "D9D3C3", "Glass": "6B7078", "Dark": "2A2E33", "Roof": "9A9C9E"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Precast":
        return kit.scaled(WARM, 0.08 + 0.25 * math.exp(-max(z, 0.0) / 25.0) + (0.12 if z > 100 else 0.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Dark":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    podium, core, west, east = [v["outline"] for v in fp["volumes"]]
    b.extrude(podium, BURY, PODIUM_TOP, "Precast", top="Roof")
    b.extrude(kit.scale_polygon(podium, 1.004), 2.0, 9.0, "Dark")  # glazed colonnade level
    for wing in (west, east):
        b.extrude(wing, BURY, WING_TOP, "Glass", top="Roof")
        b.fins(wing, PODIUM_TOP, WING_TOP, FIN_SPACING, 0.8, 1.7, "Precast")
    b.extrude(core, BURY, HEIGHT, "Glass", top="Roof")
    b.fins(core, PODIUM_TOP, HEIGHT, FIN_SPACING, 0.8, 1.7, "Precast")


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
