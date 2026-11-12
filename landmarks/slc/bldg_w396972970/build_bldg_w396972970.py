"""Low-poly model of <LANDMARK> (<CITY>), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_bldg_w396972970.py -- --out .

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

STEM = "bldg_w396972970"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 41.8              # project lidar height
# Plan: mapped footprint volumes (OSM/lidar tops kept). Identified as the Salt Palace convention center from
# Commons photos; cylindrical glass tower (radius 8 m, est. from photo) replaces the 41.8 m box volume.

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "B9AE98",
    "Glass": "5E7C92",
    "Frame": "E4E4E0",
    "Roof": "8C8E90",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)
FP = os.path.join(HERE, "footprint.json")


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Wall":  # floodlights at the base, fading upward
        return kit.scaled(COOL, 0.15 + 0.5 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(WARM, 0.25 if z > 30 else 0.06)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    doc = kit.load_footprint(FP)
    for v in doc["volumes"]:
        if abs(v["top"] - HEIGHT) < 0.05:
            continue  # the tower is drawn round below
        # the 39.9 m mapped volume is the hall roof around the tower; photos show low halls (est. 22 m)
        top = 22.0 if abs(v["top"] - 39.9) < 0.05 else v["top"]
        b.extrude(v["outline"], BURY, top, "Wall", top="Roof")


def build_tower(b: kit.Builder) -> None:
    c = (-10.9, 18.5)
    b.prism(8.0, BURY, 5.0, 16, "Frame", center=c)
    b.prism(8.0, 5.0, 38.0, 16, "Glass", center=c)
    b.prism(8.3, 38.0, HEIGHT - 0.5, 16, "Frame", center=c)
    b.prism(8.3, HEIGHT - 0.5, HEIGHT, 16, "Roof", center=c)


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "tower": build_tower, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
