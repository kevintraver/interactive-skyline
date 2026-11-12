"""Low-poly model of a Las Vegas resort complex (id w135332959), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the mapped footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - heights: project data (lidar): main slab 100.9 m, second tower 93.2 m, mid-rises 43.0 / 43.7 m, round hall 21.1 m
  - plans: footprint.json (skyline_tool.py footprint), exact outlines
  - podium: mapped at 40.4 m, which is the roof of one hall only; modeled low at 9 m (est.) with a 30 m hall (est.)
  - facade colors, bands, crown: no usable photos found; plausible white hotel slab with pink accents (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "circus_circus_las_vega_w135332959"
MAX_TRIS = 2_500
BURY = -2.0
PODIUM_H = 9.0     # est.
BAND_STEP = 6.4    # est. white spandrel band every 2 floors

COLORS = {"Wall": "E9E4DA", "Glass": "2A3440", "Roof": "8E9093", "Accent": "D2467E", "Podium": "D9D2C6",
          "Tent": "E86A9A"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, PINK = (1.0, 0.82, 0.58), (1.0, 0.35, 0.6)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Podium":
        return kit.scaled(WARM, 0.18)
    if material == "Accent":
        return kit.scaled(PINK, 0.8)
    if material == "Tent":
        return kit.scaled(PINK, 0.35)
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    if len(out) > 2 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    changed = True
    while changed and len(out) > 4:  # drop near-collinear points
        changed = False
        for i in range(len(out)):
            a, p, c = out[i - 1], out[i], out[(i + 1) % len(out)]
            cross = abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0]))
            if cross / max(math.dist(a, c), 1e-6) < tol * 0.4:
                out.pop(i)
                changed = True
                break
    return out


def tower(b, outline, top, crown):
    """Glass slab with white end walls implied by bands, a solid base and an accent crown."""
    b.extrude(outline, BURY, top - 1.5, "Glass", top="Roof")
    skin = kit.offset_polygon(outline, 0.4)
    z = PODIUM_H + BAND_STEP
    while z < top - crown - 6.0:
        b.extrude(skin, z, z + 3.4, "Wall")
        z += BAND_STEP
    b.extrude(skin, top - crown, top, "Accent" if crown > 3.0 else "Wall", top="Roof")
    b.extrude(skin, BURY, PODIUM_H + 3.0, "Wall")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    main, mid_a, second, mid_b, hall, podium = vols
    b.extrude(simplify(podium["outline"], 3.0), BURY, PODIUM_H, "Podium", top="Roof")
    tower(b, main["outline"], main["top"], 6.0)
    tower(b, simplify(second["outline"], 1.0), second["top"], 5.0)
    tower(b, mid_a["outline"], mid_a["top"], 2.5)
    tower(b, simplify(mid_b["outline"], 1.0), mid_b["top"], 2.5)
    # roof plant on the main slab (est.)
    b.extrude(kit.scale_polygon(main["outline"], 0.45), main["top"] - 1.0, main["top"], "Roof")
    # west hall: glazed pink dome, stepped (plan = west lobe of the podium; 40.4 m is its mapped top)
    lobe = [p for p in simplify(podium["outline"], 3.0) if p[0] < -86.0]
    b.extrude(kit.scale_polygon(lobe, 0.86), PODIUM_H, 28.0, "Tent")
    b.extrude(kit.scale_polygon(lobe, 0.55), 28.0, podium["top"], "Tent")
    # round hall with a stepped tent roof
    ring = simplify(hall["outline"], 6.0)
    b.extrude(ring, BURY, 13.0, "Podium", top="Tent")
    b.extrude(kit.scale_polygon(ring, 0.7), 13.0, 17.5, "Tent")
    b.extrude(kit.scale_polygon(ring, 0.35), 17.5, hall["top"], "Tent")
    return b.finish("Resort_w135332959")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
