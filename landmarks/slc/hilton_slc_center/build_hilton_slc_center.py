"""Low-poly model of Hilton Salt Lake City Center (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - total height 56.6 m: project data (lidar). Plan: mapped footprint (footprint.json).
  - tower 54 m, east wing 46 m, base band 5 m, floor pitch 3.3 m: estimated from refs/Hilton_slc.jpg
    (cream precast, continuous dark window strips, taller central core). Brand signs left plain.
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

STEM = "hilton_slc_center"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 56.6
TOWER_TOP, WING_TOP, CORE = 54.0, 46.0, 56.6   # est.

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "F0E6C6",
    "Glass": "2E3037",
    "Roof": "8C8A84",
    "Base": "D9C6AE",
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
        return kit.scaled(COOL, 0.15 + 0.5 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    return (0.02, 0.02, 0.02) if material == "Roof" else (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def bands(b, poly, top):
    b.extrude(poly, BURY, 5.0, "Base")
    z = 5.0
    while z + 3.3 <= top + 0.01:
        b.extrude(poly, z, z + 1.3, "Wall")
        b.extrude(poly, z + 1.3, z + 3.3, "Glass")
        z += 3.3
    b.extrude(poly, z, top, "Wall", top="Roof")


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    west = [fp[0], fp[2], fp[3], fp[6], fp[7], fp[8]]
    east = [fp[3], fp[4], fp[5], fp[6]]
    bands(b, west, TOWER_TOP)
    bands(b, east, WING_TOP)
    b.block((-1.0, -2.0), 4.0, 6.0, TOWER_TOP - 0.5, CORE, "Wall", top="Roof")


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
