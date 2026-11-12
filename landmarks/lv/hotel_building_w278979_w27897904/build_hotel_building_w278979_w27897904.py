"""Low-poly model of a timeshare hotel slab (Las Vegas, id w27897904), built with landmark_kit.

Sources:
  - height 37.7 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, items 0 and 1): beige concrete slab,
    about 11 floors of window strips between beige spandrels, darker brown top band. Floor heights est.
Signage on the top band is deliberately left plain.
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hotel_building_w278979_w27897904"
MAX_TRIS = 2500
BURY = -2.0
HEIGHT = 37.7          # project lidar
BASE_TOP = 4.7         # est. ground floor
FLOORS = 10            # est. from photo (plus ground floor)
CROWN_Z = 34.7         # est. dark top band from photo
FLOOR_H = (CROWN_Z - BASE_TOP) / FLOORS
GLASS_H = 1.6          # est.

COLORS = {"Wall": "CDB48E", "Glass": "2A3138", "Crown": "6E5440", "Roof": "8A8478", "Base": "B39C7A"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Base"):  # warm floodlighting from below (night photo)
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    out = fp["volumes"][0]["outline"]
    inset = kit.offset_polygon(out, -0.25)
    b.extrude(out, BURY, BASE_TOP, "Base")
    for i in range(FLOORS):
        z = BASE_TOP + i * FLOOR_H
        b.extrude(inset, z, z + GLASS_H, "Glass")
        b.extrude(out, z + GLASS_H, z + FLOOR_H, "Wall")
    b.extrude(kit.offset_polygon(out, 0.3), CROWN_Z, HEIGHT - 0.9, "Crown", top="Roof")
    b.block((0.0, 0.0), 9.0, 5.0, HEIGHT - 0.9, HEIGHT, "Crown", top="Roof")  # mechanical penthouse (est.)
    return b.finish("HotelSlab")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
