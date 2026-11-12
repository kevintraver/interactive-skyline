"""Low-poly model of the glassier classical tower at the west of the complex (w126267789, Las Vegas), built with landmark_kit + classical_tower.

Units are meters. +X east, +Y north, +Z up; origin = footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: friezes and end walls are plain.

Sources:
  - height 107.0 m: project data (osm-height), trusted; taken as the central pediment apex
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline
  - level ratios (base 0.10, cornice 0.69, arcade 0.735-0.855, top cornice 0.885 of height): read off
    ../refs/Caesars_Palace_crop.jpg and ../refs/Augustus_Tower_of_Caesars_Palace.jpg (est.)
  - pier / column spacing, roof pitch, colors, night levels: estimated from the same photos and
    ../refs/Caesars_Palace_-_South_East_-_2010-12-12.jpg
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402
import classical_tower as ct  # noqa: E402

STEM = "caesars_octavius"
MAX_TRIS = 5_000

SPEC = ct.Spec(height=107.0, rot_deg=-1.9, feature=(-19.6, 19.6), bay=5.4, pier_frac=0.50, bands=8, roof_half_w=12.5)
COLORS = {**ct.BASE_COLORS, "Glass": "4479A8"}

def plan():
    return kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]


def build():
    b = kit.Builder(COLORS, ct.make_glow(SPEC), ct.ROUGHNESS, windows=ct.WINDOWS)
    ct.build_tower(b, plan(), SPEC)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
