"""Low-poly model of a cross-plan Las Vegas resort hotel with a stepped west wing (id w116770006).

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain.

Sources:
  - height: project data (osm-levels) 96.0 m
  - plan and per-volume tops: footprint.json (skyline_tool.py footprint), 20 mapped volumes: the cross-plan
    tower (89 m), eight stepped slabs of the west wing (46-96 m), and low podium/casino/garage volumes
    (14-38 m), each modeled at its mapped top.
  - facade: Commons search returned no usable photo; green glass with pale horizontal bands, pale crown
    and green night wash are estimates from general knowledge of the building. Band heights estimated.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hotel_mgm_grand_las_ve_w116770006"
MAX_TRIS = 2_500
BURY = -2.0
TALL = 40.0        # volumes above this are hotel tower, below are podium (est. split)
CROWN_H = 4.0      # est.

COLORS = {
    "Glass": "2F6B58",
    "Band": "9FC9B4",
    "Crown": "CFE3D6",
    "Base": "C9C6B4",
    "BaseTrim": "5E8C78",
    "Roof": "8A8C88",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
GREEN = (0.35, 1.0, 0.55)
WARM = (1.0, 0.82, 0.55)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(GREEN, 0.03)
    if material == "Band":
        return kit.scaled(GREEN, 0.35)
    if material == "Crown":
        return kit.scaled(GREEN, 0.65)
    if material == "BaseTrim":
        return kit.scaled(GREEN, 0.30)
    if material == "Base":
        return kit.scaled(WARM, 0.18)
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    """Ramer-Douglas-Peucker on a closed outline (drops the repeated closing point)."""
    pts = [tuple(p) for p in pts]
    if pts[0] == pts[-1]:
        pts = pts[:-1]

    def rdp(seg):
        if len(seg) < 3:
            return seg
        (x0, y0), (x1, y1) = seg[0], seg[-1]
        length = math.hypot(x1 - x0, y1 - y0) or 1e-9
        dist = [abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / length for x, y in seg[1:-1]]
        i = max(range(len(dist)), key=dist.__getitem__)
        if dist[i] <= tol:
            return [seg[0], seg[-1]]
        return rdp(seg[:i + 2])[:-1] + rdp(seg[i + 1:])

    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    return rdp(pts[:far + 1])[:-1] + rdp(pts[far:] + [pts[0]])[:-1]


def tower(b, plan, top, bands):
    levels, mats = [BURY], []
    for z in bands:
        if z + 6 < top - CROWN_H:
            levels += [z, (z, 0.5), (z + 1.5, 0.5), (z + 1.5, 0.0)]
            mats += ["Glass", "Band", "Band", "Band"]
    zc = top - CROWN_H
    levels += [zc, (zc, 0.7), (top, 0.7), (top, -1.5), (top - 1.0, -1.5)]
    mats += ["Glass", "Crown", "Crown", "Crown", "Roof"]
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for i, vol in enumerate(fp["volumes"]):
        top = vol["top"]
        plan = simplify(vol["outline"], 0.3 if top > TALL else 2.0)
        if abs(kit.polygon_area(plan)) < 20:
            continue
        if top > TALL:
            tower(b, plan, top, (30.0, 60.0) if i == 0 else ())
        else:
            b.extrude(plan, BURY, top - 1.2, "Base", top="Roof")
            b.extrude(kit.offset_polygon(kit.ccw_polygon(plan), 0.4), top - 1.2, top, "BaseTrim", top="Roof")
    return b.finish("Resort_w116770006")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
