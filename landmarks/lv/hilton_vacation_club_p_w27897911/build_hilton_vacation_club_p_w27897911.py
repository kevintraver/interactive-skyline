"""Low-poly model of a Las Vegas timeshare tower pair (id w27897911), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signs are modeled.

Sources:
  - height 67.0 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), one H-shaped volume
  - facade (cream painted concrete, horizontal window/balcony bands, raised parapet, violet outline
    light at night): Commons search sheet refs/commons_sheet.jpg (files 0, 2, 5, 7); band heights (est.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hilton_vacation_club_p_w27897911"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 67.0             # project data (lidar)
BASE_TOP = 7.0            # (est.) plain two-storey base
BODY_TOP = 60.0           # (est.) top of the room floors
PARAPET = 63.0            # (est.) main roof parapet; penthouse block rises to HEIGHT
N_BANDS = 8               # (est.) grouped floor bands

COLORS = {
    "Wall": "EADDBB",
    "WindowWall": "CDBE9C",
    "Base": "CDBB96",
    "Trim": "F0E6CC",
    "Neon": "8A5CF0",
    "Roof": "9A968C",
}
ROUGHNESS = {"WindowWall": 0.4}
WINDOWS = {"WindowWall": 1.0}
WARM = (1.0, 0.82, 0.58)
VIOLET = (0.55, 0.35, 1.0)


def glow(material, point, center):
    if material == "WindowWall":
        return kit.scaled(WARM, 0.03)
    if material == "Neon":
        return kit.scaled(VIOLET, 1.6)
    if material in ("Wall", "Trim"):
        return kit.scaled(VIOLET, 0.10)
    if material == "Base":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]

    zs, mats = [BURY, BASE_TOP], ["Base"]
    step = (BODY_TOP - BASE_TOP) / N_BANDS
    for i in range(N_BANDS):
        z0 = BASE_TOP + i * step
        zs += [z0 + 2.6, z0 + step]
        mats += ["Wall", "WindowWall"]
    zs += [PARAPET - 0.5, PARAPET, (PARAPET, -0.6)]
    mats += ["Trim", "Neon", "Trim"]
    b.loft(kit.footprint_rings(plan, zs), mats)
    b.extrude(kit.offset_polygon(plan, -0.6), PARAPET - 1.5, PARAPET - 0.8, "Roof")

    # cream piers between window bays
    b.fins(plan, BASE_TOP, BODY_TOP, 9.0, 0.5, 1.6, "Wall")

    # raised parapet / mechanical blocks (est. from photos 0 and 5): one on each wing, one on the link
    def rect(cx, cy, hx, hy):
        return [(cx - hx, cy - hy), (cx + hx, cy - hy), (cx + hx, cy + hy), (cx - hx, cy + hy)]

    for cx in (-33.5, 33.5):
        b.extrude(rect(cx, 0.0, 7.0, 11.0), PARAPET - 1.5, HEIGHT - 0.4, "Trim")
        b.extrude(rect(cx, 0.0, 7.2, 11.2), HEIGHT - 0.4, HEIGHT, "Neon", top="Roof")
    b.extrude(rect(0.0, 0.0, 10.0, 7.0), PARAPET - 1.5, 65.5, "Roof")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
