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

STEM = "222_main"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 96.3             # project data (osm-height); volume tops 96.3/95/90/15 from footprint.json

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Glass": "4F7F8C",   # teal-blue curtain wall (refs/222_South_Main_SLC_2025.jpg)
    "Wing": "3A5F6C",    # slightly darker teal glass, west face (reflective in photo)
    "Stone": "8E8F8C",   # grey podium
    "Roof": "D9DCDD",    # white podium roof edge
    "Cap": "5F7782",
}
ROUGHNESS = {"Glass": 0.3, "Wing": 0.5}
WINDOWS = {"Glass": 1.0, "Wing": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Stone":
        return kit.scaled(WARM, 0.12 + 0.25 * math.exp(-max(z, 0.0) / 8.0))
    if material == "Roof":
        return kit.scaled(COOL, 0.1)
    if material == "Cap":
        return kit.scaled(COOL, 0.08)
    if material in ("Glass", "Wing"):
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]  # 0 east tower, 1 core, 2 west wing, 3 podium
    mats = ["Glass", "Glass", "Wing"]
    for v, m in zip(vols[:3], mats):
        b.extrude(v["outline"], BURY, v["top"] - 3.0, m)
        b.extrude(v["outline"], v["top"] - 3.0, v["top"], "Cap", top="Cap")  # unlit mechanical band
    pod = vols[3]
    b.extrude(pod["outline"], BURY, pod["top"], "Stone", top="Roof")


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
