"""Low-poly model of a three-arc glass hotel tower at CityCenter (Las Vegas), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_vdara.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin at the app's placement point (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown sign area is a plain surface.

Sources:
  - height 174.0 m: project data (osm-height), trusted
  - plan and arc heights (174 / 165 / 140 m): footprint.json from skyline_tool.py (OSM building parts)
  - 4th OSM volume (tagged 144.1 m) is the surrounding base outline: built as a low podium, 9 m (est.)
  - band spacing, crown depth, colors: read off refs/Vdara_-_South_-_2010-03-06.jpg (est.)
  - night: refs/Vdara_at_night_Steve_Parker_-_Flickr.jpg (pale lit spandrels, warm lit canopy)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "vdara"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 174.0            # project data
PODIUM_TOP = 9.0          # (est.) from side photo: canopy/pool deck about 1/20 of the height
CROWN_DEPTH = 6.0         # (est.) plain parapet band, about two floors
BAND_STEP = 24.0          # (est.) one modeled spandrel band per ~6 floors (real: every floor)
BAND_THICK = 1.6          # (est.)
SIMPLIFY_TOL = 0.45       # m, outline simplification for the triangle budget

COLORS = {
    "FacadeGlass": "7FAAB6",
    "SpandrelBand": "C3D2D4",
    "Crown": "A3BFC6",
    "Podium": "D6D3C8",
    "Roof": "7E8588",
}
ROUGHNESS = {"FacadeGlass": 0.3, "Crown": 0.4}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "FacadeGlass":
        return kit.scaled(COOL, 0.03)
    if material == "SpandrelBand":
        return kit.scaled(COOL, 0.22)
    if material == "Crown":
        return kit.scaled(COOL, 0.30)
    if material == "Podium":
        return kit.scaled(WARM, 0.55)
    return (0.0, 0.0, 0.0)


def simplify(points, tol):
    """Douglas-Peucker on a closed outline; returns a new list."""
    def dp(seg):
        if len(seg) < 3:
            return seg
        (ax, ay), (bx, by) = seg[0], seg[-1]
        length = math.hypot(bx - ax, by - ay) or 1e-9
        dist = [abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length for px, py in seg[1:-1]]
        i = max(range(len(dist)), key=dist.__getitem__)
        if dist[i] <= tol:
            return [seg[0], seg[-1]]
        return dp(seg[:i + 2])[:-1] + dp(seg[i + 1:])
    pts = [p for i, p in enumerate(points) if math.dist(p, points[i - 1]) > 0.3]
    far = max(range(len(pts)), key=lambda i: math.dist(pts[i], pts[0]))
    return dp(pts[:far + 1])[:-1] + dp(pts[far:] + pts[:1])[:-1]


def build_arc(b, outline, top):
    crown0 = top - CROWN_DEPTH
    z = PODIUM_TOP
    b.extrude(outline, BURY, z, "FacadeGlass")
    count = max(1, round((crown0 - z) / BAND_STEP))
    step = (crown0 - z) / count
    for _ in range(count):
        b.extrude(outline, z, z + BAND_THICK, "SpandrelBand")
        b.extrude(outline, z + BAND_THICK, z + step, "FacadeGlass")
        z += step
    b.extrude(outline, crown0, top, "Crown", top="Roof")


def build_body(b):
    doc = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    volumes = sorted(doc["volumes"], key=lambda v: len(v["outline"]))
    for v in volumes[:-1]:
        build_arc(b, simplify(v["outline"], SIMPLIFY_TOL), v["top"])
    b.extrude(simplify(volumes[-1]["outline"], 0.8), BURY, PODIUM_TOP, "Podium", top="Roof")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"FacadeGlass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("HotelTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
