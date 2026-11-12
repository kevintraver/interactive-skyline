"""Low-poly model of a 26-story T-plan hotel tower with low casino podiums, Las Vegas (id w116867081).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 80.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), volume 0 = T-plan tower; volumes 1-3 = podiums at
    their mapped tops (18.7 / 15.8 / 25.6 m), offset 0,0
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, "Bally's South Tower.jpg" etc.): dark
    glass long faces, white end piers with thin blue horizontal stripes; band heights estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "horseshoe_las_vegas_ho_w116867081"
MAX_TRIS = 2_500

BURY = -2.0
H = 80.0         # project data
H_ROOF = 77.0    # est.: piers stand ~3 m above main roofline
H_BASE = 9.0     # est.

COLORS = {
    "Wall": "E4E4E0",
    "Glass": "56677A",
    "Pier": "ECECE8",
    "Stripe": "5E8FC8",
    "Podium": "D8D4CA",
    "Roof": "9A9892",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)
BLUE = (0.35, 0.55, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.12)
    if material == "Pier":
        return kit.scaled(WARM, 0.22)
    if material == "Stripe":
        return kit.scaled(BLUE, 0.8)
    if material == "Podium":
        return kit.scaled(WARM, 0.18)
    return (0.0, 0.0, 0.0)


def dedupe(pts, tol=1.2):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > tol:
            out.append(p)
    while len(out) > 3 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) <= tol:
        out.pop()
    return out


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = vols[0]["outline"]
    # tower: base, glass with two white spandrel bands (est.), parapet
    b.loft(kit.footprint_rings(plan, [BURY, H_BASE, 30.0, 31.2, 53.0, 54.2, 74.5, H_ROOF]),
           ["Wall", "Glass", "Wall", "Glass", "Wall", "Glass", "Wall"])
    # white end piers of the three wings, with blue stripes (photo), 0.6 m proud of the plan
    piers = [((-106.0, 53.5), 3.6, 13.6, -1.5), ((105.8, 47.5), 3.6, 14.4, -1.5), ((0.0, -49.0), 14.0, 4.0, -1.5)]
    for c, hx, hy, turn in piers:
        b.block(c, hx, hy, BURY, H, "Pier", turn_deg=turn, top="Roof")
        for z in (20.0, 35.0, 50.0, 65.0):
            b.block(c, hx + 0.3, hy + 0.3, z, z + 1.2, "Stripe", turn_deg=turn)
    # core penthouse at the wing junction (est.)
    b.block((1.0, 50.0), 10.0, 8.0, H_ROOF - 0.5, H - 0.5, "Wall", turn_deg=-1.5, top="Roof")
    # low podiums (casino / convention blocks), mapped tops
    for v in vols[1:]:
        o = kit.offset_polygon(kit.ccw_polygon(dedupe(v["outline"])), -0.4)
        b.extrude(o, BURY, float(v["top"]), "Podium", top="Roof")
    return b.finish("Tower_w116867081")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
