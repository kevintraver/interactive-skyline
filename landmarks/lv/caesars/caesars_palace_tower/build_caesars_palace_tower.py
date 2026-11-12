"""Low-poly model of the tallest white classical slab tower (w134944648, Las Vegas), built with landmark_kit + classical_tower.

Units are meters. +X east, +Y north, +Z up; origin = footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: friezes and end walls are plain.

Sources:
  - height 133.0 m: project data (osm-height), trusted; taken as the central pediment apex
  - plan: footprint.json gives a 163.4 x 29.6 m rectangle turned 2.3 deg; bay and pavilion projections est.
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

STEM = "caesars_palace_tower"
MAX_TRIS = 5_000

SPEC = ct.Spec(height=133.0, rot_deg=-2.28, feature=(-20.0, 20.0), bay=5.6, pier_frac=0.62, bands=10, roof_half_w=12.0)
COLORS = {**ct.BASE_COLORS}

HALF_L, HALF_W = 81.7, 13.6      # mapped slab is 163.4 x 29.6 m (footprint.json)
END_L, END_OUT = 15.0, 1.2       # end pavilions (est.)
BAY_OUT = 2.6                    # central bay projection (est.)


def plan():
    """The mapped plan is a bare rectangle; the central bay and end pavilions are added from the photos."""
    f = SPEC.feature[1]
    south = [(-HALF_L, -HALF_W - END_OUT), (-HALF_L + END_L, -HALF_W - END_OUT), (-HALF_L + END_L, -HALF_W),
             (-f, -HALF_W), (-f, -HALF_W - BAY_OUT), (f, -HALF_W - BAY_OUT), (f, -HALF_W),
             (HALF_L - END_L, -HALF_W), (HALF_L - END_L, -HALF_W - END_OUT), (HALF_L, -HALF_W - END_OUT)]
    north = [(-u, -v) for u, v in south]
    return [ct.to_world(SPEC, u, v) for u, v in south + north]


def build():
    b = kit.Builder(COLORS, ct.make_glow(SPEC), ct.ROUGHNESS, windows=ct.WINDOWS)
    ct.build_tower(b, plan(), SPEC)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
