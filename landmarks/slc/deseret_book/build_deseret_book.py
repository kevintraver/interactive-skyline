"""Low-poly model of Deseret Book (Salt Lake City). Run via run_blender.py. No signage modeled.

Sources: height 36.9 m (project lidar data); footprint from footprint.json (mapped plan, 20 x 44 m).
Photos Deseret_Book_HQ_1/4/6 (Commons): red-brown brick walls, 4-bay bronze reflective glass curtain wall
on a short face (assumed north, est.), brick podium ~5 m (est.), 8 floors, small window crown row, punched
ribbon windows on the long sides (est. layout).
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "deseret_book"
MAX_TRIS = 3000
BURY = -2.0
HEIGHT = 36.9
COLORS = {"Brick": "7A3B33", "Pier": "6B3A34", "Glass": "B08A78", "Roof": "6E6A66", "Win": "3A3F47"}
ROUGHNESS = {"Glass": 0.3, "Win": 0.35}
WINDOWS = {"Glass": 1.0, "Win": 1.0}


def glow(material, point, center):
    if material in ("Glass", "Win"):
        return kit.scaled((1.0, 0.82, 0.58), 0.03)
    if material == "Brick":
        return kit.scaled((1.0, 0.82, 0.58), 0.08 * math.exp(-max(point[2], 0.0) / 25.0) + 0.02)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    outline = fp["volumes"][0]["outline"]
    b.extrude(outline, BURY, HEIGHT - 0.8, "Brick", top="Roof")
    # glass curtain wall on north face: 4 bays, brick piers
    yN = 22.2
    b.block((0.0, yN + 0.1), 7.8, 0.25, 6.0, 31.0, "Glass")
    for i in range(5):
        x = -7.8 + i * 3.9
        b.block((x, yN + 0.3), 0.45, 0.4, 5.0, 33.0, "Pier")
    b.block((0.0, yN + 0.3), 9.0, 0.4, 31.0, 33.0, "Pier")  # spandrel band under the crown row
    # crown row of small windows on north face
    for i in range(9):
        b.block((-7.2 + i * 1.8, yN + 0.05), 0.5, 0.2, 33.8, 36.0, "Win")
    # ribbon windows on east/west long sides, floors 2-8
    for floor in range(7):
        z = 8.0 + floor * 3.9
        b.block((9.84, 0.0), 0.3, 18.0, z, z + 1.9, "Win")
        b.block((-9.78, 0.0), 0.3, 18.0, z, z + 1.9, "Win")
    # parapet
    b.extrude(kit.scale_polygon(outline, 0.97), HEIGHT - 0.8, HEIGHT, "Roof")
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
