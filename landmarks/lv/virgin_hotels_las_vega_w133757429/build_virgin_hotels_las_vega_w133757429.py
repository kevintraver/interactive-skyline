"""Low-poly model of a three-tower Las Vegas resort (id w133757429), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 55.9 m: project data (lidar), trusted (north glass slab)
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0: curved tower (top 37.5 m), north slab
    (55.9 m), and one large casino/podium outline mapped at 38.9 m. The podium is modeled low (9 m, est.);
    its straight east strip is the third hotel tower and keeps the mapped 38.9 m.
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): north and east towers are blue
    glass slabs with pale horizontal bands; the curved tower is cream with a window grid; podium cream.
    Band spacing, parapets, penthouses and podium height are estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "virgin_hotels_las_vega_w133757429"
MAX_TRIS = 2_500

BURY = -2.0
H = 55.9          # project data: north slab
H_CURVE = 37.5    # footprint volume top
H_EAST = 38.9     # footprint volume top
H_PODIUM = 9.0    # est.

COLORS = {
    "Glass": "4A7FB8",      # blue curtain wall
    "Band": "C9D3DA",       # pale spandrel bands
    "GridGlass": "B7AE9C",  # cream wall with punched windows, averaged
    "Wall": "E3D9C3",
    "Podium": "D9CDB4",
    "Roof": "BDB7A8",
}
ROUGHNESS = {"Glass": 0.25, "GridGlass": 0.45}
WINDOWS = {"Glass": 1.0, "GridGlass": 1.0}
WARM = (1.0, 0.82, 0.58)
COOL = (0.55, 0.7, 1.0)


def glow(material, point, center):
    if material in ("Glass", "GridGlass"):
        return kit.scaled(WARM, 0.03)
    if material == "Band":
        return kit.scaled(COOL, 0.35 if center[2] > 36.0 else 0.08)  # lit crown band
    if material == "Wall":
        return kit.scaled(WARM, 0.14)
    if material == "Podium":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def glass_slab(b, plan, roof, step=10.5):
    levels = [BURY, 5.0]
    mats = ["Wall"]
    z = 5.0
    while z + step < roof - 3.0:
        levels += [z + step - 1.0, z + step]
        mats += ["Glass", "Band"]
        z += step
    levels += [roof - 1.6, roof]
    mats += ["Glass", "Band"]
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    curve = [tuple(p) for p in vols[0]["outline"]]
    north = [tuple(p) for p in vols[1]["outline"]]
    big = [tuple(p) for p in vols[2]["outline"]]
    # podium: outer run of the mapped outline, closed along the curved tower's convex side
    podium = big[:53] + [curve[0]] + curve[:12:-1]
    east = [(88.28, 113.86), (102.32, 117.62), (125.68, 20.71), (111.6, 16.9)]  # straight strip of the outline

    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.extrude(podium, BURY, H_PODIUM, "Podium", top="Roof")

    # curved tower: cream window wall, plain base and parapet
    plan = kit.offset_polygon(curve, 0.3)
    b.loft(kit.footprint_rings(plan, [BURY, H_PODIUM + 1.0, H_CURVE - 2.2, H_CURVE - 1.0]),
           ["Wall", "GridGlass", "Wall"])
    b.block((35.0, 90.0), 4.0, 14.0, H_CURVE - 1.2, H_CURVE, "Wall", turn_deg=-7.5, top="Roof")  # est. penthouse

    # north glass slab (tallest) and east glass slab
    glass_slab(b, north, H - 1.5)
    b.block((-54.5, 140.5), 30.0, 6.0, H - 1.7, H, "Band", turn_deg=-4.7, top="Roof")  # est. mech. screen
    glass_slab(b, kit.offset_polygon(east, 0.3), H_EAST - 1.2)
    b.block((107.0, 67.0), 3.5, 22.0, H_EAST - 1.4, H_EAST, "Band", turn_deg=13.6, top="Roof")
    return b.finish("Tower_w133757429")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
