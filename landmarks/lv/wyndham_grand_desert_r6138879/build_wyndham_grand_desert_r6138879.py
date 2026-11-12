"""Low-poly model of a two-wing L-plan timeshare resort east of the Las Vegas Strip (id r6138879).
Sign areas are plain; no logos or wordmarks.

Sources:
  - height 54.2 m: project data (lidar); second wing top 43.2 m: footprint.json volume top (project data)
  - plan: footprint.json (skyline_tool.py footprint), two mapped L-shaped volumes, offset 0,0
  - facade: no usable Commons photo (search returned 0 files); plausible painted-stucco hotel facade
    with window strips, base band, crown band and terracotta roof plant (all est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "wyndham_grand_desert_r6138879"
MAX_TRIS = 2_500
BURY = -2.8
BASE = 6.0     # est. plain base band
CROWN = 3.5    # est. crown band
PLANT = 3.0    # est. roof plant, kept inside the published top

COLORS = {"Wall": "D8BE96", "Glass": "3B4044", "Crown": "E6D2AE", "Roof": "8C877C", "Tile": "A85A3C"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 15.0))
    if material in ("Crown", "Tile"):
        return kit.scaled(WARM, 0.4)
    return (0.0, 0.0, 0.0)


def wing(b, plan, top):
    body = top - PLANT
    rings = kit.footprint_rings(plan, [BURY, BASE, body - CROWN, body])
    b.loft(rings, ["Wall", "Glass", "Crown"])
    b.fins(plan, BASE, body - CROWN, 9.0, 0.5, 4.5, "Wall", corner_angle=60.0)
    b.extrude(kit.offset_polygon(plan, -5.0), body, top, "Tile", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for v in kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]:
        wing(b, v["outline"], v["top"])
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
