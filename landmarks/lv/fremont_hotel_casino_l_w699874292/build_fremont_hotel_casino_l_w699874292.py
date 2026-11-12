"""Low-poly model of a downtown Las Vegas hotel slab with casino podium (id w699874292), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 50.3 m: project data, trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0: hotel slab 50.3 m, podium/garage 16.2 m,
    mid block 22.0 m, low casino block 9.6 m (mapped tops)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, photo 4 "viewed from the ..."):
    tan concrete slab, gridded windows on long sides, blank end walls; red-lit casino frontage at street level.
    Band, parapet and penthouse heights are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "fremont_hotel_casino_l_w699874292"
MAX_TRIS = 2_500

BURY = -2.0
H = 50.3            # project data
H_ROOF = 47.5       # est.: penthouse makes up the last ~3 m
H_PODIUM = 16.2     # footprint volume top
H_MID = 22.0        # footprint volume top
H_CASINO = 9.6      # footprint volume top

COLORS = {
    "Wall": "D8C7AC",
    "Glass": "A8907A",   # tan concrete grid with brown window panels, averaged
    "EndWall": "DDCFB8",
    "Garage": "C9BEAA",
    "Casino": "9A4A3C",  # red frontage, plain
    "Roof": "8E8A82",
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
        return kit.scaled((1.0, 0.25, 0.15), 0.6)
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
    casino = vols[0]["outline"]
    mid = vols[1]["outline"]
    slab = vols[2]["outline"]
    # podium outline with the mapped rounded-corner duplicates removed
    podium = [(27.1, 56.23), (18.84, 40.37), (32.3, 32.58), (35.79, 38.88), (37.84, 37.79), (43.03, 47.41),
              (69.75, 33.64), (48.85, -6.06), (25.15, 6.22), (11.97, -18.56), (35.76, -31.12), (14.92, -75.17),
              (-50.54, -39.47), (-12.39, 32.73), (-30.01, 42.19), (-10.8, 76.9)]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(casino, BURY, H_CASINO, "Casino", top="Roof")
    b.loft(kit.footprint_rings(podium, [BURY, 6.0, H_PODIUM - 1.2, H_PODIUM]), ["Casino", "Garage", "Wall"])
    b.loft(kit.footprint_rings(kit.scale_polygon(mid, 0.97), [H_PODIUM - 0.5, H_MID - 1.0, H_MID]), ["Garage", "Wall"])

    tower(b, slab, H_ROOF, ends=[0, 2])   # north and south blank end walls
    b.block((-40.4, 1.3), 20.0, 8.0, H_ROOF - 0.5, H, "Wall", turn_deg=62.2, top="Roof")  # penthouse, est.
    return b.finish("Tower_w699874292")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
