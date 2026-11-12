"""Low-poly model of a 17-storey L-plan hotel tower east of the Las Vegas Strip (id w313762432).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 53.2 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), one volume, offset 0,0
  - facade: no usable Commons photo (search sheet shows it only as a distant red-brown tower at dusk);
    terracotta painted concrete with floor-by-floor window bands is therefore an estimate, as are the
    base, parapet, crown band and penthouse heights.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "las_vegas_marriott_w313762432"
MAX_TRIS = 2_500

BURY = -2.0
H = 53.2          # project data
ROOF = 49.6       # est.: parapet top; penthouse makes up the rest
BASE = 6.0        # est.: lobby level
FLOOR = 3.0       # est.

COLORS = {
    "Wall": "A8674C",     # terracotta painted concrete (est.)
    "Glass": "5E5048",    # window band: dark glass with wall piers, averaged
    "Base": "C9B49A",
    "Crown": "D8C7AE",
    "Roof": "7E7A74",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.80, 0.56)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "Base":
        return kit.scaled(WARM, 0.45)
    if material == "Crown":   # up-lit plain crown band
        return kit.scaled(WARM, 0.40)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels = [BURY, BASE]
    mats = ["Base"]
    z = BASE
    while z + FLOOR <= ROOF - 3.0:
        levels += [z + 1.1, z + FLOOR]      # spandrel, then window band
        mats += ["Wall", "Glass"]
        z += FLOOR
    levels += [ROOF - 1.6, ROOF]
    mats += ["Wall", "Crown"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # low canopy block on the south side of the wing (est., plain)
    b.block((-24.0, -8.5), 11.0, 4.5, BURY, 5.0, "Base", top="Roof")
    # mechanical penthouses (est.)
    b.block((14.0, -3.0), 8.0, 6.0, ROOF - 0.5, H, "Wall", top="Roof")
    b.block((-22.0, 4.5), 7.0, 3.5, ROOF - 0.5, ROOF + 2.4, "Wall", top="Roof")
    return b.finish("Tower_w313762432")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
