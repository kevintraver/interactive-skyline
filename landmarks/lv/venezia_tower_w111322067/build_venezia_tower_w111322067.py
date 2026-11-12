"""Low-poly model of a U-plan hotel tower standing on a parking garage in Las Vegas (id w111322067).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 99.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), U-shaped outline open to the north, offset 0,0
  - no usable Commons photo was found; facade is a plausible one (est.): plain cream garage base with
    floor bands, hotel floors of cream masonry with punched windows set back above it, belt courses,
    a projecting cornice and tiled-color parapet. All section heights below are estimates.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "venezia_tower_w111322067"
MAX_TRIS = 2_500

BURY = -2.0
H = 99.0          # project data
H_GARAGE = 34.0   # est.: garage podium under the hotel floors
H_CORNICE = 93.0  # est.
SETBACK = -1.5    # est.: hotel floors inset on the garage

COLORS = {
    "Wall": "E3D3B4",      # cream stucco
    "Garage": "D2C3A6",
    "Slot": "6F675A",      # open garage decks, shaded
    "Glass": "B9B3A6",     # window wall: cream masonry with punched windows, averaged
    "Cornice": "EFE4CC",
    "Parapet": "B5764F",   # terracotta-colored attic
    "Roof": "9A968C",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Wall", "Garage"):
        return kit.scaled(WARM, 0.12)
    if material == "Slot":
        return kit.scaled(WARM, 0.10)
    if material in ("Cornice", "Parapet"):  # flood-lit top
        return kit.scaled(WARM, 0.40)
    return (0.0, 0.0, 0.0)


def build():
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    s = SETBACK
    levels = [BURY, 8.0, 10.5, 14.0, 16.5, 20.0, 22.5, 26.0, 28.5, H_GARAGE,
              (H_GARAGE, s), (38.0, s), (63.0, s), (64.5, s), (H_CORNICE, s),
              (H_CORNICE, 0.3), (95.5, 0.3), (95.5, s), H]
    bands = ["Garage", "Slot", "Garage", "Slot", "Garage", "Slot", "Garage", "Slot", "Garage",
             "Roof", "Wall", "Glass", "Wall", "Glass",
             "Cornice", "Cornice", "Cornice", "Parapet"]
    levels[-1] = (H - 1.0, s)
    b.loft(kit.footprint_rings(plan, levels), bands)
    # mechanical penthouses on the two wings and the south bar (est.), reaching the full height
    b.block((-52.0, 10.0), 6.0, 14.0, H - 1.5, H, "Wall", top="Roof")
    b.block((52.0, 8.0), 6.0, 14.0, H - 1.5, H, "Wall", top="Roof")
    b.block((0.0, -17.0), 18.0, 6.0, H - 1.5, H, "Wall", top="Roof")
    return b.finish("Tower_w111322067")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
