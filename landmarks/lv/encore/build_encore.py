"""Low-poly model of a curved bronze-glass hotel tower (Las Vegas, id w27910891), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown fascia is a plain surface.

Sources:
  - height 192.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (OSM outline), extruded exactly
  - 20 white horizontal bands, crown fascia height (~11 m): read off refs/Encore_Las_Vegas_Strip.jpg (est.)
  - night: band lines lit warm, glass dark (refs/Encore_-_Daniel_Lobo.jpg)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "encore"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 192.0          # project data
PODIUM_TOP = 14.0       # (est.) darker base behind the low-rise podium
CROWN_BASE = 181.0      # (est.) photo ratio: plain fascia is ~6% of height
N_BANDS = 20            # (est.) photo shows ~20-24 thin lines; 20 keeps the budget
BAND_H = 0.7            # (est.) white spandrel line thickness
ROOF_LIP = 0.4

COLORS = {
    "BronzeGlass": "6E3F2C",
    "DarkGlass": "3A2219",
    "WhiteBand": "E9E2D4",
    "CrownFascia": "5A3324",
    "Roof": "8A8478",
}
ROUGHNESS = {"BronzeGlass": 0.25, "DarkGlass": 0.3, "CrownFascia": 0.3}
WARM = (1.0, 0.80, 0.52)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material == "WhiteBand":
        return kit.scaled(WARM, 0.9)
    if material == "BronzeGlass":
        return kit.scaled(WARM, 0.02)
    if material == "CrownFascia":
        return kit.scaled(WARM, 0.04)
    if material == "DarkGlass":
        return kit.scaled(WARM, 0.05)
    return (0.0, 0.0, 0.0)


def outline() -> list:
    pts = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2
    return pts if area > 0 else pts[::-1]


def levels() -> tuple:
    """Ring heights and the material of each band between them."""
    zs, mats = [BURY, PODIUM_TOP], ["DarkGlass"]
    pitch = (CROWN_BASE - PODIUM_TOP) / N_BANDS
    for i in range(N_BANDS):
        top = PODIUM_TOP + pitch * (i + 1)
        zs += [PODIUM_TOP + pitch * i + BAND_H, top]
        mats += ["WhiteBand", "BronzeGlass"]
    zs[-1] = CROWN_BASE
    zs += [CROWN_BASE + BAND_H, HEIGHT - ROOF_LIP, HEIGHT]
    mats += ["WhiteBand", "CrownFascia", "Roof"]
    return zs, mats


def build_body(b: kit.Builder) -> None:
    plan = outline()
    zs, mats = levels()
    b.loft([[(x, y, z) for x, y in plan] for z in zs], mats)


PARTS = {"body": build_body}


# facade glass that gets the app's lit-window pattern at night (added by the orchestrator)
WINDOWS = {'BronzeGlass': 1.0}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
