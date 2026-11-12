"""Low-poly model of Liberty Sky (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_liberty_sky.py -- --out .

Units are meters. Signage/banners are deliberately not modeled.
Sources:
  - height 64 m: project data (osm-levels, 20 floors); footprint.json: mapped plan (skyline_tool.py footprint)
  - base height 8 m, slab pitch, colors: estimated from one Commons photo (Liberty SKY apartments, 4 May 2024)
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "liberty_sky"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 64.0
BASE_H = 8.0   # tan 2-storey base (est.)
FLOORS = 20

COLORS = {
    "Concrete": "B4B2AC",
    "Glass": "2A5C9C",
    "Base": "C9AE8C",
    "Cap": "D0CFCB",
    "Accent": "D97A2B",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.35)
    if material == "Accent":
        return kit.scaled(WARM, 0.6)
    if material == "Cap":
        return kit.scaled(COOL, 0.08)
    if material == "Concrete":
        return kit.scaled(COOL, 0.05)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    b.extrude(plan, BURY, BASE_H, "Base", top="Cap")
    core = kit.offset_polygon(plan, -0.6)
    top = HEIGHT - 2.0
    b.extrude(core, BASE_H, top, "Glass", top="Concrete")
    pitch = (top - BASE_H) / (FLOORS - 2)
    slab = kit.offset_polygon(plan, -0.1)
    for i in range(FLOORS - 1):
        z = BASE_H + i * pitch
        b.extrude(slab, z, z + 0.35, "Concrete")
    b.extrude(plan, top, HEIGHT - 0.8, "Cap", top="Cap")
    b.extrude(kit.scale_polygon(plan, 0.2), HEIGHT - 0.8, HEIGHT, "Accent")


def part_files() -> dict:
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, **part_files()}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
