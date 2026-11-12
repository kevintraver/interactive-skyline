"""Low-poly model of a 66 m condo-hotel slab with a parking wing (Las Vegas, id w135298867), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled (sign areas left plain).

Sources:
  - height 66.1 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0; volume 0 = tower, volume 1 = garage wing (29 m)
  - proportions and colors (white/cream slab with window bands and piers, lower end wings, taller central
    blue-glass bay with a small raised crown, plain low wing): read off Wikimedia Commons search thumbnails
    ("Platinum Hotel & Spa.jpg", "The Platinum Hotel, Paradise, NV"); all section heights est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "platinum_hotel_and_spa_w135298867"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 66.1       # project data
BASE_TOP = 6.0      # lobby band (est.)
WING_TOP = 57.0     # main roof of the slab (est. from photo, ~0.86 H)
MID_TOP = 63.0      # raised central bay (est.)
GARAGE_TOP = 29.0   # project data (volume 1)
BAND = 1.7          # white slab band (est.)
N_BANDS = 8

COLORS = {
    "Frame": "E6E1D6",    # cream-white painted concrete
    "Glass": "39424C",    # dark window bands
    "BlueGlass": "3E6E9E",  # central glazed bay
    "Garage": "CFC8BA",
    "Slot": "5A5650",     # open garage decks
    "Roof": "8C8C8A",
    "Crown": "DADDE0",
}
ROUGHNESS = {"Glass": 0.3, "BlueGlass": 0.25}
WINDOWS = {"Glass": 1.0, "BlueGlass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material in ("Glass", "BlueGlass"):
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(WARM, 0.22 if z < BASE_TOP + 0.5 else 0.07)
    if material == "Crown":
        return kit.scaled(COOL, 0.5)
    if material == "Slot":
        return kit.scaled(WARM, 0.12)
    if material == "Garage":
        return kit.scaled(WARM, 0.04)
    return (0.0, 0.0, 0.0)


def build_tower(b, plan):
    levels, mats = [BURY, BASE_TOP], ["Frame"]
    step = (WING_TOP - BASE_TOP) / (N_BANDS + 1) - BAND
    z = BASE_TOP
    for _ in range(N_BANDS + 1):
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)
    b.fins(plan, BASE_TOP, WING_TOP, 5.2, 0.5, 2.6, "Frame")  # wide piers: photos read mostly white
    # central blue-glass bay on the east front, standing 0.9 m proud and rising above the wings
    cx, cy, hx, hy = 13.0, -3.5, 13.0, 13.0
    b.block((cx, cy), hx, hy, WING_TOP, MID_TOP - BAND, "BlueGlass")
    b.block((cx, cy), hx + 0.3, hy + 0.3, MID_TOP - BAND, MID_TOP, "Frame", top="Roof")
    b.block((25.6, cy), 0.6, 9.0, BASE_TOP, WING_TOP, "BlueGlass")
    # roof crown / mechanical screen
    b.block((cx, cy), 7.0, 8.0, MID_TOP, HEIGHT, "Crown", top="Roof")


def build_garage(b, plan):
    levels, mats = [BURY, 4.0], ["Garage"]
    n = 5
    step = (GARAGE_TOP - 4.0) / n
    for i in range(n):
        z = 4.0 + i * step
        levels += [z + step * 0.4, z + step]
        mats += ["Slot", "Garage"]
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_tower(b, vols[0]["outline"])
    build_garage(b, vols[1]["outline"])
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
