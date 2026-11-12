"""Low-poly model of a curved glass resort hotel wing in Las Vegas (id w134930089), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height: project data (osm-height) 65.0 m
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline (curved zigzag hotel wing, all tower)
  - facade: Commons search sheet of the neighbouring main wing (../aria_resort_casino_w134930088/refs/search), same complex: blue-silver curved glass curtain wall
    with pale horizontal sunshade bands, flat top with a plain parapet, cool white light at night.
    Band spacing, base and parapet heights are estimates read off that sheet.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w134930089"
MAX_TRIS = 2_500
BURY = -2.0
H = 65.0          # project data
H_BASE = 8.0       # est.
H_PARAPET = 60.0   # est. top of glass; parapet wall above
N_BANDS = 5        # est. grouped sunshade bands

COLORS = {
    "Glass": "5E7F96",
    "Band": "C9D3D8",
    "Crown": "C3D0D6",
    "Base": "8E979C",
    "Roof": "77797B",
    "Mech": "9A9C9E",
}
ROUGHNESS = {"Glass": 0.25}
WINDOWS = {"Glass": 1.0}
COOL = (0.82, 0.90, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(COOL, 0.03)
    if material == "Band":
        return kit.scaled(COOL, 0.30)
    if material == "Crown":
        return kit.scaled(COOL, 0.50)
    if material == "Base":
        return kit.scaled((1.0, 0.85, 0.6), 0.25)
    return (0.0, 0.0, 0.0)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    plan = fp["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    levels = [BURY, H_BASE, (H_BASE, 0.5), (H_BASE + 1.2, 0.5), (H_BASE + 1.2, 0.0)]
    mats = ["Base", "Band", "Band", "Band"]
    step = (H_PARAPET - H_BASE - 1.2) / (N_BANDS + 1)
    for i in range(1, N_BANDS + 1):
        z = H_BASE + 1.2 + i * step
        levels += [z, (z, 0.4), (z + 0.8, 0.4), (z + 0.8, 0.0)]
        mats += ["Glass", "Band", "Band", "Band"]
    levels += [H_PARAPET, (H_PARAPET, 0.5), (H - 1.5, 0.5), (H - 1.5, -0.8), (H - 3.0, -0.8)]
    mats += ["Glass", "Band", "Crown", "Roof", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # roof plant, set back, below the parapet line plus a little
    b.block((5.0, -15.0), 9.0, 9.0, H - 3.0, H, "Mech", turn_deg=50.0, top="Roof")
    return b.finish("Wing_w134930089")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
