"""Low-poly model of an L-shaped timeshare suites block near the Las Vegas Convention Center (id r6138876).
Sign areas are plain; no logos or wordmarks.

Sources:
  - height 55.1 m: project data (lidar); wing 53.0 m and pavilion 9.3 m: footprint.json volume tops
  - plan: footprint.json (skyline_tool.py footprint), three mapped volumes, offset 0,0
  - no usable Commons photos: facade (beige stucco, window strips, plain base and crown bands) is a
    plausible estimate (est.), as are BASE, CROWN and roof-plant sizes
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hilton_grand_vacations_r6138876"
MAX_TRIS = 2_500
BURY = -2.5
HEIGHT = 55.1         # project data (lidar)
BASE = 6.0            # est. plain base band
CROWN = 3.5           # est. plain crown band

COLORS = {"Wall": "D8C4A2", "Glass": "3A4044", "Crown": "E4D5B6", "Roof": "8E8A80", "Low": "CDBB9C"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Low"):
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 15.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.40)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    pavilion, hub, wing = [v["outline"] for v in vols]
    wing_top = vols[2]["top"]
    # main L-shaped wing: base band, glazed body with stucco piers, crown band
    b.loft(kit.footprint_rings(wing, [BURY, BASE, wing_top - CROWN, wing_top]), ["Wall", "Glass", "Crown"])
    b.fins(wing, BASE, wing_top - CROWN, 6.5, 0.4, 3.4, "Wall", corner_angle=60.0)
    b.extrude(kit.scale_polygon(wing, 0.55), wing_top, wing_top + 1.2, "Wall", top="Roof")
    # octagonal hub in the inner corner, slightly taller, with a plain cap
    hub_o = kit.scale_polygon(hub, 1.04)
    b.loft(kit.footprint_rings(hub_o, [BURY, BASE + 1.0, HEIGHT - 5.0, HEIGHT - 1.5]), ["Wall", "Glass", "Crown"])
    b.fins(hub_o, BASE + 1.0, HEIGHT - 5.0, 3.0, 0.35, 1.5, "Wall", corner_angle=60.0)
    b.extrude(kit.scale_polygon(hub, 0.7), HEIGHT - 1.5, HEIGHT, "Crown", top="Roof")
    # low entrance pavilion (mapped at 9.3 m)
    b.extrude(pavilion, BURY, vols[0]["top"] - 1.5, "Low", top="Roof")
    b.extrude(kit.scale_polygon(pavilion, 0.6), vols[0]["top"] - 1.5, vols[0]["top"], "Crown", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
