"""The sky beam above the Luxor pyramid (Las Vegas): a thin vertical shaft of light, night only:
a bright thin core (Beam) inside two wider, dimmer sleeves (BeamHalo, BeamOuter), all fading with height.

    python <skill>/scripts/run_blender.py build_luxor_beam.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin on the ground directly under the pyramid's apex.
An "extra" for the app (see extra.json): drawn at night only, with additive blending.

Sources:
  - apex 111.0 m: project data; the core starts at 108.6 m, inside the apex housing of the luxor model
  - top about 1,500 m and width "a few meters": the task brief (the real beam is visible far higher; est.)
  - color: pale blue-white, refs of the pyramid at night (luxor/refs/Luxor_Las_Vegas_23692199928_.jpg)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "luxor_beam"
MAX_TRIS = 500

Z_APEX = 111.0    # pyramid apex (project data)
Z0 = 108.6        # the core starts just inside the apex light housing (lamp opening at about 109.4 m)
Z1 = 1500.0       # top of the modeled shaft (brief)
SEGMENTS = 8
LEVELS = [150.0, 220.0, 350.0, 550.0, 800.0, 1100.0, 1500.0]  # rings above the start, for the falloff

# name: (start z, radius at start, radius at top, glow at start, glow at top); all estimated: a thin bright
# core inside two wider, dimmer sleeves, so the additive layers add up to a soft-edged shaft
LAYERS = {
    "Beam": (Z0, 0.8, 1.3, 1.0, 0.22),
    "BeamHalo": (Z_APEX - 0.6, 1.9, 3.6, 0.30, 0.05),
    "BeamOuter": (Z_APEX + 1.0, 3.6, 8.0, 0.11, 0.015),
}

COLORS = {"Beam": "E6F0FF", "BeamHalo": "C8DCFF", "BeamOuter": "B4CDFF"}
ROUGHNESS = {name: 1.0 for name in LAYERS}
PALE = (0.78, 0.89, 1.0)   # pale blue-white


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z_start, _, _, g0, g1 = LAYERS[material]
    t = max(0.0, min(1.0, (point[2] - z_start) / (Z1 - z_start)))
    return kit.scaled(PALE, g0 + (g1 - g0) * t ** 0.6)  # bright at the lamp, fading with height


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS)
    for name, (z_start, r0, r1, _, _) in LAYERS.items():
        rings = []
        for z in [z_start] + LEVELS:
            t = (z - z_start) / (Z1 - z_start)
            rings.append(kit.circle(r0 + (r1 - r0) * t, z, SEGMENTS))
        b.loft(rings, name)
    return b.finish("Luxor_Beam")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
