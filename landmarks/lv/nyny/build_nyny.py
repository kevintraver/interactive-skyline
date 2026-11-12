"""Low-poly model of a Las Vegas resort made of replica skyscrapers on a podium, built with landmark_kit.

    python <skill>/scripts/run_blender.py build_nyny.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center (install offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.
The roller coaster and the statue are left out on purpose.

Sources:
  - overall height 161.0 m and every volume's top height: project data (osm-height / footprint.json)
  - plan of all 16 volumes: footprint.json from skyline_tool.py footprint (exact, podium outline simplified to 2.5 m)
  - setback levels, crown shapes, facade colors, night light: estimated from Commons photos in refs/ (est.):
      tallest stepped tower: shoulders ~105/127/134 m, lantern base ~140 m (ratios off the December 2013 dusk photo)
      arched-crown tower: shaft shoulder ~93 m, crown base ~108 m, arches to ~121 m, needle tip 126.9 m (same photo)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "nyny"
MAX_TRIS = 8_000
BURY = -2.0
HEIGHT = 161.0  # project data (osm-height)

# volume index -> (facade material, style). Tones est. from the daylight and dusk photos.
#   "deco": body + two Art Deco setbacks   "flat": glass slab + parapet + penthouse
#   "banded": glass with white spandrel bands   "attic": slab with a set-back attic
TOWERS = {
    6: ("FacadeSalmon", "deco"),
    7: ("FacadeTan", "deco"),
    3: ("FacadePeach", "deco"),
    0: ("FacadeCream", "attic"),
    9: ("FacadeBlue", "banded"),
    12: ("FacadeMagenta", "flat"),
    10: ("FacadeTeal", "flat"),
    8: ("FacadeNavy", "flat"),
    5: ("FacadeBronze", "flat"),
}
TALL, ARCHED, MAST, ROUND = 4, 1, 13, 14  # stepped tower with mast; arched-crown tower; their mapped mast/crown
LOW = (2, 11, 15)  # podium and low buildings

COLORS = {  # sRGB, est. from photos (refs), not from signs
    "FacadeStone": "CDC3B0", "StoneTop": "D6CDBB", "Pier": "E4DCCB", "Lantern": "E6E0D2",
    "FacadeWhite": "D4D3CC", "WhiteTop": "E2E1DA", "PierGrey": "8E9296",
    "CrownMetal": "C9CED2", "CrownMetalDark": "8F989F",
    "FacadeSalmon": "C4806F", "FacadeTan": "C99562", "FacadePeach": "DDAE86", "FacadeCream": "E3CF9E",
    "FacadeBlue": "5F86AC", "FacadeMagenta": "8A2B48", "FacadeTeal": "2A5560", "FacadeNavy": "2C3556",
    "FacadeBronze": "553828",
    "Band": "ECE5D4", "Cap": "D9D0BC",
    "Podium": "D6C8AC", "PodiumBase": "C9A887", "PodiumRoof": "A9A190", "Roof": "8C877C",
}
FACADES = [m for m in COLORS if m.startswith("Facade")]
GLASS = ("FacadeNavy", "FacadeBlue", "FacadeMagenta", "FacadeTeal", "FacadeBronze")
WINDOWS = {m: (1.0 if m in GLASS else 0.6) for m in FACADES}
ROUGHNESS = {"FacadeTeal": 0.3, "FacadeMagenta": 0.3, "FacadeBlue": 0.35, "FacadeBronze": 0.35,
             "CrownMetal": 0.35, "CrownMetalDark": 0.4}
WARM, WHITE, COOL = (1.0, 0.70, 0.38), (1.0, 0.95, 0.86), (0.85, 0.92, 1.0)
FLAT_GLOW = {  # material -> (tint, strength)
    "Lantern": (WHITE, 0.75), "WhiteTop": (WHITE, 0.42), "PierGrey": (WHITE, 0.04),
    "CrownMetal": (COOL, 0.50), "CrownMetalDark": (COOL, 0.16),
    "Band": (WARM, 0.10), "Cap": (WARM, 0.28), "PodiumRoof": (WARM, 0.06), "Roof": (WARM, 0.025),
}


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = max(point[2], 0.0)
    if material in FLAT_GLOW:
        tint, strength = FLAT_GLOW[material]
        return kit.scaled(tint, strength)
    if material in GLASS:  # the app's lit windows supply the light
        return kit.scaled(WARM, 0.03)
    if material in FACADES:  # stone: amber flood from the podium, fading upward (night photo)
        return kit.scaled(WARM, 0.04 + 0.14 * math.exp(-z / 45.0))
    if material in ("StoneTop", "Pier"):  # flood-lit upper setbacks, brighter toward the top, never flat white
        t = min(max((z - 100.0) / 40.0, 0.0), 1.0)
        return kit.scaled(WHITE, (0.16 + 0.30 * t) if material == "StoneTop" else 0.05 + 0.30 * t)
    if material in ("Podium", "PodiumBase"):  # lit street-level facades
        return kit.scaled(WARM, 0.12 + 0.40 * math.exp(-z / 10.0))
    return (0.0, 0.0, 0.0)


def simplify(pts, tol):
    """Douglas-Peucker on a closed outline."""
    def rdp(seg):
        (x0, y0), (x1, y1) = seg[0], seg[-1]
        length = math.hypot(x1 - x0, y1 - y0) or 1e-9
        best, idx = 0.0, 0
        for i in range(1, len(seg) - 1):
            d = abs((x1 - x0) * (y0 - seg[i][1]) - (x0 - seg[i][0]) * (y1 - y0)) / length
            if d > best:
                best, idx = d, i
        if best <= tol:
            return [seg[0], seg[-1]]
        return rdp(seg[:idx + 1])[:-1] + rdp(seg[idx:])
    pts = list(pts)
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    return rdp(pts[:far + 1])[:-1] + rdp(pts[far:] + [pts[0]])[:-1]


def centroid(o):
    return (sum(p[0] for p in o) / len(o), sum(p[1] for p in o) / len(o))


def stack(b, o, stages, band="Band", center=None):
    """Art Deco setbacks: stages = [(top, scale, material)], each standing on the one below, with a cornice."""
    z = BURY
    for top, k, mat in stages:
        b.extrude(kit.scale_polygon(o, k, center), z, top, mat, top="Roof")
        b.extrude(kit.scale_polygon(o, k * 1.035, center), top - 1.6, top + 0.5, band, top="Roof")
        z = top - 0.3


def tall_tower(b, outline, c):
    """The 161 m stepped tower: shaft with piers, three setbacks, lantern and mast (levels est. from photos)."""
    o = simplify(outline, 0.8)
    stack(b, o, [(105.0, 1.0, "FacadeStone"), (127.0, 0.80, "StoneTop"), (134.0, 0.60, "StoneTop"),
                 (140.0, 0.42, "StoneTop")], band="Pier", center=c)
    b.fins(o, 30.0, 103.0, spacing=6.2, depth=0.7, width=1.6, material="Pier")
    b.fins(kit.scale_polygon(o, 0.80, c), 105.6, 125.0, spacing=5.2, depth=0.6, width=1.3, material="Pier")
    b.prism(4.3, 139.7, 142.5, 8, "Lantern", radius_top=3.4, center=c)   # lantern base
    b.prism(3.2, 142.2, 152.0, 8, "Lantern", radius_top=2.4, center=c)   # lantern drum
    b.prism(2.4, 151.7, 156.5, 8, "Lantern", radius_top=0.7, center=c)   # rounded cap
    b.prism(0.7, 156.2, HEIGHT, 6, "Lantern", radius_top=0, center=c)    # mast tip (project height)


def arch_slab(b, c, w, z0, apex, axis, mat, seg=6):
    """A round-topped slab 2w wide and 2w long; two crossed slabs make one tier of the sunburst crown."""
    zs = apex - w
    prof = [(-w, z0), (w, z0)] + [(w * math.cos(math.radians(180.0 * i / seg)),
                                   zs + w * math.sin(math.radians(180.0 * i / seg))) for i in range(seg + 1)]
    if axis == "x":
        rings = [[(c[0] + x, c[1] + u, z) for u, z in prof] for x in (-w, w)]
    else:
        rings = [[(c[0] - u, c[1] + y, z) for u, z in prof] for y in (-w, w)]
    b.loft(rings, [mat])


def arched_tower(b, outline, c, tip):
    """The arched-crown tower: white shaft, set-back upper shaft, stacked arches tapering to a needle."""
    o = simplify(outline, 0.8)
    stack(b, o, [(93.0, 1.0, "FacadeWhite"), (101.0, 0.80, "WhiteTop")], band="WhiteTop", center=c)
    b.fins(o, 28.0, 91.0, spacing=4.4, depth=0.5, width=1.5, material="PierGrey")
    b.block(c, 5.6, 5.6, 100.7, 108.3, "WhiteTop", top="Roof")           # square upper shaft
    for sx in (-1, 1):                                                   # corner ornaments at the shoulder
        for sy in (-1, 1):
            b.box(0.9, 100.7, 104.5, "CrownMetal", half_top=0.25, center=(c[0] + sx * 6.6, c[1] + sy * 5.4))
    tiers = [(5.4, 114.0), (4.6, 116.0), (3.8, 117.8), (3.0, 119.4), (2.1, 120.8), (1.3, 122.0)]  # half width, apex
    for i, (w, apex) in enumerate(tiers):
        mat = "CrownMetal" if i % 2 == 0 else "CrownMetalDark"
        z0 = 108.0 - 0.05 * i
        arch_slab(b, c, w, z0, apex, "x", mat)
        arch_slab(b, c, w * 0.999, z0 - 0.02, apex - 0.01, "y", mat)
    b.prism(0.7, 121.0, tip, 6, "CrownMetal", radius_top=0, center=c)    # needle


def tower(b, outline, top, mat, style):
    o = simplify(outline, 0.8)
    if style == "deco":       # body, two setbacks, lit cap
        stack(b, o, [(top * 0.86, 1.0, mat), (top * 0.94, 0.80, mat)])
        b.extrude(kit.scale_polygon(o, 0.52), top * 0.94 - 0.3, top, "Cap", top="Roof")
    elif style == "attic":    # slab with a set-back attic
        stack(b, o, [(top * 0.93, 1.0, mat)])
        b.extrude(kit.scale_polygon(o, 0.7), top * 0.93 - 0.3, top, "Cap", top="Roof")
    elif style == "banded":   # glass with white spandrel bands every ~7 m
        body = top - 5.0
        levels, mats, z = [BURY], [], 12.0
        while z + 1.6 < body:
            levels += [z, z + 1.6]
            mats += [mat, "Band"]
            z += 7.2
        levels.append(body)
        mats.append(mat)
        b.loft(kit.footprint_rings(o, levels), mats)
        b.extrude(kit.scale_polygon(o, 0.6), body - 0.3, top, "Cap", top="Roof")
    else:                     # flat glass slab: thin parapet and a low penthouse
        body = top - 4.0
        b.extrude(o, BURY, body, mat, top="Roof")
        b.extrude(kit.scale_polygon(o, 1.02), body - 1.2, body + 0.4, "Band", top="Roof")
        b.extrude(kit.scale_polygon(o, 0.55), body, top, "Cap", top="Roof")


def build_all(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    for i in LOW:
        o = simplify(vols[i]["outline"], 2.5)
        top = vols[i]["top"]
        b.loft(kit.footprint_rings(o, [BURY, 9.0, top - 0.3]), ["PodiumBase", "Podium"])
        b.extrude(o, top - 0.6, top, "Podium", top="PodiumRoof")  # lighter roof deck (it read black before)
    for i, (mat, style) in TOWERS.items():
        tower(b, vols[i]["outline"], vols[i]["top"], mat, style)
    tall_tower(b, vols[TALL]["outline"], centroid(vols[MAST]["outline"]))
    arched_tower(b, vols[ARCHED]["outline"], centroid(vols[ROUND]["outline"]), vols[ROUND]["top"])


PARTS = {"all": build_all}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("ReplicaSkylineResort")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
