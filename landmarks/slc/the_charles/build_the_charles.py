"""Low-poly model of The Charles (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_the_charles.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 38.4 m (main), 35.2 m (south wing), 4 m podium blocks: project footprint volumes (osm-levels)
  - plan: footprint.json from skyline_tool.py footprint (mapped outline, offset 0,0)
  - No usable Commons photos: facade colors, band heights, rooftop box and parapet are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_charles"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 38.4  # project data (osm-levels)

COLORS = {  # estimated mid-rise apartment palette
    "Brick": "8A5A48",
    "Glass": "5E7384",
    "Trim": "CFC9BC",
    "Base": "5E5750",
    "Roof": "7A7D80",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material in ("Brick", "Base", "Trim"):
        return kit.scaled(WARM, 0.04 + 0.12 * math.exp(-max(point[2], 0.0) / 10.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        out, top = v["outline"], v["top"]
        if top <= 6:  # podium blocks
            b.extrude(out, BURY, top, "Base", top="Roof")
            continue
        b.extrude(out, BURY, 4.2, "Brick", top="Trim")       # ground floor (est.)
        b.extrude(out, 4.2, top - 1.2, "Glass", top="Trim")  # windowed floors
        b.extrude(out, top - 1.2, top, "Trim", top="Roof")   # parapet band (est.)


def build_roof(b: kit.Builder) -> None:
    b.block((0.0, 8.0), 8.0, 5.0, HEIGHT - 1.2, HEIGHT, "Roof")  # rooftop mechanical screen (est.), keeps height


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    build_roof(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
