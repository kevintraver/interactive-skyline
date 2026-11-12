"""Low-poly model of a mid-rise convention hotel on Paradise Road, Las Vegas (id r19484714).
Sign areas are plain; no logos or wordmarks.

Sources:
  - height 49.3 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint), one mapped volume about 74 x 75 m, offset 0,0
  - no usable Commons photo (search returned 1 unrelated file). All of the following are estimates:
    the mapped plan is too deep for hotel rooms, so it is read as a low podium (9 m) with an L-shaped
    room tower (about 22 m deep) along the west and north edges, following the chamfered NW corner;
    dark bronze glass facade with bronze bands, crown band and roof plant.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "3400_paradise_road_r19484714"
MAX_TRIS = 2_500
BURY = -2.0
TOP = 49.3      # project data (lidar)
PODIUM = 9.0    # est.
CROWN = 3.0     # est.
PLANT = 3.5     # est. roof plant, inside the published top

# est. L-shaped tower on the west and north edges of the mapped plan (CCW)
TOWER = [(-36, -35), (-14, -35), (-14, 14), (32, 14), (32, 36.1),
         (-22, 37.5), (-36, 24)]

COLORS = {"Podium": "B9A58A", "Bronze": "6E4E36", "Glass": "3A2E26", "Crown": "7A583C", "Roof": "8C877C"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.8, 0.55)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Podium":
        return kit.scaled(WARM, 0.1 + 0.3 * math.exp(-max(z, 0.0) / 6.0))
    if material == "Bronze":
        return kit.scaled(WARM, 0.06)
    if material == "Crown":
        return kit.scaled(WARM, 0.4)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    plan = kit.ccw_polygon(plan)
    b.extrude(plan, BURY, PODIUM, "Podium", top="Roof")
    tower = kit.offset_polygon(TOWER, -0.4)
    body = TOP - PLANT
    rings = kit.footprint_rings(tower, [PODIUM - 0.5, PODIUM + 3.0, body - CROWN, body])
    b.loft(rings, ["Bronze", "Glass", "Crown"])
    b.fins(tower, PODIUM + 3.0, body - CROWN, 8.0, 0.5, 1.2, "Bronze", corner_angle=60.0)
    b.extrude(kit.offset_polygon(tower, -5.0), body, TOP, "Bronze", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
