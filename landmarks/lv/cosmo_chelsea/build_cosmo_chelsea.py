"""Low-poly model of a bent-slab hotel tower (Las Vegas, id w27897905), built with landmark_kit.

Logos, wordmarks and brand signage are deliberately not modeled: the crown sign panels are plain.

Sources:
  - height 184.0 m: project data (osm-height)
  - plan: footprint.json from skyline_tool.py footprint (exact OSM outline, offset 0,0)
  - crown band depth (~14 m), band rhythm, colors, night LED dashes: read off
    refs/The_Cosmopolitan_of_Las_Vegas.jpg and refs/Cosmopolitan_Casino_Beach_Club_Tower_2_.jpg (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "cosmo_chelsea"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 184.0            # project data
CROWN_Z0 = 170.0          # underside of plain crown panel (est. from photo: ~8% of height)
ROOF_Z = 181.0            # roof deck behind the parapet (est.)
BAND_Z0, BAND_STEP, BAND_T = 10.0, 5.3, 1.1   # bold balcony-slab bands, each stands for ~1.5 floors (est.)
BAND_OUT = 0.7            # balcony projection (est.)
BASE_Z = 8.0              # darker base storey (est.)

COLORS = {
    "Glass": "2B3A4C",      # blue-gray glass
    "Band": "C9CED2",       # pale balcony slab edges
    "CrownPanel": "1B2026", # plain dark crown screen
    "Base": "3A3D42",
    "Roof": "55595E",
}
ROUGHNESS = {"Glass": 0.3, "CrownPanel": 0.5}

WARM, LED = (1.0, 0.82, 0.58), (0.55, 0.65, 1.0)


def _hash(*v: float) -> float:
    s = math.sin(sum(x * k for x, k in zip(v, (12.9898, 78.233, 37.719)))) * 43758.5453
    return s - math.floor(s)


def glow(material, point, center):
    if material == "Band":   # scattered blue-white LED dashes along balcony edges
        return kit.scaled(LED, 1.1) if _hash(round(center[0]), round(center[1]), round(center[2])) < 0.25 else kit.scaled(LED, 0.06)
    if material == "Glass":
        return kit.scaled((0.75, 0.8, 1.0), 0.03)
    if material == "CrownPanel":  # softly washed plain panel
        return kit.scaled((0.8, 0.85, 1.0), 0.07)
    if material == "Base":
        return kit.scaled(WARM, 0.12)
    return (0.0, 0.0, 0.0)


def offset(points, d):
    """Miter-offset a polygon outward by d meters."""
    pts = list(points)
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))
    if area < 0:
        pts.reverse()
    n, out = len(pts), []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        def nrm(a, b):
            dx, dy = b[0] - a[0], b[1] - a[1]
            l = math.hypot(dx, dy) or 1.0
            return (dy / l, -dx / l)
        n1, n2 = nrm(p0, p1), nrm(p1, p2)
        bx, by = n1[0] + n2[0], n1[1] + n2[1]
        bl = math.hypot(bx, by) or 1.0
        bx, by = bx / bl, by / bl
        k = d / max(0.35, bx * n1[0] + by * n1[1])
        out.append((p1[0] + bx * k, p1[1] + by * k))
    return out


def subdivide(points, max_len):
    """Split long walls so night dashes are short segments."""
    out = []
    for a, b in zip(points, points[1:] + points[:1]):
        k = max(1, round(math.hypot(b[0] - a[0], b[1] - a[1]) / max_len))
        out += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(k)]
    return out


def build_body(b):
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(offset(outline, 0.3), BURY, BASE_Z, "Base")
    b.extrude(outline, BASE_Z, CROWN_Z0, "Glass")
    band = subdivide(offset(outline, BAND_OUT), 22.0)
    z = BAND_Z0
    while z + BAND_T < CROWN_Z0 - 2:
        b.extrude(band, z, z + BAND_T, "Band", top="Band", bottom="Band")
        z += BAND_STEP
    # crown: plain dark screen wall, flush-ish with balconies, roof deck recessed behind parapet
    b.extrude(offset(outline, 0.5), CROWN_Z0, ROOF_Z, "CrownPanel", top="Roof")
    b.extrude(offset(outline, 0.5), ROOF_Z, HEIGHT, "CrownPanel", top="Roof")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={'Glass': 1.0})  # lit windows at night (orchestrator)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("BentSlabTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
