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

STEM = "lds_hospital"
MAX_TRIS = 5_000

# Sources: height 38.1 m (project lidar data); plan = mapped footprint.json (single volume).
# Estimated from refs/commons_sheet.jpg photos (red-brick low wings, pale precast tower): podium top 22 m,
# tower block 38.1 m over x 15..40, y 46..90, west pale wing 30 m. No signage modeled.
BURY = -2.0
HEIGHT = 38.1
PODIUM = 22.0  # (est.)

COLORS = {"Brick": "A8573F", "Precast": "DAD3C6", "Roof": "7C7F83", "Band": "C9C2B4"}
ROUGHNESS = {}
WINDOWS = {"Brick": 1.0, "Precast": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material in ("Brick", "Precast"):
        return kit.scaled(WARM, 0.03)
    if material == "Band":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = fp["volumes"][0]["outline"]
    b.extrude(outline, BURY, PODIUM, "Brick", top="Roof")
    b.block((27.5, 68.0), 12.5, 22.0, PODIUM, HEIGHT, "Precast", top="Roof")
    b.block((-27.0, 77.0), 12.0, 9.5, PODIUM, 30.0, "Precast", top="Roof")
    b.block((27.5, 68.0), 12.8, 22.3, PODIUM - 0.5, PODIUM + 0.5, "Band")


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
