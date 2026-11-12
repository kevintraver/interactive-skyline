"""Low-poly model of the Deseret Building (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 52.1 m: project data (lidar). Plan: mapped footprint (footprint.json, one L-shaped volume).
  - Proportions (est.) read off refs/Slc_deseret_building.jpg: 2-storey stone base, ~10 floors of window
    shaft with pilasters, 2-floor colonnaded attic, projecting cornice. Floor height ~3.5 m (14 floors).
  - Signs on the attic and base are left plain.
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

STEM = "deseret_building"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 52.1
COLORS = {
    "Stone": "D9CABD",   # pinkish-tan terra cotta/granite (photo)
    "Glass": "1E2833",
    "Roof": "8C8680",
    "Cornice": "E2D5C8",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Stone", "Cornice"):  # soft warm floodlight, stronger at base and cornice
        top = math.exp(-abs(z - 50.0) / 4.0)
        base = math.exp(-max(z, 0.0) / 10.0)
        return kit.scaled(WARM, 0.06 + 0.25 * max(top, base))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    off = kit.offset_polygon
    b.extrude(off(plan, 0.3), BURY, 8.0, "Stone", top="Cornice")             # 2-storey base
    b.extrude(off(plan, 0.38), 1.0, 5.0, "Glass")                            # storefront band
    b.fins(off(plan, 0.3), 1.0, 5.0, 3.2, 0.2, 1.2, "Stone")
    b.extrude(off(plan, 0.55), 8.0, 9.0, "Cornice", top="Cornice")           # belt course
    b.extrude(off(plan, -0.1), 8.9, 44.0, "Glass", top="Stone")              # window shaft
    b.fins(plan, 9.0, 44.0, 3.2, 0.35, 1.3, "Stone")                         # pilasters
    for k in range(10):                                                      # spandrel bands
        z = 11.2 + 3.5 * k
        b.extrude(off(plan, 0.12), z, z + 1.3, "Stone")
    b.extrude(off(plan, 0.45), 43.5, 44.5, "Cornice", top="Cornice")         # attic sill
    b.extrude(off(plan, -0.1), 44.4, 49.0, "Glass", top="Stone")             # colonnaded attic
    b.fins(plan, 44.4, 49.0, 3.0, 0.5, 0.8, "Stone")
    b.extrude(off(plan, 0.9), 49.0, 52.1, "Cornice", top="Roof")             # projecting cornice


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
