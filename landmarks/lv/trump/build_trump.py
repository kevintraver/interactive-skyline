"""Low-poly model of a gold-glass hotel tower (Las Vegas, id w111380666), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_trump.py -- --out .

Meters; +X east, +Y north, +Z up; origin = footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown band is a plain white surface.

Sources:
  - height 190.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (tower volume + 36.1 m podium volume)
  - crown band = top ~6% of the tower (12 m): ratio read off refs/Trump_hotel_Las_Vegas_0475.jpg
  - floor-line spacing, podium band heights, colors, night light: estimated from the same photo
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "trump"
MAX_TRIS = 3_000

BURY = -2.4
HEIGHT = 190.0            # project data
CROWN_Z = 178.0           # photo ratio: white band is the top ~6%
PODIUM_TOP = 36.1         # footprint.json
N_FLOOR_BANDS = 14        # bold floor groups (real tower has ~60 floors) (est.)
LINE_H = 1.4              # bright spandrel line height, exaggerated to read from afar (est.)
POD_BASE, POD_FASCIA = 9.0, 27.0   # podium white base / white fascia start (est. from photo)

COLORS = {
    "GoldGlass": "C4952E",
    "GoldLine": "E6C766",
    "CrownBand": "F7F5EF",
    "PodiumWall": "F3F0E8",
    "PodiumGlass": "8A6420",
    "Roof": "8C8A84",
}
ROUGHNESS = {"GoldGlass": 0.25, "PodiumGlass": 0.3, "GoldLine": 0.4}
WARM, WHITE = (1.0, 0.78, 0.42), (1.0, 0.96, 0.88)


def glow(material, point, center):
    if material == "CrownBand":   # flood-lit crown, the brightest element
        return kit.scaled(WHITE, 0.85)
    if material == "GoldLine":
        return kit.scaled(WARM, 0.22)
    if material == "GoldGlass":   # dim warm, slightly brighter toward the up-lit base
        return kit.scaled(WARM, 0.06 + 0.10 * max(0.0, 1.0 - point[2] / 90.0))
    if material == "PodiumGlass":
        return kit.scaled(WARM, 0.35)
    if material == "PodiumWall":
        return kit.scaled(WHITE, 0.30)
    return (0.0, 0.0, 0.0)


def ccw(pts):
    pts = list(pts)
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))
    return pts if area > 0 else pts[::-1]


def ring(outline, z):
    return [(x, y, z) for x, y in outline]


# facade glass that gets the app's lit-window pattern at night (added by the orchestrator)
WINDOWS = {'GoldGlass': 1.0}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower = ccw(fp["volumes"][0]["outline"])
    podium = ccw(fp["volumes"][1]["outline"])

    # tower shaft: stepped plan, gold glass with bright floor lines, plain white crown band
    zs, mats = [BURY], []
    step = (CROWN_Z - PODIUM_TOP) / N_FLOOR_BANDS
    z = PODIUM_TOP + step - LINE_H
    for _ in range(N_FLOOR_BANDS):
        zs += [z, z + LINE_H]
        mats += ["GoldGlass", "GoldLine"]
        z += step
    zs[-1] = CROWN_Z
    zs.append(HEIGHT)
    mats.append("CrownBand")
    b.loft([ring(tower, h) for h in zs], mats)
    # recessed roof deck inside the parapet-like crown
    b.extrude(kit.scale_polygon(tower, 0.9), HEIGHT - 3.0, HEIGHT + 0.05, "Roof")

    # podium: white base, gold glass bays, white fascia
    b.loft([ring(podium, h) for h in (BURY, POD_BASE, POD_FASCIA, PODIUM_TOP)],
           ["PodiumWall", "PodiumGlass", "PodiumWall"])
    return b.finish("HotelTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
