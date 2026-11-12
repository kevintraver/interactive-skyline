"""Low-poly model of a two-tower downtown Las Vegas hotel (id w206291994), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 66.2 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), 4 volumes with their mapped tops, offset 0,0:
      north slab 58.5 m, south L-shaped slab 66.1 m, casino block 6.5 m, garage/podium 21.9 m
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, "North Tower" / "South Tower" 2022
    photos): white painted concrete slabs, window grid on the long sides, blank end walls; at night the
    end walls are flood-lit warm. Band, parapet and penthouse heights are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "four_queens_w206291994"
MAX_TRIS = 2_500

BURY = -2.0
H = 66.2            # project data
H_SOUTH_ROOF = 63.0  # est.: penthouse makes up the last ~3 m
H_NORTH = 58.5      # footprint volume top
H_GARAGE = 21.9     # footprint volume top
H_CASINO = 6.5      # footprint volume top

COLORS = {
    "Wall": "E4E1DA",
    "Glass": "B9BDC2",   # white concrete with dark punched windows, averaged
    "EndWall": "ECE9E3",
    "Garage": "C9C4BA",
    "Casino": "B8A98F",
    "Roof": "8E8C86",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.12)
    if material == "EndWall":  # flood-lit blank end walls
        return kit.scaled(WARM, 0.22 + 0.25 * max(center[2], 0.0) / H)
    if material == "Garage":
        return kit.scaled(WARM, 0.10)
    if material == "Casino":   # street-level canopy light, plain
        return kit.scaled((1.0, 0.72, 0.36), 0.55)
    return (0.0, 0.0, 0.0)


def end_slab(b, plan, i, z1, out=0.5, depth=1.6, side=0.3):
    """Blank end wall on edge i -> i+1 of plan, standing slightly proud of the slab."""
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
    quad = [(p2[0] + nx * out, p2[1] + ny * out), (q2[0] + nx * out, q2[1] + ny * out),
            (q2[0] - nx * depth, q2[1] - ny * depth), (p2[0] - nx * depth, p2[1] - ny * depth)]
    b.extrude(quad, BURY, z1, "EndWall", top="Roof")


def tower(b, plan, roof, ends):
    levels = [BURY, 7.5]
    z = 7.5
    while z + 14.0 < roof - 2.0:   # thin spandrel bands, est. every 4 floors
        levels += [z + 12.8, z + 14.0]
        z += 14.0
    levels += [roof - 2.0, roof]
    mats = ["Wall"] + ["Glass", "Wall"] * ((len(levels) - 2) // 2)
    b.loft(kit.footprint_rings(plan, levels), mats)
    for i in ends:
        end_slab(b, plan, i, roof + 0.8)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    north = vols[0]["outline"]
    south = vols[1]["outline"]
    casino = vols[2]["outline"][:5]   # last point duplicates the fifth
    # garage/podium outline with the mapped rounded-corner duplicates removed
    garage = [(-46.1, 13.32), (-32.15, 39.17), (8.43, 17.48), (15.54, 30.42), (17.26, 33.6),
              (57.78, 11.98), (37.11, -26.32), (-1.27, -5.82), (-3.39, -9.52)]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(casino, BURY, H_CASINO, "Casino", top="Roof")
    b.loft(kit.footprint_rings(garage, [BURY, 5.0, H_GARAGE - 1.2, H_GARAGE]), ["Casino", "Garage", "Wall"])

    tower(b, north, H_NORTH - 0.8, ends=[1, 4])     # east end B-C, west end D-A
    tower(b, south, H_SOUTH_ROOF, ends=[3, 6])      # east end, south-west end
    # mechanical penthouses (est.)
    b.block((-7.5, 36.5), 6.0, 4.0, H_NORTH - 1.5, H_NORTH, "Wall", turn_deg=-28.1, top="Roof")
    b.block((17.0, -25.5), 9.0, 5.0, H_SOUTH_ROOF - 0.5, H, "Wall", turn_deg=-28.1, top="Roof")
    return b.finish("Tower_w206291994")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
