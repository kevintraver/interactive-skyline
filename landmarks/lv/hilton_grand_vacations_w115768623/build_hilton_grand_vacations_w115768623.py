"""Low-poly model of a timeshare slab tower beside a Las Vegas Strip resort (id w115768623), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 53.8 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), long N-S slab with two east bays, offset 0,0
  - facade: Wikimedia Commons search sheet (aerial from the High Roller and a street view, not
    downloaded): white stucco wings with punched windows, maroon central section and bays that
    rise above the wings into a stepped crown. Wing roof height, band and crown heights estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hilton_grand_vacations_w115768623"
MAX_TRIS = 2_500

BURY = -2.0
H = 53.8          # project data
H_WING = 47.5     # est. wing parapet (centre rises ~2 floors above it in the aerial)
H_MID = 51.0      # est. central section roof
H_BASE = 5.0      # est. plain base
COLORS = {
    "Wall": "ECE9E1",
    "Glass": "CDCFCF",   # white stucco with punched windows, averaged
    "Maroon": "7B3036",
    "MaroonGlass": "6A3238",
    "Roof": "A09D96",
}
ROUGHNESS = {"Glass": 0.45, "MaroonGlass": 0.45}
WINDOWS = {"Glass": 1.0, "MaroonGlass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    if material in ("Glass", "MaroonGlass"):
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "Maroon":  # crown lit from below
        return kit.scaled((1.0, 0.55, 0.45), 0.25 if center[2] > H_WING else 0.06)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    # white wings on the mapped plan
    b.loft(kit.footprint_rings(plan, [BURY, H_BASE, 24.0, 25.0, 45.5, H_WING]),
           ["Wall", "Glass", "Wall", "Glass", "Wall"])
    # maroon central section, 0.3 m proud of the west face and rising above the wings (est.)
    b.block((-0.25, 0.0), 5.8, 19.45, BURY, H_BASE, "Maroon")
    b.block((-0.25, 0.0), 5.8, 19.45, H_BASE, H_WING, "MaroonGlass")
    b.block((-0.25, 0.0), 5.8, 19.45, H_WING, H_MID, "Maroon", top="Roof")
    # two east bays as maroon pylons up to full height, stepped caps
    for cy, sy in ((-10.87, 4.75), (11.05, 4.9)):
        b.block((6.4, cy), 2.8, sy, BURY, H_MID, "Maroon")
        b.block((6.4, cy), 2.2, sy - 1.0, H_MID, H - 1.2, "Maroon")
        b.block((6.4, cy), 1.5, sy - 2.2, H - 1.2, H, "Maroon", top="Roof")
    # white stair pylons at the wing ends (est.)
    for cy in (-60.5, 61.0):
        b.block((-0.3, cy), 4.0, 1.6, H_WING - 0.5, H_WING + 2.5, "Wall", top="Roof")
    return b.finish("Tower_w115768623")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
