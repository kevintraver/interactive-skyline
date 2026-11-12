"""Low-poly model of a slab hotel tower on a casino podium east of the Las Vegas Strip (id w135020970).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 51.7 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0: tower slab (volume 0) and a podium
    ring (volume 1, mapped top 15 m) split here into a south and a north part around the tower
  - facade: Commons search sheet (refs/commons_sheet.jpg, photos 0 and 2): cream concrete slab with a
    window grid, darker top-floor band, taller central bay with a dark cap, grey roofs, low podium.
    Podium reads about 1/5 of the tower in the aerial, so 11 m (est.) instead of the mapped 15 m.
    Band spacing, parapet and central-bay sizes are estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_westin_las_vegas_h_w135020970"
MAX_TRIS = 2_500

BURY = -2.0
H = 51.7          # project data
H_ROOF = 48.2     # est.: slab parapet; central bay reaches H
H_CROWN0 = 45.0   # est.: dark top-floor band starts
H_POD = 11.0      # est. from aerial photo
TURN = -2.2       # slab long axis bearing 92.2 (footprint facts)

COLORS = {
    "Wall": "E3D9C4",
    "Glass": "A9ADB0",    # cream concrete with dark punched windows, averaged
    "Crown": "7A5F4A",
    "Bay": "D2C3A6",
    "Podium": "CFC3AB",
    "Base": "A8977C",
    "Roof": "8C8A85",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Bay"):
        return kit.scaled(WARM, 0.12)
    if material == "Crown":
        return kit.scaled(WARM, 0.30)
    if material == "Podium":
        return kit.scaled(WARM, 0.10)
    if material == "Base":   # street-level entrance light, plain
        return kit.scaled((1.0, 0.72, 0.36), 0.45)
    return (0.0, 0.0, 0.0)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    slab = vols[0]["outline"]
    ring = vols[1]["outline"]
    south = list(ring[:24]) + [(-52.69, 6.0), (-46.7, 5.8), (-46.8, 2.5), (78.35, -2.25)]
    north = [(-52.69, 6.6), (-65.43, 6.7), (-64.52, 42.0), (19.03, 39.31), (18.35, 32.39),
             (45.01, 32.23), (45.07, 16.9), (-52.6, 20.7), (-53.0, 10.4), (-46.6, 9.77), (-46.7, 6.4)]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    for plan in (south, north):
        b.loft(kit.footprint_rings(plan, [BURY, 4.5, H_POD - 1.0, H_POD]), ["Base", "Podium", "Wall"])
        # (cap comes from the loft)

    levels = [BURY, H_POD + 1.0]
    z = H_POD + 1.0
    while z + 5.5 <= H_CROWN0 + 0.01:      # spandrel band every two floors, est.
        levels += [z + 4.7, z + 5.5]
        z += 5.5
    mats = ["Wall"] + ["Glass", "Wall"] * ((len(levels) - 2) // 2)
    levels += [H_ROOF - 0.9, H_ROOF]
    mats += ["Crown", "Wall"]
    b.loft(kit.footprint_rings(slab, levels), mats)

    # taller central bay standing proud of both long faces, dark cap (est. sizes)
    c = (15.5, 9.3)
    b.block(c, 10.0, 21.5, BURY, H - 3.0, "Bay", turn_deg=TURN, top="Roof")
    b.block(c, 10.6, 22.1, H - 3.0, H, "Crown", turn_deg=TURN, top="Roof")
    # rooftop plant (est.)
    b.block((-20.0, 11.5), 16.0, 7.0, H_ROOF - 0.5, H_ROOF + 2.2, "Wall", turn_deg=TURN, top="Roof")
    b.block((52.0, 8.0), 14.0, 7.0, H_ROOF - 0.5, H_ROOF + 2.2, "Wall", turn_deg=TURN, top="Roof")
    return b.finish("Tower_w135020970")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
