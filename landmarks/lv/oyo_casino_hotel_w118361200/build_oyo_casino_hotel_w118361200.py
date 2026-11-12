"""Low-poly model of a Las Vegas casino hotel (id w118361200), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 53.8 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), 4 volumes with mapped tops, offset 0,0:
      north-south tower 53.7 m, east-west slab 39.5 m, mid wing + garage 29.9 m, casino 11.3 m
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, 2007-2010 exterior photos):
    white painted concrete, dark punched-window grid, blue-grey accents, stepped art-deco parapets
    at the slab ends. Band, parapet and crown-step heights are estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "oyo_casino_hotel_w118361200"
MAX_TRIS = 2_500

BURY = -2.0
H = 53.8             # project data
H_TOWER_ROOF = 50.6  # est.: stepped crown makes up the last ~3 m
H_SLAB = 39.5        # footprint volume top
H_SLAB_ROOF = 37.0   # est.
H_WING = 29.9        # footprint volume top
H_CASINO = 11.3      # footprint volume top

COLORS = {
    "Wall": "E6E4DE",
    "Glass": "AEB6C0",   # white concrete with dark punched windows, averaged
    "Accent": "7F93A8",  # blue-grey crown/base accents
    "Garage": "CFCBC2",
    "Casino": "BFB29C",
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
    if material == "Accent":   # flood-lit crown steps
        return kit.scaled((0.75, 0.85, 1.0), 0.35)
    if material == "Garage":
        return kit.scaled(WARM, 0.08)
    if material == "Casino":   # street-level light, plain
        return kit.scaled((1.0, 0.72, 0.36), 0.5)
    return (0.0, 0.0, 0.0)


def clean(pts, tol=0.3):
    out = []
    for p in pts:
        p = (p[0], p[1])
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > tol:
            out.append(p)
    if abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) <= tol:
        out.pop()
    return out


def tower(b, plan, roof, step=7.0):
    levels = [BURY, 6.0]
    z = 6.0
    while z + step < roof - 1.5:   # thin spandrel bands, est. every 3 floors
        levels += [z + step - 1.0, z + step]
        z += step
    levels += [roof - 1.5, roof, (roof, -0.5)]
    mats = ["Wall"] + ["Glass", "Wall"] * ((len(levels) - 3) // 2) + ["Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    slab = clean(vols[0]["outline"])
    tall = clean(vols[1]["outline"])
    casino = clean(vols[2]["outline"])
    wing = clean(vols[3]["outline"])
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.loft(kit.footprint_rings(casino, [BURY, H_CASINO - 1.5, H_CASINO, (H_CASINO, -0.5)]), ["Casino", "Accent", "Roof"])
    # mid wing and parking structure share one mapped volume; kept plain
    b.loft(kit.footprint_rings(wing, [BURY, 5.0, H_WING - 1.2, H_WING, (H_WING, -0.5)]), ["Casino", "Garage", "Wall", "Roof"])

    tower(b, slab, H_SLAB_ROOF)
    tower(b, tall, H_TOWER_ROOF)

    # stepped parapet crowns at the slab ends (est. from photos), plain
    def crown(cx, cy, sx, sy, z0, z1):
        mid = z0 + (z1 - z0) * 0.55
        b.block((cx, cy), sx / 2, sy / 2, z0 - 0.5, mid, "Wall", top="Roof")
        b.block((cx, cy), sx * 0.3, sy * 0.3, mid, z1, "Accent", top="Roof")

    crown(-30.0, -77.0, 15.0, 8.0, H_TOWER_ROOF, H)         # tower south end
    crown(-30.0, -24.0, 15.0, 8.0, H_TOWER_ROOF, H - 1.0)   # tower north end
    crown(31.0, -11.6, 8.0, 15.0, H_SLAB_ROOF, H_SLAB)      # slab east end
    crown(0.0, -11.6, 10.0, 14.0, H_SLAB_ROOF, H_SLAB - 0.8)
    return b.finish("Tower_w118361200")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
