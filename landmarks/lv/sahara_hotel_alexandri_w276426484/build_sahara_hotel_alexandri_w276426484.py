"""Low-poly model of a Las Vegas hotel slab tower (id w276426484), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signs are modeled.

Sources:
  - height 77.8 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), one volume, 22 x 54 m slab
  - facade (pale slab, gridded window walls on the long sides, solid end walls, parapet): Commons search
    sheet, files "Alexandria Tower at Sahara hotel.jpg" and "SLS Las Vegas 2018.jpg"; floor and band
    heights are estimates (est.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "sahara_hotel_alexandri_w276426484"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 77.8             # project data
BASE_TOP = 7.0            # (est.) plain base
FLOORS = 23               # (est.) from photo
PARAPET_Z0 = 73.0         # (est.) solid top band
ROOF = 75.6               # (est.) main parapet; mechanical penthouse reaches HEIGHT
SPANDREL = 0.9            # (est.)
END_DEPTH = 3.2           # (est.) solid end bays
BAY = 4.4                 # (est.) room bay

COLORS = {
    "Wall": "ECE8DF",
    "WindowWall": "6F7F8C",
    "Base": "D8D3C8",
    "Roof": "9A968C",
    "Penthouse": "DAD6CC",
}
ROUGHNESS = {"WindowWall": 0.35}
WINDOWS = {"WindowWall": 1.0}
WARM = (1.0, 0.85, 0.65)


def glow(material, point, center):
    z = point[2]
    if material == "WindowWall":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10 + (0.22 if z > PARAPET_Z0 - 0.5 else 0.0))
    if material == "Base":
        return kit.scaled(WARM, 0.22)
    if material == "Penthouse":
        return kit.scaled(WARM, 0.08)
    return (0.0, 0.0, 0.0)


def lerp2(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    nw, ne, se, sw = plan

    # main slab: base, then a window band and a spandrel per floor, then a solid parapet band
    floor_h = (PARAPET_Z0 - BASE_TOP) / FLOORS
    levels, mats = [BURY, BASE_TOP], ["Base"]
    for i in range(FLOORS):
        z = BASE_TOP + i * floor_h
        levels += [z + floor_h - SPANDREL, z + floor_h]
        mats += ["WindowWall", "Wall"]
    levels += [ROOF]
    mats += ["Wall"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # solid end walls (short north and south ends), standing slightly proud
    length = ((nw[0] - sw[0]) ** 2 + (nw[1] - sw[1]) ** 2) ** 0.5
    t = END_DEPTH / length
    north = [nw, ne, lerp2(ne, se, t), lerp2(nw, sw, t)]
    south = [sw, se, lerp2(se, ne, t), lerp2(sw, nw, t)]
    for cap in (north, south):
        b.extrude(kit.offset_polygon(cap, 0.45), BURY, ROOF + 0.6, "Wall", top="Roof")

    # piers between room bays on the long sides
    b.fins(plan, BASE_TOP, PARAPET_Z0, BAY, 0.35, 0.7, "Wall")

    # roof deck and mechanical penthouse
    b.extrude(kit.offset_polygon(plan, -0.6), ROOF - 0.8, ROOF - 0.3, "Roof")
    pent = [lerp2(lerp2(nw, sw, 0.3), lerp2(ne, se, 0.3), 0.2), lerp2(lerp2(nw, sw, 0.3), lerp2(ne, se, 0.3), 0.8),
            lerp2(lerp2(nw, sw, 0.7), lerp2(ne, se, 0.7), 0.8), lerp2(lerp2(nw, sw, 0.7), lerp2(ne, se, 0.7), 0.2)]
    b.extrude(pent, ROOF - 0.8, HEIGHT, "Penthouse", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
