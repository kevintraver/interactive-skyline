"""Low-poly model of a 1960s crescent hotel tower at a Las Vegas Strip resort (id w134949098), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 52.0 m: project data, trusted
  - plan: footprint.json (skyline_tool.py footprint), three-segment crescent outline, offset 0,0
  - facade: Wikimedia Commons search sheet only (distant resort views, nothing downloaded): white
    concrete with window strips, flat roof, cornice. Base, band, cornice, fin and penthouse sizes
    are all estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "julius_tower_w134949098"
MAX_TRIS = 2_500

BURY = -2.0
H = 52.0          # project data
H_ROOF = 49.0     # est. main parapet; penthouse reaches H
H_CORN = 46.5     # est. underside of the white cornice
H_BASE = 6.0      # est. plain base
COLORS = {
    "Wall": "ECE8DF",
    "Glass": "B9BEC1",   # white grid with dark windows, averaged
    "Roof": "98958E",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":  # flood-lit white concrete, brighter at the cornice
        return kit.scaled(WARM, 0.10 + 0.25 * max(center[2], 0.0) / H)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.loft(kit.footprint_rings(plan, [BURY, H_BASE, 19.0, 20.0, 32.5, 33.5, H_CORN]),
           ["Wall", "Glass", "Wall", "Glass", "Wall", "Glass"])
    # projecting cornice and parapet (est. 0.6 m overhang)
    b.extrude(kit.offset_polygon(plan, 0.6), H_CORN, H_ROOF, "Wall", top="Roof")
    # vertical fins along the facade (est.)
    b.fins(plan, H_BASE, H_CORN, spacing=7.5, depth=0.5, width=0.6, material="Wall")
    # mechanical penthouse on the middle segment (est.)
    b.block((4.0, 0.0), 9.0, 18.0, H_ROOF - 0.5, H, "Wall", top="Roof")
    return b.finish("Tower_w134949098")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
