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

STEM = "45_west_south_temple"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 43.0              # project data (lidar)

# ---------------------------------------------------------------------- style
COLORS = {  # from Commons photos of the building (red-brown brick, bronze-tinted glass bays)
    "Wall": "7A4636",
    "Glass": "5B6670",
    "Roof": "4A3A34",
    "Band": "5E3629",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Wall":  # floodlights at the base, fading upward
        return kit.scaled(COOL, 0.03 + 0.12 * math.exp(-max(z, 0.0) / 15.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    if material == "Band":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = fp["volumes"][0]["outline"]
    b.extrude(outline, BURY, HEIGHT - 3.0, "Wall", top="Roof")
    b.extrude(outline, HEIGHT - 3.0, HEIGHT, "Band", top="Roof")  # darker brick parapet band (est.)
    # glass curtain bays proud of the brick on the street (north) face and the east end (est. from photos)
    b.block((14.0, 20.95), 7.0, 0.25, 4.0, HEIGHT - 5.0, "Glass")
    b.block((-0.5, 20.95), 3.0, 0.25, 4.0, HEIGHT - 5.0, "Glass")
    b.block((-2.5, -23.75), 8.0, 0.25, 4.0, HEIGHT - 5.0, "Glass")
    b.block((-14.0, -5.0), 0.25, 8.0, 4.0, HEIGHT - 5.0, "Glass")


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
