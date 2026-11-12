"""Low-poly model of The Worthington (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 102.0 m: project data (osm-height, 31 floors)
  - plan: mapped footprint (footprint.json, 3 volumes: 9.9 m / 35.2 m / 102 m tops)
  - colors, crown and bands: estimated from general knowledge of the building (modern residential tower)
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

STEM = "the_worthington"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 102.0             # project data

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "B9B2A6",
    "Podium": "8A6A55",
    "Glass": "3E5668",
    "Band": "D9D6CF",
    "Roof": "8C9094",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Wall", "Podium", "Band"):  # floodlights at the base, fading upward
        return kit.scaled(COOL, 0.1 + 0.4 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    low, mid, tower = fp["volumes"]
    # low wing and mid block: precast/brick podium (heights from footprint; est. colors)
    b.extrude(low["outline"], BURY, low["top"], "Podium", top="Roof")
    b.extrude(mid["outline"], BURY, mid["top"], "Podium", top="Roof")
    # tower: glass shaft with a precast base, floor-band stripes and a plain parapet crown
    out = tower["outline"]
    b.extrude(out, BURY, 12.0, "Wall")
    b.extrude(out, 12.0, 96.0, "Glass")
    for z in (36.0, 60.0, 84.0):  # est. banding every ~8 floors
        b.extrude(kit.scale_polygon(out, 1.012), z, z + 1.2, "Band")
    b.extrude(out, 96.0, HEIGHT - 2.0, "Wall")
    b.extrude(kit.scale_polygon(out, 0.9), HEIGHT - 2.0, HEIGHT, "Wall", top="Roof")


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
