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

STEM = "the_regent"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 80.8              # project data (osm-height, 20 floors)
FOOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))  # mapped plan (skyline_tool footprint); volume tops from it
# Podium retail blocks at 20 m (mapped), kept; tower curved west side 72 m (mapped). Colors/bands read off Commons
# photos 'Slc regent building.jpg' and 'Salt Lake City, Utah (2021) - 082.jpg' (blue glass, pale balcony bands) (est.).

COLORS = {
    "Glass": "5A8DBF",
    "Band": "D9DBDD",
    "Roof": "8C9094",
    "Podium": "B7B2A6",
    "PodiumGlass": "5C7488",
    "Brick": "9A5B45",
}
ROUGHNESS = {"Glass": 0.3, "PodiumGlass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "PodiumGlass":
        return kit.scaled(WARM, 0.25)
    if material == "Podium" or material == "Brick":
        return kit.scaled(WARM, 0.12)
    if material == "Band":
        return kit.scaled((0.8, 0.88, 1.0), 0.06)
    if material == "Roof" and point[2] > 30:
        return kit.scaled((0.8, 0.88, 1.0), 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b):
    vols = FOOT["volumes"]
    towers = [v for v in vols if v["top"] > 30]
    pods = [v for v in vols if v["top"] <= 30]
    for i, v in enumerate(pods):
        o = v["outline"]
        b.extrude(o, BURY, 4.5, "Brick" if i else "Podium")
        b.extrude(kit.scale_polygon(o, 1.0), 4.5, 17.0, "PodiumGlass", top="Podium")
        b.extrude(kit.scale_polygon(o, 1.02), 17.0, 20.0, "Podium", top="Roof")
    for v in towers:
        o = v["outline"]
        top = v["top"]
        b.extrude(o, 20.0, top - 1.2, "Glass", top="Roof")
        b.extrude(kit.scale_polygon(o, 0.97), top - 1.2, top, "Roof", top="Roof")
        z = 23.0
        while z < top - 3:
            b.extrude(kit.scale_polygon(o, 1.012), z, z + 0.7, "Band")
            z += 7.6
        b.extrude(kit.scale_polygon(o, 1.015), top - 3.5, top - 1.2, "Band")
    for v in towers:  # lower tower stub through podium so the tower reads as continuous
        b.extrude(v["outline"], BURY, 20.0, "PodiumGlass")


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
