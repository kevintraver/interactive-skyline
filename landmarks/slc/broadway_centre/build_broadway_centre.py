"""Low-poly model of Broadway Centre (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 57.6 m: project data (osm-height); volume tops 6/41/45/49/53/57.6 m from mapped footprint
  - plan: mapped footprint (footprint.json); podium 6 m top (est., from photos: ~2 storeys stone base)
  - colors: blue-teal reflective glass, pale stone piers, from Commons photos (est.)
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

STEM = "broadway_centre"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 57.6             # project data

# ---------------------------------------------------------------------- style
COLORS = {
    "Glass": "4A86A8",
    "Stone": "CFC8B8",
    "Cap": "9AA0A4",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Stone":  # lit podium and piers near the ground
        return kit.scaled(WARM, 0.12 + 0.45 * math.exp(-max(z, 0.0) / 10.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(COOL, 0.10)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
PODIUM = 6.0
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))


def build_body(b: kit.Builder) -> None:
    vols = FP["volumes"]
    for v in vols:
        if v["top"] <= PODIUM + 0.1:
            b.extrude(v["outline"], BURY, v["top"], "Stone", top="Cap")
    for v in vols:
        if v["top"] > PODIUM + 0.1:
            top = v["top"]
            b.extrude(v["outline"], PODIUM, top - 1.2, "Glass", top="Glass")
            b.extrude(v["outline"], top - 1.2, top, "Stone", top="Cap")  # plain parapet band


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
