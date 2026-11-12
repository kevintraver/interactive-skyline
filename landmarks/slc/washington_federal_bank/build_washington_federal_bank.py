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

STEM = "washington_federal_bank"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 58.8              # project data (lidar), 13 floors
PODIUM_TOP = 12.0          # (est.) 2-3 storey base read off Commons photos
TOWER = (-17.8, 23.5, -4.5, 22.4)   # (est.) slab = northern wing of the mapped footprint; x0,x1,y0,y1
CORE_X = 15.5              # brick service core at east end (photos: red-brown end tower)
FLOORS = 13

COLORS = {
    "Glass": "56687A", "Brick": "8A4B38", "Precast": "DAD6CC", "Podium": "B9B4A8", "Roof": "8C9094",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Brick", "Precast"):
        return kit.scaled(COOL, 0.08 + 0.3 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Podium":
        return kit.scaled(WARM, 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = fp["volumes"][0]["outline"]
    b.extrude(outline, BURY, PODIUM_TOP, "Podium", top="Roof")
    x0, x1, y0, y1 = TOWER
    cx, cy = (x0 + CORE_X) / 2, (y0 + y1) / 2
    hx, hy = (CORE_X - x0) / 2, (y1 - y0) / 2
    b.block((cx, cy), hx, hy, PODIUM_TOP, HEIGHT - 3.8, "Glass", top="Roof")
    b.block((cx, cy), hx + 0.4, hy + 0.4, HEIGHT - 3.8, HEIGHT - 3.0, "Precast", top="Roof")
    b.block(((CORE_X + x1) / 2, cy), (x1 - CORE_X) / 2, hy, PODIUM_TOP, HEIGHT, "Brick", top="Roof")
    step = (HEIGHT - PODIUM_TOP) / (FLOORS - 3)
    z = PODIUM_TOP + 1.0
    while z < HEIGHT - 5:
        b.block((cx, cy), hx + 0.3, hy + 0.3, z, z + 1.1, "Precast")
        z += step


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
