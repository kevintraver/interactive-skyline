"""Low-poly model of a downtown Las Vegas hotel slab tower with a low casino wing (id w204346639).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 59.0 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), 2 volumes, offset 0,0:
      tower slab 44 x 22 m to 59.0 m, casino/garage wing to 13.8 m (mapped top)
  - facade: Commons search sheet (refs/search/commons_sheet.jpg; "Streamline Tower and El Cortez",
    "El Cortez - February 2020"): cream concrete slab, window grid on the long sides, blank end walls
    with a brick-red lower part and a raised stepped parapet; low wing white stucco with a red tile
    roof edge. Band, parapet and penthouse heights are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "el_cortez_hotel_casino_w204346639"
MAX_TRIS = 2_500

BURY = -2.0
H = 59.0          # project data
H_ROOF = 54.5     # est.: end parapets and penthouse make up the rest
H_WING = 13.8     # footprint volume top
H_BRICK = 21.0    # est. from photo: red lower part of the end wall, about a third

COLORS = {
    "Wall": "E6DCC4",
    "Glass": "B4B0A6",   # cream concrete with dark punched windows, averaged
    "EndWall": "EDE4CF",
    "Brick": "A8523F",
    "Stucco": "ECE8DE",
    "Tile": "A6462E",
    "Roof": "8E8C86",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "EndWall":  # flood-lit blank end walls (plain, no sign)
        return kit.scaled(WARM, 0.20 + 0.25 * max(center[2], 0.0) / H)
    if material == "Brick":
        return kit.scaled(WARM, 0.10)
    if material == "Stucco":   # street-level neon spill, plain
        return kit.scaled((1.0, 0.75, 0.50), 0.40)
    if material == "Tile":
        return kit.scaled((1.0, 0.45, 0.30), 0.30)
    return (0.0, 0.0, 0.0)


def end_quad(plan, i, out, depth, side):
    p, q = plan[i], plan[(i + 1) % len(plan)]
    cx = sum(v[0] for v in plan) / len(plan)
    cy = sum(v[1] for v in plan) / len(plan)
    ex, ey = q[0] - p[0], q[1] - p[1]
    length = math.hypot(ex, ey)
    ex, ey = ex / length, ey / length
    nx, ny = ey, -ex
    mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
    if nx * (mx - cx) + ny * (my - cy) < 0:
        nx, ny = -nx, -ny
    p2 = (p[0] - ex * side, p[1] - ey * side)
    q2 = (q[0] + ex * side, q[1] + ey * side)
    return [(p2[0] + nx * out, p2[1] + ny * out), (q2[0] + nx * out, q2[1] + ny * out),
            (q2[0] - nx * depth, q2[1] - ny * depth), (p2[0] - nx * depth, p2[1] - ny * depth)]


def end_wall(b, plan, i):
    """Blank end wall: brick-red lower part, cream above, stepped parapet (center raised)."""
    quad = end_quad(plan, i, 0.5, 1.6, 0.3)
    b.loft([[(x, y, z) for x, y in quad] for z in (BURY, H_BRICK, H_ROOF + 1.5)], ["Brick", "EndWall"])
    b.extrude(end_quad(plan, i, 0.5, 1.6, -5.5), H_ROOF + 1.5, H, "EndWall", top="Roof")


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    tower = vols[0]["outline"]
    wing = vols[1]["outline"][:-1]   # last point is a duplicate
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    # low casino wing / garage: stucco with a tile roof edge
    b.extrude(wing, BURY, H_WING - 1.6, "Stucco", top="Roof")
    b.extrude(kit.offset_polygon(wing, 0.4), H_WING - 1.6, H_WING, "Tile", top="Roof", bottom="Tile")

    # tower slab: window bands with thin spandrels (est. every 4 floors)
    levels = [BURY, 6.0]
    z = 6.0
    while z + 12.0 < H_ROOF - 1.5:
        levels += [z + 11.0, z + 12.0]
        z += 12.0
    levels += [H_ROOF - 1.5, H_ROOF]
    mats = ["Wall"] + ["Glass", "Wall"] * ((len(levels) - 2) // 2)
    b.loft(kit.footprint_rings(tower, levels), mats)
    for i in (1, 3):
        end_wall(b, tower, i)
    # mechanical penthouse (est.)
    cx = sum(p[0] for p in tower) / 4
    cy = sum(p[1] for p in tower) / 4
    b.block((cx, cy), 12.0, 7.0, H_ROOF - 0.5, H_ROOF + 3.5, "Wall", turn_deg=-28.9, top="Roof")
    return b.finish("Tower_w204346639")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
