"""Low-poly model of a downtown Las Vegas hotel slab with garage and podium (id w206128520), landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 52.3 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), 4 volumes with their mapped tops, offset 0,0:
      hotel slab 52.3 m, long east block (garage / mid-rise) 30.6 m, casino podium 13.9 m, low link 3.2 m
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): cream-white slab with continuous
    dark ribbon windows on the long sides, blank end walls, banded concrete garage beside it.
    Floor band spacing, parapet and penthouse sizes are estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "downtown_grand_w206128520"
MAX_TRIS = 2_500

BURY = -2.0
H = 52.3          # project data
H_ROOF = 49.3     # est.: penthouse is the last 3 m
H_EAST = 30.6     # footprint volume top
H_POD = 13.9      # footprint volume top
H_LINK = 3.2      # footprint volume top

COLORS = {
    "Wall": "E6E1D4",
    "Glass": "5E6F80",
    "EndWall": "EDE8DC",
    "Garage": "CFC8B8",
    "Deck": "4A4640",
    "Podium": "B9AE9A",
    "Roof": "8E8C86",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "EndWall":   # flood-lit blank end walls
        return kit.scaled(WARM, 0.20 + 0.25 * max(center[2], 0.0) / H)
    if material == "Garage":
        return kit.scaled(WARM, 0.08)
    if material == "Deck":      # lit parking decks
        return kit.scaled((1.0, 0.9, 0.7), 0.25)
    if material == "Podium":    # street-level canopy light, plain
        return kit.scaled((1.0, 0.72, 0.36), 0.45)
    return (0.0, 0.0, 0.0)


def end_slab(b, plan, i, z1, out=0.5, depth=1.6, side=0.3):
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


def banded(b, plan, z0, roof, step, glass, a, bmat, base="Wall"):
    """Ribbon bands: `glass` m of material a, rest of each `step` in material bmat."""
    levels = [BURY, z0]
    mats = [base]
    z = z0
    while z + step <= roof - 1.5:
        levels += [z + glass, z + step]
        mats += [a, bmat]
        z += step
    levels.append(roof)
    mats.append(bmat)
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    east = vols[0]["outline"]
    slab = vols[1]["outline"]
    podium = vols[2]["outline"]
    link = vols[3]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(link, BURY, H_LINK, "Podium", top="Roof")
    b.loft(kit.footprint_rings(podium, [BURY, 5.0, H_POD - 1.2, H_POD]), ["Podium", "Garage", "Wall"])
    # long east block: banded concrete with dark open decks (est. 3.2 m floors)
    banded(b, east, 4.5, H_EAST, 3.2, 1.5, "Deck", "Garage", base="Podium")
    # hotel slab: ribbon windows, est. 3.0 m floors drawn as 2-floor bands
    banded(b, slab, 6.0, H_ROOF, 3.0, 1.7, "Glass", "Wall")
    end_slab(b, slab, 5, H_ROOF + 0.8)   # south end
    end_slab(b, slab, 2, H_ROOF + 0.8)   # north end
    # mechanical penthouse (est.)
    b.block((-12.5, 50.0), 22.0, 8.0, H_ROOF - 0.5, H, "Wall", turn_deg=62.0, top="Roof")
    return b.finish("Tower_w206128520")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
