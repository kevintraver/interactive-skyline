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

STEM = "marriott_downtown_city_creek"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 46.5             # project data (lidar); footprint volumes give tops 46.6 tower / 13.0 podium
FOOT = os.path.join(HERE, "footprint.json")  # skyline_tool.py footprint (mapped plan)
# Facade, cap, piers and podium colors read off refs/Slc_marriott_city_creek.jpg; slab spacing 14 floors (est.)

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "B9A58B",
    "Slab": "D8CDB6",
    "Podium": "A98F7D",
    "Glass": "2F5A5C",
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
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light
    if material in ("Wall", "Slab"):
        return kit.scaled(WARM, 0.04)
    if material == "Podium":
        return kit.scaled(WARM, 0.12 + 0.2 * math.exp(-max(z, 0.0) / 6.0))  # lit entry level
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
X0, X1, Y0, Y1 = -45.5, 44.5, -30.1, -7.1  # tower plan (footprint volume 0, rounded)
TOP, FLOORS, SLAB0 = 46.6, 14, 13.0


def build_body(b: kit.Builder) -> None:
    doc = kit.load_footprint(FOOT)
    tower, podium = doc["volumes"][0], doc["volumes"][1]
    b.extrude(podium["outline"], BURY, podium["top"], "Podium", top="Roof")
    cx, cy = (X0 + X1) / 2, (Y0 + Y1) / 2
    hx = (X1 - X0) / 2
    # glass core, recessed from the long faces
    b.block((cx, cy), hx - 6.0, (Y1 - Y0) / 2 - 0.9, 12.0, TOP - 4.0, "Glass")
    # floor slabs (cream) on both long faces
    step = (TOP - 4.0 - SLAB0) / FLOORS
    for i in range(FLOORS):
        z = SLAB0 + i * step
        b.block((cx - 3.0, cy), hx - 9.0, (Y1 - Y0) / 2, z, z + 1.1, "Slab")
    # solid end piers and the overhanging cap
    b.block((X1 - 5.0, cy), 5.5, (Y1 - Y0) / 2, 12.0, TOP, "Wall")
    b.block((X0 + 3.0, cy), 3.5, (Y1 - Y0) / 2, 12.0, TOP, "Wall")
    b.block((cx, cy), hx, (Y1 - Y0) / 2, TOP - 4.0, TOP, "Wall", top="Roof")
    b.block((cx, cy), hx - 6.0, (Y1 - Y0) / 2 - 0.9, 0.0, 12.0, "Wall")  # tower base inside podium


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
