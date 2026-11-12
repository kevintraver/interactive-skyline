"""Low-poly model of the Regional Justice Center (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and signage are deliberately not modeled.

Sources:
  - height 90.3 m: project data (lidar)
  - plan: footprint.json (skyline_tool.py footprint): 4 volumes. Volume 0 = main tower slab, volume 2 =
    service core, volume 1 = east wing, volume 3 = surrounding low courts wing / lobby, mapped at 82 m
    but modeled low (22 m) per the photo.
  - facade (salmon stone, blue-green curtain wall with pale spandrel bands, pale grey core, flat
    overhanging roof canopy, low stone podium with glazed lobby): Wikimedia Commons search sheet,
    "Las Vegas Regional Justice Center.jpg" (refs/search.json/commons_sheet.jpg).
    Podium height, band count and canopy size are estimates.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "regional_justice_cente_w226508857"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 90.3        # project data (lidar)
PODIUM_TOP = 22.0    # low courts wing, about 1/4 of the height in the photo (est.)
LOBBY_TOP = 16.0     # glazed lobby band on the podium (est.)
TOWER_ROOF = 84.0    # top of curtain wall (est.)
CANOPY_Z = 87.5      # underside of roof canopy (est.)
WING_TOP = 81.8      # footprint.json volume 1
BAND = 1.0
N_BANDS = 16

COLORS = {
    "Stone": "D2A08C",    # salmon stone cladding
    "Glass": "6C97A0",    # blue-green curtain wall
    "Band": "D9DEDC",     # pale spandrels
    "Core": "C8CAC6",     # pale grey core
    "Lobby": "56707A",    # podium glazing
    "Roof": "8C8A86",
    "Canopy": "DADCDA",
}
ROUGHNESS = {"Glass": 0.3, "Lobby": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Lobby":
        return kit.scaled(WARM, 0.35)
    if material in ("Stone", "Core"):
        return kit.scaled(WARM, 0.05)
    if material == "Canopy":
        return kit.scaled(COOL, 0.3)
    return (0.0, 0.0, 0.0)


def clean(points, tol=0.6):
    out = []
    for p in points:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > tol:
            out.append(tuple(p))
    while len(out) > 3 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) <= tol:
        out.pop()
    return out


def banded(b, plan, z0, z1, n):
    levels, mats = [z0], []
    step = (z1 - z0) / n - BAND
    z = z0
    for _ in range(n):
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Band"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    slab, wing, core, low = (clean(v["outline"]) for v in vols)

    # low courts wing and lobby
    b.extrude(low, BURY, 4.0, "Stone")
    b.extrude(low, 4.0, LOBBY_TOP, "Lobby")
    b.extrude(low, LOBBY_TOP, PODIUM_TOP, "Stone", top="Roof")

    # main tower slab: stone base, banded curtain wall, stone parapet, canopy
    b.extrude(slab, BURY, PODIUM_TOP, "Stone")
    banded(b, slab, PODIUM_TOP, TOWER_ROOF, N_BANDS)
    b.extrude(kit.offset_polygon(slab, -2.0), TOWER_ROOF, CANOPY_Z, "Stone")
    b.extrude(kit.offset_polygon(slab, 2.5), CANOPY_Z, HEIGHT - 1.0, "Canopy", top="Roof")
    b.fins(slab, PODIUM_TOP, TOWER_ROOF, 16.0, 0.8, 1.2, "Stone")   # stone piers (est. spacing)

    # service core, full height, pale grey
    b.extrude(kit.offset_polygon(core, 0.4), BURY, HEIGHT, "Core", top="Roof")

    # east wing, salmon stone
    b.extrude(wing, BURY, WING_TOP, "Stone", top="Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
