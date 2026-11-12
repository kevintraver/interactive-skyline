"""Low-poly model of 111 Main (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 118 m: project data (osm-height, 23 floors)
  - plan: mapped footprint (footprint.json), 48 x 38 m
  - proportions read off refs/Main_Street_Salt_Lake_City_2021.jpg: glass lobby ~16 m (est.), warm band ~3 m (est.),
    white spandrel bands every 3 floors (est.); rooftop mechanical box (est.)
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

STEM = "111_main"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 118.0            # project data

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "D8D2C4",
    "Glass": "3A5468",
    "Lobby": "6A7E8A",
    "Band": "C9B48A",
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
    if material == "Wall":  # floodlights at the base, fading upward
        return kit.scaled(COOL, 0.15 + 0.5 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Lobby":
        return kit.scaled(WARM, 0.45)
    if material == "Band":
        return kit.scaled(WARM, 0.5)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(fp, BURY, 16.0, "Lobby")
    b.extrude(fp, 16.0, 19.0, "Band")
    z = 19.0
    step = 3 * (HEIGHT - 19.0 - 4.0) / 23
    n = 0
    while z < HEIGHT - 4.0 - 1e-6:
        z1 = min(z + step - 0.8, HEIGHT - 4.0)
        b.extrude(fp, z, z1, "Glass")
        z2 = min(z1 + 0.8, HEIGHT - 4.0)
        if z2 - z1 > 0.1:
            b.extrude(fp, z1, z2, "Wall")
        z = z2
    b.extrude(fp, HEIGHT - 4.0, HEIGHT - 3.0, "Band", top="Roof")
    b.extrude(kit.scale_polygon(fp, 0.55), HEIGHT - 3.0, HEIGHT, "Wall", top="Roof")


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
