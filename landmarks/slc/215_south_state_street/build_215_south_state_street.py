"""Low-poly model of 215 South State Street, the Moss federal courthouse (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 50 m and per-volume tops: project footprint data (osm-height); kept as is
  - plan: skyline_tool footprint; light granite neoclassical look read off Commons courthouse photos (est.)
  - cornice/base band heights est.
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

STEM = "215_south_state_street"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 100.0             # <source>

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "C9C6BC",
    "Glass": "2A333C",
    "Roof": "7E8286",
    "Band": "B8B5AA",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # glass bay strips on the tallest volume only
_UNUSED = 0  # facade glass that gets the app's procedural lit windows at night ({} for none)

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
    if material in ("Band", "Roof"):
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        top = v["top"]
        b.extrude(v["outline"], BURY, top, "Wall", top="Roof")
        # plinth band and cornice band slightly proud of the walls (est.)
        b.extrude(kit.offset_polygon(v["outline"], 0.4), BURY, 3.0, "Band", top="Band")
        if top > 8:
            b.extrude(kit.offset_polygon(v["outline"], 0.5), top - 1.6, top, "Band", top="Roof")
    # ribbon windows: dark glass rings 1.9 m tall every 3.8 m, proud of the granite by 0.12 m (est. floor height)
    for v in fp["volumes"]:
        if v["top"] < 12:
            continue
        ring = kit.offset_polygon(v["outline"], 0.12)
        z = 5.0
        while z + 2.0 < v["top"] - 2.0:
            b.extrude(ring, z, z + 1.5, "Glass")
            z += 3.8


def part_files() -> dict:
    return {}


PARTS = {"body": build_body, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
