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

STEM = "joseph_smith_memorial_building"
MAX_TRIS = 5_000

# Sources: height 55.5 m project data (osm-height); plan = mapped footprint volumes; centre wing 39.4 m mapped.
# Base course 12 m, cornice, cupola sizes estimated from refs photos. Logos/signs not modeled.
BURY = -2.0
COLORS = {  # read off refs photos
    "Facade": "E4DFD2",   # white glazed terra cotta
    "Base": "CFC9BA",
    "Cornice": "D9D3C4",
    "Roof": "5E6064",
    "Cupola": "DDD7C8",
    "Dome": "8A9A94",
}
ROUGHNESS = {}
WINDOWS = {"Facade": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = center[2]
    if material == "Facade":
        return kit.scaled(WARM, 0.03)  # windows supply the light
    if material == "Base":
        return kit.scaled(WARM, 0.45)  # floodlit base
    if material == "Cornice":
        return kit.scaled(WARM, 0.35)
    if material in ("Cupola", "Dome"):
        return kit.scaled(WARM, 0.7)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    main, centre = fp["volumes"][0], fp["volumes"][1]
    plan = main["outline"]
    # base course, shaft, projecting cornice, roof cap (heights est. from photos: base ~ 2 storeys)
    b.extrude(plan, BURY, 12.0, "Base", top="Cornice")
    b.extrude(kit.offset_polygon(plan, -0.0), 12.0, 51.5, "Facade")
    b.extrude(kit.offset_polygon(plan, 0.9), 51.5, 55.5, "Cornice", top="Roof")
    b.fins(plan, 12.6, 51.0, 9.0, 0.5, 1.2, "Cornice")  # pilaster strips (est.)
    # centre wing
    cp = centre["outline"]
    b.extrude(kit.offset_polygon(cp, 0.8), 36.4, 39.4, "Cornice", top="Roof")
    # rear cupola (plain, no figures) on the centre wing
    cx = sum(p[0] for p in cp) / len(cp); cy = sum(p[1] for p in cp) / len(cp)
    b.block((cx, cy), 5.5, 4.5, 39.4, 47.0, "Cupola", top="Roof")
    b.block((cx, cy), 6.5, 5.5, 47.0, 48.0, "Cornice", top="Roof")


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
