"""Low-poly model of City Centre 1 (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_city_centre_1.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 41.0 m: project data (lidar, 17 floors)
  - plan: mapped footprint (footprint.json), the podium follows it exactly
  - podium ~14 m (est.), tower blocks and their plan positions/heights (est.) read off refs/Workday_offices_43168354454_.jpg:
    brick podium with terraced bands, bronze-black glass tower of two stepped blocks (brand sign left plain)
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

STEM = "city_centre_1"
MAX_TRIS = 6_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 41.0             # project data (lidar)
PODIUM = 14.0             # est. from photo
MID = 30.0                # est., lower tower block top

# ---------------------------------------------------------------------- style
COLORS = {
    "Brick": "6E4C44",
    "Band": "8A7468",
    "Glass": "3A2E2A",
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
    if material == "Brick":
        return kit.scaled(WARM, 0.08 + 0.2 * math.exp(-max(z, 0.0) / 8.0))
    if material == "Band":
        return kit.scaled(WARM, 0.12)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        b.extrude(v["outline"], BURY, PODIUM, "Brick", top="Roof")
        # terrace bands: thin lighter slabs at floor levels, slightly proud via scaled plan is skipped (keeps plan exact)
    # tower: lower wide block and taller set-back block, glass bottom starts at podium roof
    b.block((6.0, -11.0), 33.0, 13.0, PODIUM - 0.5, MID, "Glass", top="Roof")
    b.block((10.0, -6.0), 32.0, 10.0, PODIUM - 0.5, HEIGHT - 3.0, "Glass", top="Roof")
    # plain roof parapet band on podium edge not modeled; mechanical penthouse on tall block
    b.block((18.0, -6.0), 8.0, 4.0, HEIGHT - 3.0, HEIGHT, "Band", top="Roof")


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
