"""Low-poly model of an 11-storey extended-stay hotel at Hughes Center (Las Vegas), id w205497576.

Units are meters; +X east, +Y north, +Z up. Logos and brand signage are deliberately not modeled.

Sources:
  - height 37.2 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), built in its frame, offset 0,0
  - facade: Commons photo in refs/ (cream stucco, rows of punched windows on 11 floors, darker base,
    projecting cornice); floor heights, band sizes and pilaster spacing are estimates (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "residence_inn_las_vega_w205497576"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 37.2              # project data (lidar)
BASE_TOP = 4.6             # taller ground floor (est. from photo)
CORNICE = 1.2              # cornice/parapet band depth (est.)
FLOORS = 10                # guest floors above the ground floor (photo: 11 storeys)
FLOOR_H = (HEIGHT - CORNICE - BASE_TOP) / FLOORS
WIN_H = 1.4                # window band height (est.)
PIER_SPACING = 4.2         # one pier per room bay (est.)

COLORS = {
    "Wall": "E4D8BC",      # cream stucco
    "Base": "CDBFA2",      # darker ground floor
    "Glass": "2C4A52",     # green-tinted glazing
    "Trim": "F0E8D4",      # cornice
    "Roof": "9A9690",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = center[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.22)
    if material in ("Wall", "Trim"):
        return kit.scaled(WARM, 0.04 + 0.10 * math.exp(-max(z, 0.0) / 12.0))
    return (0.0, 0.0, 0.0)


def build_body(b):
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    top = HEIGHT - CORNICE
    b.extrude(plan, BURY, top, "Wall")
    b.extrude(kit.offset_polygon(plan, 0.25), BURY, BASE_TOP, "Base")
    glass = kit.offset_polygon(plan, 0.12)
    for i in range(FLOORS):
        z0 = BASE_TOP + i * FLOOR_H + 0.9
        b.extrude(glass, z0, z0 + WIN_H, "Glass", top="Wall", bottom="Wall")
    b.fins(plan, BASE_TOP, top, PIER_SPACING, 0.22, 2.3, "Wall")
    b.extrude(kit.offset_polygon(plan, 0.6), top, HEIGHT, "Trim", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("HotelHughesCenter")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
