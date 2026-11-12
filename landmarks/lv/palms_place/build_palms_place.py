"""Low-poly model of a 157 m residential slab tower (Las Vegas, id r7655652), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 157.0 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint), used as the podium outline
  - tower plan inside the podium, podium height, band spacing, fin zone, crown: (est.) read off
    refs/Palms_Place_Las_Vegas.jpg (single upward photo; no side elevation was available)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "palms_place"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 157.0            # project data
PODIUM_TOP = 14.0         # (est.) photo
ROOF = 150.0              # (est.) main roof; fins and penthouse rise to HEIGHT
FIN_BASE = 104.0          # (est.) white vertical fins cover roughly the top third in the photo
TOWER_SX, TOWER_SY = 0.62, 0.90   # (est.) tower slab inside the mapped plan
BAND_STEP = 4.5           # (est.) dense white balcony banding, simplified to one band per ~1.5 floors
FIN_SPACING = 7.0         # (est.)

COLORS = {
    "Glass": "1F3A5C",    # dark blue curtain wall
    "Band": "E4E6E8",     # white balcony slabs
    "Fin": "F0F0EC",      # white crown fins
    "Podium": "B8A878",   # tan / yellow-green podium cladding
    "Roof": "70767C",
}
ROUGHNESS = {"Glass": 0.3}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(COOL, 0.03)
    if material == "Band":
        return kit.scaled(COOL, 0.10)
    if material == "Fin":   # (est.) crown fins up-lit, brighter toward the top
        return kit.scaled(COOL, 0.25 + 0.45 * max(0.0, (z - FIN_BASE) / (HEIGHT - FIN_BASE)))
    if material == "Podium":
        return kit.scaled(WARM, 0.30)
    return (0.0, 0.0, 0.0)


def squash(pts, sx, sy):
    return [(x * sx, y * sy) for x, y in pts]


def along_outline(pts, spacing, out):
    """Points every `spacing` m along the outline, pushed `out` m outward."""
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))
    sign = 1.0 if area > 0 else -1.0
    res = []
    for a, b in zip(pts, pts[1:] + pts[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        n = max(1, round(length / spacing))
        nx, ny = sign * dy / length, -sign * dx / length
        for i in range(n):
            t = (i + 0.5) / n
            res.append((a[0] + dx * t + nx * out, a[1] + dy * t + ny * out))
    return res


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    tower = squash(plan, TOWER_SX, TOWER_SY)
    b.extrude(plan, BURY, PODIUM_TOP, "Podium", top="Roof")
    b.extrude(tower, PODIUM_TOP, ROOF, "Glass", top="Roof")
    band = squash(tower, 1.035, 1.015)
    z = PODIUM_TOP + BAND_STEP
    while z < ROOF - 2:
        b.extrude(band, z, z + 0.7, "Band")
        z += BAND_STEP
    b.extrude(band, ROOF - 0.8, ROOF + 0.4, "Band", top="Roof")
    for x, y in along_outline(tower, FIN_SPACING, 0.9):
        b.block((x, y), 0.45, 0.45, FIN_BASE, HEIGHT, "Fin")
    b.extrude(squash(tower, 0.7, 0.8), ROOF + 0.4, HEIGHT - 1.5, "Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
