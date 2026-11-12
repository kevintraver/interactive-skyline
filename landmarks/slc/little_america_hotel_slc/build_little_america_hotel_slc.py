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

STEM = "little_america_hotel_slc"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 55.9             # project data (lidar); tower footprint from skyline_tool footprint; podium top 11.6 m (mapped volume)

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB, from Commons photos 0 and 4 (red-brown brick tower, blue-grey roofs)
    "Brick": "8E4A3A",
    "Glass": "2B3440",
    "Roof": "5A6068",
    "Podium": "B9AE9A",
    "Crown": "6E3A2E",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Brick":
        return kit.scaled(WARM, 0.04)
    if material == "Crown":
        return kit.scaled(WARM, 0.35)
    if material == "Podium":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower, podium = fp["volumes"][0]["outline"], fp["volumes"][1]["outline"]
    b.extrude(tower, BURY, HEIGHT - 3.0, "Brick")
    b.extrude(kit.scale_polygon(tower, 1.002), HEIGHT - 3.0, HEIGHT, "Crown", top="Roof")  # slightly wider top band
    z = 8.0
    while z + 2.0 < HEIGHT - 4.0:  # window bands, one per floor pair (est. 3.3 m floors)
        b.extrude(kit.scale_polygon(tower, 1.003), z + 0.6, z + 1.8, "Glass")
        z += 3.3
    b.extrude(podium, BURY, 11.6, "Podium", top="Roof")


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
