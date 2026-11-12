"""Low-poly model of a blue-glass slab tower (Las Vegas, id r5342155), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 183.0 m: project data (osm-height), taken as the top of the red end fin
  - plan: footprint.json (skyline_tool footprint), extruded as mapped, offset 0,0
  - glass roofline 174 m, penthouse 179 m, fin start 82 m (~45% of height), balcony/slot positions: (est.)
    read off refs/PH_Towers_Westgate_8226787057_.jpg and refs/Elara_..._02.jpg
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

STEM = "elara"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 183.0             # project data (osm-height) = fin top
ROOF = 174.0               # glass parapet (est. from photos)
MECH = 179.0               # dark mechanical penthouse (est.)
FIN_Z0 = 82.0              # fin point, ~45% of height (photo ratio)
FOOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {  # sRGB hex from daylight photos
    "Glass": "1C4C96",
    "Fin": "D8241E",
    "Slot": "0B1424",
    "Balcony": "D9DADC",
    "Roof": "4A4D52",
    "Mech": "16191E",
}
ROUGHNESS = {"Glass": 0.2, "Fin": 0.4}
WARM, RED = (1.0, 0.82, 0.58), (1.0, 0.10, 0.06)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "Glass":   # the app's lit-window pattern supplies the light
        return kit.scaled(WARM, 0.03)
    if material == "Fin":     # red fin is lit at night (est.: no night photo found)
        return kit.scaled(RED, 0.75)
    if material == "Balcony":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def rect(x0, x1, y0, y1, z):
    return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]


def build_body(b: kit.Builder) -> None:
    b.extrude(FOOT, BURY, ROOF, "Glass", top="Roof")
    b.block((-5.0, 11.5), 34.0, 8.0, ROOF, MECH, "Mech")
    b.block((40.0, -12.0), 16.0, 14.0, ROOF, ROOF + 3.0, "Mech")


def build_fin(b: kit.Builder) -> None:
    # west end: a point at 45% height widening to the full end, leaning out west at the top
    b.loft([rect(-111.6, -110.0, 5.0, 7.0, FIN_Z0),
            rect(-113.0, -110.0, -0.5, 7.5, 135.0),
            rect(-114.5, -110.0, -2.3, 7.6, HEIGHT)], "Fin")
    # north face of the narrow west bay: same wedge wrapping round, wide at the roof
    b.loft([rect(-110.9, -109.9, 6.7, 7.5, FIN_Z0),
            rect(-110.9, -98.0, 6.7, 7.7, 150.0),
            rect(-114.5, -79.5, 6.7, 8.0, HEIGHT)], "Fin")


def build_slots(b: kit.Builder) -> None:
    # dark vertical recesses at the plan kinks of the south face, balcony stacks at their tops
    for (x, y), top, n in (((-54.2, -6.2), 150.0, 4), ((-13.2, -9.9), 138.0, 4)):
        b.block((x, y), 1.0, 0.9, 0.0, top + 16.0, "Slot")
        for i in range(n):
            z = top + i * 4.0
            b.block((x, y - 1.2), 3.2, 1.6, z, z + 0.7, "Balcony")
    # balcony slats on the west end beside the fin
    for i in range(5):
        z = 148.0 + i * 5.0
        b.block((-108.0, -3.2), 2.6, 1.4, z, z + 0.7, "Balcony")


PARTS_LOCAL = {"body": build_body, "fin": build_fin, "slots": build_slots}


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {**PARTS_LOCAL, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
