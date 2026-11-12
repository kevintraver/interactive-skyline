"""Low-poly model of a downtown Las Vegas hotel-casino block (id w206151446), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 67.8 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0. Volume 0 (67.8 m) = south-west hotel slabs,
    volumes 1-2 (55.4 / 54.5 m, project data) = east tower wings, volume 3 = whole-block casino podium that the
    map draws at full height: modeled low (12 m est.) on its cleaned outer outline.
  - facade: no usable Commons photo found; cream painted concrete with gold-tinted window bands (est.),
    band, parapet and penthouse heights est.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "golden_nugget_las_vega_w206151446"
MAX_TRIS = 2_500

BURY = -2.0
H = 67.8          # project data
H_POD = 12.0      # est. casino podium
H_EAST = 54.5     # project data
H_LINK = 55.4     # project data

COLORS = {
    "Wall": "E9E2D0",
    "Glass": "CDBF98",    # gold-tinted window wall (est.)
    "Podium": "D8CFB8",
    "Crown": "F1EAD6",
    "Roof": "9A968C",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.55)

# volume 3 outer outline with the slits toward the tower volumes removed (rounded to 0.1 m from footprint.json)
PODIUM = [(18, -22), (6, -44), (-33, -117), (3, -136), (-13, -166), (-72, -135), (-89, -126), (-57, -66),
          (-33, -21), (-2, -37), (32, 26), (3, 42), (-21, -2), (-37, 7), (-87, 34), (-69, 70), (-52, 101),
          (-14, 81), (-11, 79), (-8, 84), (10, 74), (29, 111), (112, 67), (89, 25), (80, 7), (62, 17), (35, -31)]


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.12)
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    if material == "Podium":
        return kit.scaled(WARM, 0.30 if center[2] < H_POD - 0.5 else 0.05)
    return (0.0, 0.0, 0.0)


def tower(b, plan, top, bands):
    """Cream tower with gold window bands, a lit parapet and a flat roof."""
    step = (top - 3.0 - H_POD) / bands
    levels, mats = [BURY, H_POD], ["Wall"]
    for i in range(bands):
        z = H_POD + i * step
        levels += [z + step - 1.8, z + step]
        mats += ["Glass", "Wall"]
    levels[-1] = top - 3.0
    levels.append(top)
    mats.append("Crown")
    rings = kit.footprint_rings(plan, levels)
    b.loft(rings[:-1] + [rings[-1]], mats, cap=True)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.extrude(PODIUM, BURY, H_POD, "Podium", top="Roof")
    tower(b, vols[0]["outline"], H - 2.5, 8)
    tower(b, vols[2]["outline"], H_EAST, 6)
    b.extrude(vols[1]["outline"], BURY, H_LINK, "Wall", top="Roof")
    # mechanical penthouses on the two south-west slabs reach the lidar height (positions est.)
    b.block((-26.0, -75.0), 5.0, 9.0, H - 3.0, H, "Wall", top="Roof", turn_deg=-28.0)
    b.block((-34.0, -141.0), 9.0, 5.0, H - 3.0, H, "Wall", top="Roof", turn_deg=-28.0)
    b.block((48.0, -5.0), 5.0, 8.0, H_EAST - 0.5, H_EAST + 3.0, "Wall", top="Roof", turn_deg=-28.0)
    return b.finish("Tower_w206151446")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
