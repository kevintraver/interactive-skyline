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

STEM = "one_utah_center"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 106.7             # project data (osm-height); footprint volumes keep their mapped tops
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))
GLASS_SET = {4, 5}
GLASS_IDX = 3              # central spine volume, tallest (106.6 incl. hipped crown)
CROWN0 = 96.0              # glass spine eaves; hip rises to HEIGHT (est. from photo UtahOne.jpg)
PODIUM = 8.0

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB, from Slc_utah_one_center.jpg
    "Granite": "B89C88",
    "Glass": "1B2733",
    "Podium": "A58A78",
    "Crown": "2E3E4C",
    "Cap": "8F7C6E",
}
ROUGHNESS = {"Glass": 0.3, "Crown": 0.3}
WINDOWS = {"Glass": 1.0, "Granite": 0.6}

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = center[2]
    if material in ("Podium", "Cap"):
        return kit.scaled(WARM, 0.25 if z < 12 else 0.05)
    if material == "Granite":
        return kit.scaled(WARM, 0.03)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Crown":
        return kit.scaled(COOL, 0.25)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    for i, v in enumerate(FP["volumes"]):
        o = v["outline"]
        if v["top"] <= PODIUM + 0.1:
            b.extrude(o, BURY, v["top"], "Podium", top="Cap")
            continue
        b.extrude(o, BURY, PODIUM, "Podium", top="Podium")
        if i == GLASS_IDX:
            b.extrude(o, PODIUM, CROWN0, "Glass", top="Crown")
            cx = sum(p[0] for p in o) / len(o)
            cy = sum(p[1] for p in o) / len(o)
            for k, (f, z0, z1) in enumerate([(0.8, CROWN0, 101.5), (0.55, 101.5, HEIGHT)]):
                ring = kit.scale_polygon(o, f, (cx, cy)) if False else [(cx + (x - cx) * f, cy + (y - cy) * f) for x, y in o]
                b.extrude(ring, z0, z1, "Crown", top="Crown")
        else:
            b.extrude(o, PODIUM, v["top"] - 2.0, "Glass" if i in GLASS_SET else "Granite", top="Granite")
            b.extrude(o, v["top"] - 2.0, v["top"], "Cap", top="Cap")


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
