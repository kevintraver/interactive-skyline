"""Low-poly airport traffic control tower (Las Vegas), built procedurally with landmark_kit.

Sources:
  - height 109.0 m: project data (osm-height), trusted.
  - plan: skyline_tool footprint, a near-circle of radius ~7.9 m (taken as the widest upper levels).
  - profile (waisted off-white shaft swelling to the upper levels, necked glass cab, roof, mast): read off a
    Commons search thumbnail ("LAS ATC & Viewing Tower"); all section heights and radii are estimates (est.).
No logos or signage modeled.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "faa_airport_traffic_co_w340018195"
MAX_TRIS = 2_500
BURY = -2.0
HEIGHT = 109.0          # project data
R_MAX = 7.9             # footprint radius
SEG = 20

COLORS = {
    "Shaft": "E4E0D6",
    "Trim": "B9B6AE",
    "Glass": "2A3A48",
    "CabGlass": "1C2B33",
    "Roof": "8C9094",
    "Mast": "C8C8C8",
    "Beacon": "D04030",
}
ROUGHNESS = {"Glass": 0.3, "CabGlass": 0.25}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Shaft":
        return kit.scaled(COOL, 0.06 + 0.25 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "CabGlass":
        return kit.scaled(COOL, 0.10)
    if material == "Trim":
        return kit.scaled(COOL, 0.08)
    if material == "Beacon":
        return (1.0, 0.15, 0.1)
    return (0.0, 0.0, 0.0)


# (radius, height, band above) -- all est. from the photo, scaled to HEIGHT and R_MAX
PROFILE = [
    (6.6, BURY, "Shaft"),
    (6.2, 8.0, "Shaft"),
    (5.2, 30.0, "Shaft"),       # waist
    (5.4, 55.0, "Shaft"),
    (6.6, 72.0, "Shaft"),       # swelling toward the upper levels
    (7.6, 80.0, "Trim"),
    (7.7, 81.0, "Glass"),       # upper office levels: three window bands
    (7.8, 84.0, "Trim"),
    (7.85, 85.0, "Glass"),
    (R_MAX, 88.0, "Trim"),
    (R_MAX, 89.0, "Glass"),
    (7.7, 92.0, "Shaft"),
    (6.0, 95.5, "Shaft"),       # neck under the cab
    (5.6, 97.0, "Trim"),
    (6.6, 97.8, "Trim"),        # catwalk
    (6.6, 98.6, "Trim"),
    (5.8, 98.6, "CabGlass"),    # cab glass leans outward
    (6.8, 102.6, "Roof"),
    (7.1, 103.4, "Roof"),
    (5.0, 104.6, "Roof"),
]


def build_body(b):
    b.revolve(PROFILE, SEG)
    b.prism(1.6, 104.6, 105.8, 8, "Roof")                 # roof equipment drum
    b.prism(0.22, 105.8, HEIGHT - 0.5, 6, "Mast")         # mast
    b.prism(0.4, HEIGHT - 0.5, HEIGHT, 6, "Beacon")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("ControlTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
