"""Low-poly model of the castle-themed hotel at Tropicana Ave / Las Vegas Blvd (Las Vegas), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_excalibur.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the mapped footprint center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 78.8 m and every plan position / volume top: footprint.json (interactive-skyline, lidar), 39 volumes
  - the two L-shaped hotel towers are volumes 6 and 17 (tops 78.8 / 77.2 m), extruded from the mapped plan
  - round mapped volumes become turrets: mapped center, radius from mapped area, mapped top = cone tip
  - proportions of cones, collars, crenellations, tower-end keeps, base band, awnings: read off refs (est.)
  - cone color per turret: frontal night photo + front day photos + 2017 aerial (est. where turrets overlap)
  - podium height 9 m (est. from the side photo; the mapped 23.8 m is too high for the 2-3 storey casino base)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "excalibur"
MAX_TRIS = 8_000

BURY = -2.0
FOOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))
VOLS = FOOT["volumes"]
TOWERS = (6, 17)            # the two L-shaped hotel towers
BASES = (33, 34)            # castle blocks (front NE, rear SW), mapped top 28.8 m
PODIUM = 38
PODIUM_TOP = 9.0           # (est.) see header
TOWER_ROOF_DROP = 8.5       # (est.) main roof below the turret tips, from the side photo
MERLON_H, MERLON_W, MERLON_D = 3.0, 4.5, 1.6   # bold on purpose: real ones are ~1.5 m and vanish at 1 km
SEG = 10
BASE_BAND_TOP = 14.0        # (est.) 4 storeys, from the corner photo
AWNING_SPACING = 10.0       # (est.) real ones are every ~7 m; thinned for the budget

COLORS = {
    "Facade": "F1EDE4",     # white tower walls with punched windows
    "Keep": "F4F1EA",       # blank white walls of the tower-end keeps
    "Base": "DCCFB2",       # cream 4-storey base band of the towers
    "Stone": "E6DAC0",      # cream castle walls
    "Podium": "D9CDB4",
    "Roof": "9C968C",
    "ConeRed": "C9291F",
    "ConeBlue": "1E5CC0",
    "ConeGold": "D6A738",
    "RoofBlue": "1E5CC0",   # mansard roofs of the keeps
    "Awning": "C9291F",
    "Collar": "F4F0E8",
}
ROUGHNESS = {"ConeRed": 0.55, "ConeBlue": 0.55, "ConeGold": 0.45, "RoofBlue": 0.55}
WINDOWS = {"Facade": 1.0, "Base": 0.5}

# Glow is linear light: a hue stays saturated only if its minor channels are near zero (0.2 linear already
# shows as mid-grey), so each cone glows in its own hue, as in the night photo.
CONE_GLOW = {"ConeRed": (0.62, 0.016, 0.004), "ConeBlue": (0.006, 0.05, 0.70), "ConeGold": (0.70, 0.30, 0.012)}
WARM = (1.0, 0.88, 0.72)    # flood lights on the castle stone
COOL = (1.0, 0.96, 0.90)    # white floods on the keeps


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = max(point[2], 0.0)
    if material in CONE_GLOW:       # lit cones are the night signature: brightest at the eaves, dimmer to the tip
        return kit.scaled(CONE_GLOW[material], 1.0 if point[2] <= center[2] else 0.5)
    if material == "RoofBlue":      # the keeps' mansards are washed in blue light
        return (0.01, 0.07, 0.80)
    if material == "Stone":         # flood-lit from below: bright at the foot, fading up the wall
        return kit.scaled(WARM, 0.09 + 0.36 * math.exp(-z / 24.0))
    if material == "Collar":        # turret crowns catch the light under the cones
        return kit.scaled(WARM, 0.22 + 0.26 * math.exp(-z / 24.0))
    if material == "Keep":
        return kit.scaled(COOL, 0.20 + 0.16 * math.exp(-z / 30.0))
    if material == "Podium":        # warm entrances and shopfronts
        return kit.scaled((1.0, 0.68, 0.38), 0.24)
    if material == "Base":
        return kit.scaled((1.0, 0.80, 0.58), 0.14)
    if material == "Awning":
        return (0.22, 0.008, 0.003)
    if material == "Facade":        # the app's lit windows supply the light
        return (0.03, 0.03, 0.032)
    return (0.05, 0.042, 0.034)     # roofs: spill light, never black


# ------------------------------------------------------------------ helpers
def centroid_radius(outline):
    pts = kit.ccw_polygon(outline)
    area = abs(kit.polygon_area(pts))
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return (cx, cy), math.sqrt(area / math.pi)


def simplify(points, tol):
    """Douglas-Peucker on a closed ring."""
    def dp(seg):
        if len(seg) < 3:
            return seg
        (ax, ay), (bx, by) = seg[0], seg[-1]
        dx, dy = bx - ax, by - ay
        ln = math.hypot(dx, dy) or 1e-9
        best, bi = 0.0, 0
        for i in range(1, len(seg) - 1):
            d = abs((seg[i][0] - ax) * dy - (seg[i][1] - ay) * dx) / ln
            if d > best:
                best, bi = d, i
        if best <= tol:
            return [seg[0], seg[-1]]
        return dp(seg[:bi + 1])[:-1] + dp(seg[bi:])
    pts = list(points)
    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    return dp(pts[:far + 1])[:-1] + dp(pts[far:] + [pts[0]])[:-1]


def merlons(b, outline, z, material, spacing=9.0, min_edge=10.0, h=MERLON_H, w=MERLON_W, d=MERLON_D):
    """Few, bold crenellation blocks along the long edges of a roof outline."""
    pts = kit.ccw_polygon(outline)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        ln = math.hypot(x1 - x0, y1 - y0)
        if ln < min_edge:
            continue
        ux, uy = (x1 - x0) / ln, (y1 - y0) / ln
        nx, ny = -uy, ux                      # inward for a counter-clockwise ring
        n = max(1, int(ln // spacing))
        turn = math.degrees(math.atan2(uy, ux))
        for i in range(n):
            t = (i + 0.5) / n * ln
            c = (x0 + ux * t + nx * d * 0.5, y0 + uy * t + ny * d * 0.5)
            b.block(c, w / 2, d / 2, z - 0.4, z + h, material, turn_deg=turn)


def ring_merlons(b, center, r, z, n=4, h=2.0):
    for k in range(n):
        a = math.tau * (k + 0.5) / n
        c = (center[0] + r * math.cos(a), center[1] + r * math.sin(a))
        b.block(c, 0.8, 1.3, z - 0.3, z + h, "Collar", turn_deg=math.degrees(a))


# cone styles read off the photos: (cone material, cone radius / shaft radius, cone height / shaft radius)
STYLES = {
    "red": ("ConeRed", 1.35, 4.2),      # central spire
    "gold": ("ConeGold", 1.1, 4.4),     # slim gold spires on tall drums
    "blue": ("ConeBlue", 1.55, 3.6),    # wide blue witch-hats on flared collars
    "cap": ("ConeRed", 1.45, 1.5),      # bell tower: low red cap
    "small": ("ConeRed", 1.4, 3.4),     # little wall and rotunda turrets
}


def turret(b, center, r, top, style, base_z=BURY, collar=True):
    """Round shaft, flared collar and a pointed cone whose tip is at `top`."""
    cone, wide, ratio = STYLES[style]
    cone_h = min(ratio * r, 0.6 * (top - base_z))
    shaft_top = top - cone_h
    b.prism(r, base_z, shaft_top - 1.0, SEG, "Stone", center=center)
    if collar:
        b.prism(r * 1.28, shaft_top - 3.0, shaft_top + 0.2, SEG, "Collar", center=center)
    b.prism(r * wide, shaft_top, top, SEG, cone, radius_top=0, center=center, phase=0.01)


def battlement(b, center, r, top, base_z=BURY, cone=False):
    """Round tower with a flared crenellated crown; gate towers carry a small red cone inside the crown."""
    crown = top - (0.9 * r + 2.0 if cone else 2.0)       # `top` is the merlon tops, or the cone tip
    b.prism(r, base_z, crown - 4.0, SEG, "Stone", center=center)
    b.prism(r * 1.25, crown - 4.5, crown, SEG, "Collar", center=center)
    ring_merlons(b, center, r * 1.25 - 0.8, crown)
    if cone:
        b.prism(r * 0.55, crown - 0.2, top, 8, "ConeRed", radius_top=0, center=center, phase=0.01)


# Per-turret assignment by mapped volume index, from the frontal night photo, the two front day photos and the
# 2017 aerial (est. where turrets hide each other). The rear (SW) group is the front rotated 180 degrees.
STYLE_OF = {0: "red", 35: "red", 9: "blue", 25: "blue", 2: "cap", 32: "cap"}
BATTLEMENTS = {7: True, 12: True, 27: True, 29: True,          # gate towers: crown + small red cone
               8: False, 30: False, 10: False, 31: False, 1: False, 5: False, 11: False, 13: False}   # plain crenellated drums
SPIRE_TOP = 64.0    # (est.) the central red spire tops the gold ones in every photo; lidar misses thin tips
BLUE_TOP = 52.0     # (est.) blue cones reach ~0.8 of the spire in the frontal night photo (mapped 60.8 / 58.3)
GOLD_TOP = 58.5     # (est.) gold spires ~0.9 of the spire
# turrets the map lacks (est. from the frontal night photo): the second blue cone of each group, mirrored about
# the castle axis, and the two slim gold spires just behind the central spire; all stand on the castle roof
EXTRA = [((36.0, 55.0), 5.1, BLUE_TOP, "blue"), ((31.4, 18.6), 4.0, GOLD_TOP, "gold"),
         ((18.6, 31.4), 4.0, GOLD_TOP, "gold"),
         ((-36.0, -55.0), 5.1, BLUE_TOP, "blue"), ((-31.4, -18.6), 4.0, GOLD_TOP, "gold"),
         ((-18.6, -31.4), 4.0, GOLD_TOP, "gold")]


def round_tower(b, i, center, r, top, base_z=BURY):
    if i in BATTLEMENTS:
        battlement(b, center, r, top, base_z, cone=BATTLEMENTS[i])
        return
    style = STYLE_OF.get(i, "small")
    if style == "red":
        top = SPIRE_TOP
    elif style == "blue":
        top = BLUE_TOP
    turret(b, center, r, top, style, base_z=base_z, collar=r >= 3.0)


# --------------------------------------------------------------------- parts
def build_podium(b: kit.Builder) -> None:
    b.extrude(simplify(VOLS[PODIUM]["outline"], 2.5), BURY, PODIUM_TOP, "Podium", top="Roof")


def awnings(b, outline, z):
    """Red hooded awnings in a row on top of the base band."""
    pts = kit.ccw_polygon(outline)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        ln = math.hypot(x1 - x0, y1 - y0)
        if ln < 18.0:
            continue
        n = int(ln // AWNING_SPACING)
        for i in range(n):
            t = (i + 0.5) / n
            b.box(1.7, z - 0.5, z + 3.2, "Awning", half_top=0.8, center=(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))


def build_towers(b: kit.Builder) -> None:
    # tower-end and outer-corner keeps: square white blocks with a stone machicolation band, a blue mansard
    # and four slim red-capped pencil turrets from the base band up (corner photo and aerial);
    # centers sit on the mapped end / corner bumps of each L (est.)
    ends = {6: [(90.0, -86.0, 11.5), (89.0, 4.0, 11.0), (-4.0, -85.0, 13.0)],
            17: [(-87.0, 89.0, 11.5), (3.0, 89.0, 12.0), (-85.0, -12.0, 11.5)]}
    for vi in TOWERS:
        v = VOLS[vi]
        top = v["top"]
        roof = top - TOWER_ROOF_DROP
        b.extrude(v["outline"], BURY, roof, "Facade", top="Roof")
        proud = kit.offset_polygon(kit.ccw_polygon(v["outline"]), 0.5)
        b.extrude(proud, BURY, BASE_BAND_TOP, "Base")                       # cream base band
        b.extrude(proud, roof - 2.4, roof + 0.4, "Stone", top="Roof")       # stone parapet under the merlons
        awnings(b, proud, BASE_BAND_TOP)
        merlons(b, proud, roof + 0.4, "Stone", h=2.0, w=3.0, d=1.2)
        for cx, cy, half in ends[vi]:
            b.box(half, BURY, roof + 2.0, "Keep", center=(cx, cy))
            b.box(half + 0.7, roof - 5.0, roof + 2.2, "Stone", center=(cx, cy))
            b.box(half + 0.7, roof + 2.2, top, "RoofBlue", half_top=half * 0.55, center=(cx, cy))
            for sx in (-1, 1):
                for sy in (-1, 1):
                    c = (cx + sx * half, cy + sy * half)
                    b.prism(1.8, BASE_BAND_TOP + 2.0, top - 4.5, 6, "Collar", center=c)
                    b.prism(2.4, top - 4.5, top, 6, "ConeRed", radius_top=0, center=c, phase=0.01)


def build_castle(b: kit.Builder) -> None:
    for vi in BASES:
        v = VOLS[vi]
        b.extrude(v["outline"], PODIUM_TOP - 1.0, v["top"], "Stone", top="Roof")
        merlons(b, v["outline"], v["top"], "Stone", spacing=10.0, min_edge=9.0, h=2.2, w=3.4)
    rounds, squares = [], []
    for i, v in enumerate(VOLS):
        if i in TOWERS or i in BASES or i == PODIUM:
            continue
        (rounds if len(v["outline"]) >= 12 else squares).append(i)
    round_info = {i: centroid_radius(VOLS[i]["outline"]) + (VOLS[i]["top"],) for i in rounds}
    used = set()
    for i in squares:  # diamond keeps: a square crenellated base carrying a round turret
        v = VOLS[i]
        (cx, cy), _ = centroid_radius(v["outline"])
        mate = min(rounds, key=lambda j: math.hypot(round_info[j][0][0] - cx, round_info[j][0][1] - cy))
        (mx, my), mr, mtop = round_info[mate]
        paired = math.hypot(mx - cx, my - cy) < 6.0
        base_top = min(v["top"], 0.62 * mtop) if paired else v["top"] - 12.0
        b.extrude(v["outline"], BURY, base_top, "Stone", top="Roof")
        merlons(b, v["outline"], base_top, "Collar", spacing=7.0, min_edge=9.0, h=2.2, w=3.2)
        if paired:
            used.add(mate)
            round_tower(b, mate, (mx, my), mr, mtop, base_z=base_top - 1.0)
        else:  # gatehouse on the castle axis: a steep red square pyramid (night photo), tip at the mapped top
            half = math.sqrt(abs(kit.polygon_area(kit.ccw_polygon(v["outline"])))) / 2
            b.prism(half * 1.3, base_top + 1.0, v["top"], 4, "ConeRed", radius_top=0, center=(cx, cy), phase=0.01)
    for i in rounds:
        if i in used:
            continue
        c, r, top = round_info[i]
        round_tower(b, i, c, r, top)
    for c, r, top, style in EXTRA:
        turret(b, c, r, top, style, base_z=VOLS[BASES[0]]["top"] - 1.0)


PARTS = {"podium": build_podium, "towers": build_towers, "castle": build_castle}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("CastleHotel")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
