"""Low-poly model of a three-wing gold-glass resort tower (Las Vegas, id w27858550), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_mandalay_bay.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown band that carries them is plain.

Sources:
  - height 146.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (mapped Y-shaped plan, exact)
  - crown band depth, rib spacing/size, base band, colors, glow: estimated from Commons photos in refs/
    (cream crown band ~6.5% of height; cream vertical piers along the wing faces, lit gold at night)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "mandalay_bay"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 146.0          # project data
CROWN_Z0 = 136.5        # (est.) crown band is ~6.5% of height in the side photos
PARAPET = 1.5           # (est.)
BASE_Z1 = 6.0           # (est.) cream base band
RIB_SPACING = 13.0      # (est.) piers every ~4 room bays
RIB_HALF_W, RIB_HALF_D = 0.7, 1.0   # (est., made bold to read from afar)
LONG_EDGE = 40.0        # wing faces are the edges longer than this
TIP_EDGE_MAX = 12.0

COLORS = {
    "GoldGlass": "C9A046",
    "Rib": "DDC585",
    "CrownBand": "EADFBE",
    "EndWall": "DCCFA6",
    "BaseBand": "D9CDA8",
    "Roof": "8E8A80",
}
ROUGHNESS = {"GoldGlass": 0.25}
GOLD, WARM = (1.0, 0.72, 0.30), (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "GoldGlass":
        return kit.scaled(GOLD, 0.03)
    if material == "Rib":       # vertical gold light strips, the building's night signature
        return kit.scaled(GOLD, 0.9)
    if material == "CrownBand":  # washed from below
        return kit.scaled(WARM, 0.25 + 0.45 * (HEIGHT - z) / (HEIGHT - CROWN_Z0))
    if material == "EndWall":
        return kit.scaled(GOLD, 0.12)
    if material == "BaseBand":
        return kit.scaled(WARM, 0.35)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = [tuple(p) for p in fp["volumes"][0]["outline"]]
    n = len(outline)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(outline, outline[1:] + outline[:1]))
    sign = 1.0 if area > 0 else -1.0

    b.extrude(outline, BURY, CROWN_Z0, "GoldGlass")
    b.extrude(kit.scale_polygon(outline, 1.012, (0.0, 0.0)), BURY, BASE_Z1, "BaseBand")
    crown = kit.scale_polygon(outline, 1.015, (0.0, 0.0))
    b.extrude(crown, CROWN_Z0 - 0.5, HEIGHT, "CrownBand", top="Roof")
    b.extrude(kit.scale_polygon(outline, 0.97, (0.0, 0.0)), HEIGHT - PARAPET - 0.05, HEIGHT + 0.05, "Roof")

    for j in range(n):
        (x0, y0), (x1, y1) = outline[j], outline[(j + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        nx, ny = sign * uy, -sign * ux      # outward normal
        turn = math.degrees(math.atan2(uy, ux))
        if length > LONG_EDGE:              # piers along a wing face
            count = max(2, round(length / RIB_SPACING))
            for i in range(count):
                t = (i + 0.5) / count * length
                c = (x0 + ux * t + nx * 0.25, y0 + uy * t + ny * 0.25)
                b.block(c, RIB_HALF_W, RIB_HALF_D, BURY, CROWN_Z0 - 0.6, "Rib", turn_deg=turn)
        elif 6.0 < length <= TIP_EDGE_MAX and math.hypot((x0 + x1) / 2, (y0 + y1) / 2) > 80.0:
            # solid cream wall on the flat end of each wing
            c = ((x0 + x1) / 2 + nx * 0.1, (y0 + y1) / 2 + ny * 0.1)
            b.block(c, length * 0.38, 0.6, BASE_Z1 + 0.1, CROWN_Z0 - 0.6, "EndWall", turn_deg=turn)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"GoldGlass": 1.0})
    build_body(b)
    return b.finish("ResortTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
