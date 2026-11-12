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

STEM = "40_south_900_east"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 49.4             # project data (lidar, 14 floors); no usable photos found (Commons) - colors/details estimated

# ---------------------------------------------------------------------- style
COLORS = {  # estimated: no photos available
    "Base": "9A8A78",
    "Glass": "3A4A5A",
    "Band": "C9C5BC",
    "Roof": "7C7F83",
    "Mech": "A3A6AA",
}

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Base", "Band"):
        return kit.scaled(COOL, 0.06 + 0.12 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    top = HEIGHT - 3.5  # roof deck; mechanical box (est. 3.5 m) reaches the 49.4 m lidar top
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    h_base, floor = 8.0, (top - 8.0) / 12.0
    b.extrude(fp, BURY, h_base, "Base", top="Band")
    b.extrude(fp, h_base, top - 1.2, "Glass")
    for i in range(1, 12, 4):  # a few floor bands
        z = h_base + i * floor
        b.extrude(kit.offset_polygon(fp, 0.25), z - 0.3, z + 0.3, "Band")
    b.extrude(kit.offset_polygon(fp, 0.3), top - 1.2, top, "Band", top="Roof")
    b.block((-4.0, 0.0), 9.0, 7.0, top, HEIGHT, "Mech", top="Roof")


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
