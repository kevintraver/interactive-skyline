"""Low-poly model of a three-wing hotel tower (Las Vegas), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - <height: source>
  - <plan size / footprint: source>
  - <proportions read off <photo file> (side elevation), scaled by the published height>
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

# Split for parallel part-modelers? Move the dimensions, COLORS, ROUGHNESS and glow below into spec.py,
# replace them here with `from spec import *`, and let each modeler write part_<name>.py (assets/part_template.py).

STEM = "palazzo"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Height 196.0 m: project data (osm-height), trusted. Plan: footprint.json (OSM outline, offset 0,0).
# Section heights are ratios read off refs (day side view, night front view) x 196 m: all (est.).
BURY = -2.0
HEIGHT = 196.0             # project data: top of the end tower on the southwest wing
BASE_TOP = 26.0            # (est.) stone base below the window grid
CORNICE = 166.0            # (est.) main cornice band
ATTIC_TOP = 180.0          # (est.) attic storey above the cornice
ROOF_TOP = 184.0           # (est.) roof parapet
MID_BAND = 50.0            # (est.) white belt course, about a quarter up (day side photo)
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Stone": "E6D3AE",
    "Band": "F1E8D6",
    "Glass": "3F5F8A",
    "Roof": "8C8478",
}
ROUGHNESS = {"Glass": 0.3}
GOLD = (1.0, 0.78, 0.30)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    """Night photos: whole facade flood-lit warm gold, cornice and attic brightest, windows dim."""
    z = point[2]
    if material == "Stone":
        return kit.scaled(GOLD, 0.45 if z < CORNICE else 0.75)
    if material == "Band":
        return kit.scaled(GOLD, 0.95)
    if material == "Glass":
        return kit.scaled(GOLD, 0.10)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def ccw(pts):
    pts = list(pts)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts if area > 0 else pts[::-1]


def offset(pts, d):
    """Miter-offset a CCW polygon outward by d meters (d < 0 insets)."""
    n, out = len(pts), []
    for i in range(n):
        (ax, ay), (bx, by), (cx, cy) = pts[i - 1], pts[i], pts[(i + 1) % n]
        l1, l2 = math.hypot(bx - ax, by - ay), math.hypot(cx - bx, cy - by)
        n1, n2 = ((by - ay) / l1, -(bx - ax) / l1), ((cy - by) / l2, -(cx - bx) / l2)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        k = d / max(0.35, (mx * n1[0] + my * n1[1]))
        out.append((bx + mx * k, by + my * k))
    return out


P = ccw(FP)


def build_body(b: kit.Builder) -> None:
    b.extrude(P, BURY, CORNICE, "Stone")
    b.extrude(offset(P, 1.2), BASE_TOP - 2.0, BASE_TOP, "Band")
    b.extrude(offset(P, 0.8), MID_BAND - 1.5, MID_BAND, "Band")


def build_windows(b: kit.Builder) -> None:
    """Vertical dark-glass strips between stone piers on every long wall (two tiers, split by the belt)."""
    pitch, width, out, back = 6.4, 3.8, 0.35, 0.3
    n = len(P)
    for i in range(n):
        (ax, ay), (bx, by) = P[i], P[(i + 1) % n]
        length = math.hypot(bx - ax, by - ay)
        if length < 20.0:
            continue
        tx, ty = (bx - ax) / length, (by - ay) / length
        nx, ny = ty, -tx
        count = int((length - 5.0) // pitch)
        start = (length - count * pitch) / 2 + (pitch - width) / 2
        for j in range(count):
            s0 = start + j * pitch
            quad = [(ax + tx * s + nx * o, ay + ty * s + ny * o)
                    for s, o in ((s0, -back), (s0 + width, -back), (s0 + width, out), (s0, out))]
            b.extrude(quad, BASE_TOP + 3.0, MID_BAND - 3.0, "Glass")
            b.extrude(quad, MID_BAND + 1.5, CORNICE - 5.0, "Glass")


def build_crown(b: kit.Builder) -> None:
    b.extrude(offset(P, 2.2), CORNICE, CORNICE + 3.0, "Band")          # projecting main cornice
    b.extrude(offset(P, -1.0), CORNICE + 3.0, ATTIC_TOP, "Stone")       # attic storey, set back
    b.extrude(offset(P, 0.6), ATTIC_TOP, ATTIC_TOP + 2.0, "Band")       # upper cornice
    b.extrude(offset(P, -2.0), ATTIC_TOP + 2.0, ROOF_TOP, "Stone", top="Roof")
    # plain end tower on the southwest wing tip (its faces carry signage in reality: left blank)
    tip = [P_ for P_ in P if P_[0] < -50.0]
    cx, cy = sum(p[0] for p in tip) / len(tip), sum(p[1] for p in tip) / len(tip)
    ang = math.atan2(-67.37 + 29.74, -54.49 - 0.6)                      # wing axis from the footprint edge
    ux, uy = math.cos(ang), math.sin(ang)

    def rect(c, hu, hv):
        return [(c[0] + ux * a - uy * v, c[1] + uy * a + ux * v) for a, v in ((-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv))]
    c = (cx - ux * 6.0, cy - uy * 6.0)
    b.extrude(rect(c, 9.0, 11.0), ROOF_TOP - 6.0, HEIGHT - 5.0, "Stone")
    b.extrude(rect(c, 10.2, 12.2), HEIGHT - 5.0, HEIGHT - 3.0, "Band")
    b.extrude(rect(c, 8.0, 10.0), HEIGHT - 3.0, HEIGHT, "Stone", top="Roof")


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "windows": build_windows, "crown": build_crown, **part_files()}  # build order; --only body,top builds a subset


# facade glass that gets the app's lit-window pattern at night (added by the orchestrator)
WINDOWS = {'Glass': 1.0, 'Stone': 0.6}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
