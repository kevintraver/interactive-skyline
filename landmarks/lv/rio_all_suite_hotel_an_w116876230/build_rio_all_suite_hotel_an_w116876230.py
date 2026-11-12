"""Low-poly model of a 20-story Y-plan hotel tower with its casino podium, Las Vegas (id w116876230).

Units are meters; +X east, +Y north, +Z up. Logos and signs are not modeled.

Sources:
  - height 74.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), volume 0 = three-wing tower, volume 1 = casino
    podium; offset 0,0
  - podium: mapped at 30.2 m, modeled low at 14 m (est., 2-3 story casino in Commons photos)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): blue glass with red/magenta
    bands at base and crown; band heights est.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "rio_all_suite_hotel_an_w116876230"
MAX_TRIS = 2_500

BURY = -2.0
H = 74.0          # project data
H_PODIUM = 14.0   # est.
H_BAND = 66.0     # est. start of red crown band

COLORS = {
    "Glass": "3E6FA8",      # blue reflective glass
    "RedGlass": "B03A4A",   # red/magenta glass bands
    "Stripe": "7A3F7E",     # purple accent stripe
    "Podium": "D9C7A6",     # stucco casino block
    "Roof": "A39A8A",
    "Cap": "8A8F96",
}
ROUGHNESS = {"Glass": 0.3, "RedGlass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)
RED = (1.0, 0.18, 0.28)
PURPLE = (0.6, 0.25, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "RedGlass":
        return kit.scaled(RED, 0.45)
    if material == "Stripe":
        return kit.scaled(PURPLE, 0.5)
    if material == "Podium":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def dedupe(points, tol):
    out = []
    for p in points:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    while len(out) > 3 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def build():
    volumes = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    tower = volumes[0]["outline"]
    podium = dedupe(volumes[1]["outline"], 2.5)
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    b.loft(kit.footprint_rings(tower, [BURY, H_PODIUM + 4.0, H_PODIUM + 5.5, 39.0, 40.2, H_BAND - 1.2,
                                       H_BAND, H - 1.0, (H - 1.0, -1.5), H]),
           ["RedGlass", "Stripe", "Glass", "Stripe", "Glass", "Stripe", "RedGlass", "Cap", "Cap"])
    # red glass end walls of the three wings (photos: red returns at the wing ends), 0.6 m proud
    b.block((-51.0, -71.2), 9.4, 0.8, BURY, H, "RedGlass", top="Cap")
    b.block((-132.3, 93.3), 0.8, 10.6, BURY, H, "RedGlass", turn_deg=-45.0, top="Cap")
    b.block((27.9, 94.3), 0.8, 10.6, BURY, H, "RedGlass", turn_deg=45.0, top="Cap")
    b.extrude(podium, BURY, H_PODIUM, "Podium", top="Roof")
    return b.finish("Tower_w116876230")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
