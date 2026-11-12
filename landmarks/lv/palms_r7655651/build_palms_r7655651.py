"""Low-poly model of a two-tower Las Vegas resort (id r7655651), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - heights: project data (osm-height) 140.0 m south tower, 126 m north tower (footprint.json volumes)
  - plans: footprint.json (skyline_tool.py footprint), exact mapped outlines
  - podium: mapped at 29.4 m over the whole site; modeled low at 14 m (est., casino/garage block)
  - facade: Commons search sheet (refs/search.json/commons_sheet.jpg): ivory tower with dark vertical
    window strips and a stepped crown; blue glass tower with a flat projecting roof canopy. Band heights est.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "palms_r7655651"
MAX_TRIS = 2_500
BURY = -2.0
H_SOUTH = 140.0   # project data
H_NORTH = 126.0   # footprint volume top
H_PODIUM = 14.0   # est. (mapped 29.4 covers the whole site)

COLORS = {
    "Ivory": "D9CFB8",
    "GlassBronze": "3A3A40",
    "GlassBlue": "2B4E7A",
    "Band": "C9CED4",
    "Podium": "C8B79C",
    "Roof": "8C8A86",
    "Crown": "E6DFCB",
}
ROUGHNESS = {"GlassBronze": 0.3, "GlassBlue": 0.25}
WINDOWS = {"GlassBronze": 1.0, "GlassBlue": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material in ("GlassBronze", "GlassBlue"):
        return kit.scaled(WARM if material == "GlassBronze" else COOL, 0.03)
    if material == "Ivory":
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(z - H_PODIUM, 0.0) / 25.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.7)
    if material == "Band":
        return kit.scaled(COOL, 0.45)
    if material == "Podium":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    """Douglas-Peucker on a closed outline (keeps the triangle count of the big podium plan low)."""
    def dp(seg):
        if len(seg) < 3:
            return seg
        (x0, y0), (x1, y1) = seg[0], seg[-1]
        L = math.hypot(x1 - x0, y1 - y0) or 1e-9
        d = [abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / L for x, y in seg[1:-1]]
        i = max(range(len(d)), key=d.__getitem__)
        if d[i] <= tol:
            return [seg[0], seg[-1]]
        return dp(seg[:i + 2])[:-1] + dp(seg[i + 1:])
    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    return dp(pts[:far + 1])[:-1] + dp(pts[far:] + pts[:1])[:-1]


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    south = vols[0]["outline"]
    north = [p for p in vols[3]["outline"] if p[0] > 116.0]
    podium = simplify(list(vols[4]["outline"]), 2.5)
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)

    b.extrude(podium, BURY, H_PODIUM, "Podium", top="Roof")

    # south tower: ivory piers over dark glass, stepped lit crown
    b.loft(kit.footprint_rings(south, [BURY, 122.0, (122.0, 0.8), (126.0, 0.8), (126.0, -2.0), (134.0, -2.0),
                                       (134.0, -5.0), (H_SOUTH, -5.0)]),
           ["GlassBronze", "Ivory", "Ivory", "Roof", "Crown", "Roof", "Crown"])
    b.fins(south, H_PODIUM, 122.0, 7.0, 0.9, 3.2, "Ivory")

    # north tower: blue glass with light spandrel bands and a projecting flat canopy roof
    levels, mats = [BURY], []
    for z in (40.0, 68.0, 96.0):
        levels += [z, (z, 0.5), (z + 1.5, 0.5), (z + 1.5, 0.0)]
        mats += ["GlassBlue", "Band", "Band", "Band"]
    levels += [116.0, (116.0, -1.5), (122.0, -1.5), (122.0, 3.0), (H_NORTH, 3.0)]
    mats += ["GlassBlue", "Roof", "GlassBlue", "Band", "Band"]
    b.loft(kit.footprint_rings(north, levels), mats)
    return b.finish("Resort_r7655651")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
