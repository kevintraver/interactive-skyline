"""Low-poly model of a curved red-glass hotel tower on a podium (Las Vegas), built with landmark_kit.

Logos, wordmarks, brand signage and the facade media screen content are deliberately not modeled:
those areas are plain panels.

Sources:
  - height 205.4 m: interactive-skyline project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (OSM), tower volume + podium volume, offset 0,0
  - podium top 35 m: footprint.json volume top
  - floor banding, crown band depth (9 m), end-wall fins, end panel size: estimated from
    refs/Resorts_World_Las_Vegas_March_2020.jpg and refs/Conrad_at_Resorts_World_Las_Vegas_2021.jpg
  - night colors: estimated (red facade lighting), no night photo downloaded (Commons rate limit)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "resorts_world"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 205.4          # project data
PODIUM_TOP = 35.0       # footprint.json
CROWN_Z = 196.0         # (est.) base of the lighter crown band
BODY_TOP = 201.5        # (est.) roof inside the parapet / fins
N_BANDS = 9             # (est.) bold floor groups; the real tower has ~57 floors
BAND_H = 2.2            # (est.) exaggerated spandrel stripe

COLORS = {
    "TowerGlass": "4A2228",   # dark crimson glass
    "FloorBand": "8E2B33",    # lighter red spandrel stripe
    "CrownBand": "A8343A",
    "EndWall": "B8232C",      # solid red end fins
    "EndPanel": "20242C",     # plain dark panel on the end walls
    "Podium": "6E6A68",
    "PodiumRoof": "9A9692",
    "Roof": "4A4648",
}
ROUGHNESS = {"TowerGlass": 0.3, "EndPanel": 0.3}
RED, WARM, COOL = (1.0, 0.12, 0.10), (1.0, 0.80, 0.55), (0.55, 0.70, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "TowerGlass":
        return kit.scaled(RED, 0.10)
    if material == "FloorBand":
        return kit.scaled(RED, 0.45)
    if material == "CrownBand":
        return kit.scaled(RED, 1.1)
    if material == "EndWall":
        return kit.scaled(RED, 0.25 + 0.35 * math.exp(-max(z - PODIUM_TOP, 0.0) / 60.0))
    if material == "EndPanel":
        return kit.scaled(COOL, 0.55)
    if material == "Podium":
        return kit.scaled(WARM, 0.08 + 0.35 * math.exp(-max(z, 0.0) / 12.0))
    return (0.0, 0.0, 0.0)


def _unit(dx, dy):
    d = math.hypot(dx, dy)
    return dx / d, dy / d


def end_fin(b, a, c, inward_pt):
    """Solid end wall on the tower end edge a-c, plus a plain dark panel on its outer face."""
    mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
    ex, ey = _unit(c[0] - a[0], c[1] - a[1])            # along the end edge
    ix, iy = _unit(inward_pt[0] - mid[0], inward_pt[1] - mid[1])
    half = math.hypot(c[0] - a[0], c[1] - a[1]) / 2 + 1.2

    def quad(h, d0, d1):  # h: half width along edge; d0..d1: depth along inward axis
        return [(mid[0] + ex * s * h + ix * d, mid[1] + ey * s * h + iy * d)
                for s, d in ((-1, d0), (1, d0), (1, d1), (-1, d1))]

    b.extrude(quad(half, -1.5, 5.0), BURY, HEIGHT, "EndWall", top="Roof")
    b.extrude(quad(half * 0.30, -2.1, -1.0), 40.0, 198.0, "EndPanel")


def build_tower(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower, podium = fp["volumes"][0]["outline"], fp["volumes"][1]["outline"]

    # podium: drop near-duplicate points of the mapped outline
    pod = [podium[0]]
    for p in podium[1:]:
        if math.hypot(p[0] - pod[-1][0], p[1] - pod[-1][1]) > 1.0:
            pod.append(p)
    b.extrude(pod, BURY, PODIUM_TOP, "Podium", top="PodiumRoof")

    # shaft: glass floor groups separated by lighter stripes, same exact plan
    step = (CROWN_Z - PODIUM_TOP) / N_BANDS
    z = BURY
    for i in range(N_BANDS):
        z1 = PODIUM_TOP + (i + 1) * step - BAND_H
        b.extrude(tower, z, z1, "TowerGlass")
        z2 = z1 + BAND_H
        if i < N_BANDS - 1:
            b.extrude(tower, z1, z2, "FloorBand")
        else:
            z2 = z1
        z = z2
    b.extrude(tower, z, BODY_TOP, "CrownBand", top="Roof")
    # roof plant, set back
    b.extrude(kit.scale_polygon(tower, 0.82), BODY_TOP, HEIGHT - 1.0, "Roof")

    # ends: east end edge is outline[0]-[1]; west end edge is outline[10]-[11]
    end_fin(b, tower[0], tower[1], ((tower[2][0] + tower[18][0]) / 2, (tower[2][1] + tower[18][1]) / 2))
    end_fin(b, tower[10], tower[11], ((tower[9][0] + tower[12][0]) / 2, (tower[9][1] + tower[12][1]) / 2))


PARTS = {"tower": build_tower}


# facade glass that gets the app's lit-window pattern at night (added by the orchestrator)
WINDOWS = {'TowerGlass': 1.0}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("HotelTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
