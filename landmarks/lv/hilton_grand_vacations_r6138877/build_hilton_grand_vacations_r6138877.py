"""Low-poly model of a three-wing timeshare tower on Las Vegas Boulevard (id r6138877).
Sign areas are plain; no logos or wordmarks.

Sources:
  - height 123.0 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint), three mapped volumes, offset 0,0
  - facade (beige stucco, vertical window strips, stepped crown with taller center): Commons search sheet
    (refs/search.json/commons_sheet.jpg, "Hilton Vacations 1.jpg"); wing/crown heights are estimates (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hilton_grand_vacations_r6138877"
MAX_TRIS = 2_500
BURY = -2.7
HEIGHT = 123.0        # project data
WING_TOP = 106.0      # est. from photo: wings step down below the central crown
HUB_BODY = 115.0      # est.
BASE = 9.0            # est. plain base band
CROWN = 7.0           # est. plain crown band

COLORS = {"Wall": "D9C6A0", "Glass": "3A3F42", "Crown": "E3D3B0", "Roof": "8E8A80"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    return (0.0, 0.0, 0.0)


def tower(b, plan, top, spacing):
    rings = kit.footprint_rings(plan, [BURY, BASE, top - CROWN, top])
    b.loft(rings, ["Wall", "Glass", "Crown"])
    b.fins(plan, BASE, top - CROWN, spacing, 0.4, spacing * 0.55, "Wall", corner_angle=60.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    hub, south, east = [v["outline"] for v in kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]]
    tower(b, south, WING_TOP, 7.5)
    tower(b, east, WING_TOP, 7.5)
    tower(b, hub, HUB_BODY, 3.6)
    # stepped crown on the hub (plain, sign-free)
    b.extrude(kit.scale_polygon(hub, 0.72), HUB_BODY, HEIGHT - 3.0, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(hub, 0.45), HEIGHT - 3.0, HEIGHT, "Wall", top="Roof")
    # roof plant on the wings
    for plan in (south, east):
        b.extrude(kit.scale_polygon(plan, 0.6), WING_TOP, WING_TOP + 3.5, "Wall", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
