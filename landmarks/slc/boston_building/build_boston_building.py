"""Low-poly model of the Boston Building (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_boston_building.py -- --out .

Units are meters. No signage is modeled: the sign area near the top is a plain surface.

Sources:
  - height 50.0 m: project data (lidar)
  - footprint: mapped plan (footprint.json), rounded SW corner
  - base ~9 m (2 floors), cornice ~2.2 m: estimated from Commons photos (Slc_boston_building.jpg)
  - colors: tan terra cotta over a darker stone base, read off the same photos
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "boston_building"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 50.0
BASE_H = 9.0   # (est.)
CORN_H = 2.2   # (est.)

COLORS = {
    "Terracotta": "BDB09A",
    "BaseStone": "8E8272",
    "Glass": "4A525A",
    "Cornice": "B4A68C",
    "Roof": "6E6E6C",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Terracotta", "BaseStone"):
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 14.0))
    if material == "Cornice":
        return kit.scaled(WARM, 0.5)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(plan, BURY, BASE_H, "BaseStone", top="BaseStone")
    top_z = HEIGHT - CORN_H
    b.extrude(plan, BASE_H, top_z, "Terracotta", top="Terracotta")
    floors = 9  # upper floors between base band and cornice (est.)
    pitch = (top_z - BASE_H - 2.0) / floors
    win = offset_win = kit.offset_polygon(plan, 0.12)
    for i in range(floors):
        z0 = BASE_H + 1.4 + i * pitch
        b.extrude(win, z0, z0 + pitch * 0.62, "Glass")
    b.extrude(kit.offset_polygon(plan, 0.2), BASE_H, BASE_H + 1.0, "Cornice")
    b.extrude(kit.offset_polygon(plan, 0.2), top_z - 1.0, top_z, "Cornice")
    b.extrude(kit.offset_polygon(plan, 0.5), HEIGHT - CORN_H, HEIGHT, "Cornice", top="Roof")
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
