"""Low-poly model of a multi-wing hotel complex beside the Las Vegas Strip (id w115773426), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 59.7 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0. The mapped outline is the whole complex; it is
    split here into rectangular slab wings read off the outline corners (within ~1 m, the plan is turned ~1.4 deg).
  - refs/View_from_the_High_Roller_Ferris_wheel_-_Las_Vegas_10.jpg: slab wings of similar height around a pool
    court, dark blue window wall with a vertical fin grid, white stair piers at slab ends rising ~1 floor above
    the roof, white parapet band, low white-roofed casino block toward the Strip (west).
  - wing heights other than the tallest, pier/parapet/base heights: estimated from that photo.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_linq_hotel_casino__w115773426"
MAX_TRIS = 2_500

BURY = -2.0
H = 59.7         # project data
PIER_UP = 3.2    # est.: piers stand about one floor above the roofline
H_BASE = 7.0     # est.
PARAPET = 3.0    # est. white parapet band

COLORS = {
    "Wall": "E9E7E1",
    "Glass": "2F4670",   # dark blue window wall
    "Fin": "5C8FD6",     # blue fin grid (photo: blue with red accents, averaged to blue)
    "Pier": "F0EEE8",
    "Roof": "B9B3A6",
    "Podium": "D9D4C8",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)
BLUE = (0.35, 0.55, 1.0)

# slab wings: (x0, x1, y0, y1, roof height, fin spacing)   heights est. except the tallest
WINGS = [
    (1.0, 90.5, -23.5, -5.0, H - PIER_UP, 5.5),      # east wing, E-W
    (70.5, 90.0, -58.0, -23.5, H - PIER_UP - 2.0, 5.5),  # south-east wing, N-S
    (-21.0, 1.0, -55.0, 24.0, H - PIER_UP, 5.5),     # central wing, N-S
    (-18.0, 27.0, 24.0, 45.0, 50.0, 5.5),            # north wing, E-W
    (-54.5, -21.0, -9.0, 24.5, 40.0, 5.5),           # west block
]
# white stair piers at slab ends: (cx, cy, half_x, half_y, top)
PIERS = [
    (88.5, -14.0, 3.2, 5.0, H),
    (80.0, -59.5, 5.0, 2.6, H - 2.0),
    (-10.5, -57.5, 5.0, 2.8, H),
    (29.5, 34.0, 3.0, 5.0, 53.0),
    (-9.5, 12.0, 4.5, 4.5, H),       # core penthouse at the wing junction (est.)
]
PODIUM = [(-81.0, -55.0, -18.0, 48.0, 15.0), (-78.0, -18.0, 25.0, 47.0, 12.0), (27.0, 32.5, 25.0, 43.0, 12.0)]


def rect(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Fin":
        return kit.scaled(BLUE, 0.22)
    if material == "Pier":
        return kit.scaled(WARM, 0.12 + 0.25 * max(center[2], 0.0) / H)
    if material in ("Wall", "Podium"):
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for x0, x1, y0, y1, top, spacing in WINGS:
        plan = rect(x0, x1, y0, y1)
        b.loft(kit.footprint_rings(plan, [BURY, H_BASE, top - PARAPET, (top - PARAPET, 0.5), (top, 0.5)]),
               ["Wall", "Glass", "Wall", "Wall"])
        if spacing:
            b.fins(plan, H_BASE, top - PARAPET, spacing, 0.7, 0.7, "Fin")
        # rooftop mechanical box (est.)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        b.block((cx, cy), min(6.0, (x1 - x0) / 4), min(6.0, (y1 - y0) / 4), top - 0.5, top + 2.2, "Wall", top="Roof")
    for cx, cy, hx, hy, top in PIERS:
        b.block((cx, cy), hx, hy, BURY, top, "Pier", top="Roof")
    for x0, x1, y0, y1, top in PODIUM:
        b.extrude(rect(x0, x1, y0, y1), BURY, top, "Podium", top="Roof")
    return b.finish("Hotel_w115773426")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
