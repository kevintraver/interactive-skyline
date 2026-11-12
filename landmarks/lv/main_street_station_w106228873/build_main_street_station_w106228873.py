"""Low-poly model of a downtown Las Vegas hotel tower with a low casino wing (id w106228873), landmark_kit.

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled: sign areas are plain.

Sources:
  - height 51.6 m: project data (lidar), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0: hotel slab (top 51.5) and the
    casino/low-rise wing (top 10.8), whose mapped rounded-corner duplicates are removed here
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg, photos 4, 8, 11): tan slab with
    horizontal window bands, a raised central crown, cream/tan low casino with a darker cornice; blue
    wash on the crown at night. Band, crown and cornice heights are estimated.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "main_street_station_w106228873"
MAX_TRIS = 2_500

BURY = -2.0
H = 51.6          # project data
H_ROOF = 47.6     # est.: main parapet, crown rises above
H_CASINO = 10.8   # footprint volume top

COLORS = {
    "Wall": "CDB894",
    "Glass": "9C9488",    # tan concrete with dark window strips, averaged
    "Crown": "D8C6A4",
    "Casino": "D9C9A8",
    "Cornice": "7A4A38",
    "Roof": "8C8880",
}
ROUGHNESS = {"Glass": 0.4}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)
BLUE = (0.35, 0.5, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.10)
    if material == "Crown":
        return kit.scaled(BLUE, 0.45)
    if material == "Casino":
        return kit.scaled(WARM, 0.30)
    if material == "Cornice":
        return kit.scaled((1.0, 0.7, 0.35), 0.5)
    return (0.0, 0.0, 0.0)


def build():
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    tower = [(40.58, 38.14), (7.62, 55.88), (-16.02, 68.61), (-26.23, 49.8), (30.36, 19.33)]
    casino = [(54.65, 25.3), (54.78, 16.1), (10.92, -66.34), (8.67, -68.75), (4.4, -69.66),
              (3.11, -72.35), (-2.3, -70.71), (-39.58, -49.79), (-38.14, -41.14), (-48.66, -35.01),
              (-42.41, -25.71), (-48.53, -16.97), (-28.33, 23.22), (-16.55, 21.91), (-12.26, 30.31),
              (-35.7, 45.11), (-23.51, 71.85), (-14.77, 74.98), (11.54, 62.18), (7.62, 55.88),
              (-16.02, 68.61), (-26.23, 49.8), (30.36, 19.33), (40.58, 38.14)]
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.loft(kit.footprint_rings(casino, [BURY, H_CASINO - 2.2, H_CASINO - 0.8, H_CASINO]),
           ["Casino", "Cornice", "Casino"])
    b.extrude(casino, H_CASINO - 0.1, H_CASINO + 0.06, "Roof")

    levels = [BURY, 13.0]
    z = 13.0
    while z + 3.2 < H_ROOF - 2.5:     # one window band per floor, est. 3.2 m floors
        levels += [z + 2.0, z + 3.2]
        z += 3.2
    levels += [H_ROOF]
    mats = ["Wall"] + ["Glass", "Wall"] * ((len(levels) - 3) // 2) + ["Crown"]
    b.loft(kit.footprint_rings(tower, levels), mats)
    b.extrude(tower, H_ROOF - 0.1, H_ROOF + 0.06, "Roof")
    # raised central crown (photo 4), est. 55% of the slab length
    b.extrude(kit.scale_polygon(tower, 0.72), H_ROOF - 0.5, H - 1.2, "Crown", top="Roof")
    b.extrude(kit.scale_polygon(tower, 0.4), H - 1.5, H, "Crown", top="Roof")
    return b.finish("Tower_w106228873")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
