"""Low-poly model of unnamed building w136520122 (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signage modeled.

Sources:
  - height 80.0 m: project data (osm-height)
  - plan and step heights: skyline_tool.py footprint (footprint.json): a low podium (mapped top 15 m),
    two 80 m cross slabs and wings stepping down in 10 m steps to 30 m
  - towers start at the podium roof (mapped bottom 20 m; lowered to 15 m to close the gap, est.)
  - facade colors, parapet caps, bands, roof blocks: estimated (no photos; plausible Las Vegas hotel)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bldg_w136520122"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 80.0        # project data (osm-height)
PODIUM_TOP = 15.0    # footprint.json
CAP_H = 1.5          # (est.) parapet band
MECH_H = 3.0         # (est.) roof block on the two tall slabs, inside the 80 m total
VOLUMES = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]

COLORS = {"Wall": "D8CCB6", "Glass": "2C3B47", "Band": "C4B69E", "Cap": "E9E0D0", "Roof": "77787A"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Wall":
        return kit.scaled(WARM, 0.06 + 0.35 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Cap":
        return kit.scaled(WARM, 0.55)
    if material == "Band":
        return kit.scaled(WARM, 0.07)
    return (0.0, 0.0, 0.0)


def clean(plan, min_edge=0.6, min_area=0.4):
    """Drop near-duplicate and collinear points (they make zero-area faces)."""
    pts = [tuple(p) for p in plan]
    changed = True
    while changed and len(pts) > 4:
        changed = False
        for i in range(len(pts)):
            a, p, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            area = abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / 2.0
            if math.dist(a, p) < min_edge or area < min_area:
                del pts[i]
                changed = True
                break
    return pts


def build_body(b):
    for v in VOLUMES:
        plan, top = clean(v["outline"]), v["top"]
        if top <= PODIUM_TOP:
            b.extrude(plan, BURY, top, "Wall", top="Roof")
            continue
        tall = top >= HEIGHT - 0.01
        roof = top - MECH_H if tall else top
        # wings reach past the podium, so every volume gets its own base down to the ground
        b.extrude(kit.offset_polygon(plan, 0.3), BURY, PODIUM_TOP, "Wall")
        b.extrude(plan, PODIUM_TOP, roof - CAP_H, "Glass")
        b.extrude(kit.offset_polygon(plan, 0.3), roof - CAP_H, roof, "Cap", top="Roof")
        z = 25.0  # (est.) spandrel bands every 10 m, in step with the mapped 10 m terraces
        while z < roof - CAP_H - 3.0:
            b.extrude(kit.offset_polygon(plan, 0.2), z, z + 1.0, "Band")
            z += 10.0
        if tall:
            b.extrude(kit.offset_polygon(plan, -4.0), roof, top, "Wall", top="Roof")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Bldg_w136520122")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
