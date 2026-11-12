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

STEM = "walker_center"
MAX_TRIS = 3_000
FP = os.path.join(HERE, "footprint.json")

# Sources: height 67.1 m and plan volumes (heights 58/67.1/12/5) from the project's mapped footprint (osm-height);
# colors and crown read off Commons photos Walker Bank Building (8), (5), Walker Center.jpg; stone base height
# (~3 storeys, 12 m), crown cap and mast proportions are estimated. The lit sign letters on the crown are not
# modeled (plain open steel mast only).
BURY = -2.0
HEIGHT = 67.1
CROWN = 58.5      # (est.) top of the brick shaft; cap + open mast reach 67.1 m
BASE_TOP = 12.0   # (est.) granite base, ~3 storeys

COLORS = {
    "Brick": "8A6F58",
    "Stone": "A9A298",
    "Cap": "6E6A63",
    "Steel": "4A4D52",
    "Roof": "7A7873",
}
ROUGHNESS = {"Brick": 0.9, "Stone": 0.85}
WINDOWS = {"Brick": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point, center) -> tuple:
    z = center[2]
    if material == "Stone":
        return kit.scaled(WARM, 0.12 + 0.2 * math.exp(-max(z, 0.0) / 15.0))
    if material == "Brick":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(COOL, 0.35)
    if material == "Steel":
        return kit.scaled(COOL, 0.45)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(FP)
    vols = fp["volumes"]
    for v in vols:
        if v["top"] - v["bottom"] < 2:  # 0.5 m floating slab: skipped
            continue
        out, top = v["outline"], v["top"]
        low = min(top, BASE_TOP) if top > 20 else top
        if top > 20:
            b.extrude(out, v["bottom"], low, "Stone")
            if top > 60:  # tower: shaft, setback, cap
                b.extrude(out, low, 56.0, "Brick")
                b.extrude(kit.scale_polygon(out, 0.93), 56.0, CROWN, "Brick", top="Roof")
                b.extrude(kit.scale_polygon(out, 0.99), 54.0, 54.6, "Stone")  # cornice band
            else:
                b.extrude(out, low, top - 1.0, "Brick")
                b.extrude(out, top - 1.0, top, "Stone", top="Roof")
        else:
            b.extrude(out, v["bottom"], top, "Stone", top="Roof")
    tower = max(vols, key=lambda v: v["top"])["outline"]
    cx = sum(p[0] for p in tower) / len(tower)
    cy = sum(p[1] for p in tower) / len(tower)
    ztop = CROWN
    b.block((cx, cy), 4.0, 3.2, ztop, ztop + 2.0, "Cap", top="Roof")
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.strut((cx + sx * 1.8, cy + sy * 1.5, ztop + 2.0), (cx + sx * 0.5, cy + sy * 0.4, ztop + 6.6), 0.2,
                    (1, 0, 0), "Steel")
    b.block((cx, cy), 0.9, 0.7, ztop + 6.6, ztop + HEIGHT - CROWN - 2.0 + 2.0, "Steel")


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
