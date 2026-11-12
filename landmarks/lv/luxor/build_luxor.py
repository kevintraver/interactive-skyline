"""Low-poly model of the Luxor pyramid (Las Vegas), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_luxor.py -- --out .
    LUXOR_GROUP=sphinx  python <skill>/scripts/run_blender.py build_luxor.py -- --out .   -> luxor_sphinx.glb
    LUXOR_GROUP=obelisk python <skill>/scripts/run_blender.py build_luxor.py -- --out .   -> luxor_obelisk.glb

Three models share one frame (origin at the pyramid's center). The sphinx and the obelisk are buildings of their
own in the app's data (w118344867, w399368723), drawn as plain extrusions that would swallow a sphinx placed in
the pyramid's model, so each is its own GLB and replaces its own building:
    install --id w118344867 --glb luxor_sphinx.glb  --offset -136.3,-0.3
    install --id w399368723 --glb luxor_obelisk.glb --offset -224.1,-1.5
(offset = the pyramid's center from that building's center, from public/data/lv/buildings.json).

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled (face banners and the obelisk's lettering are
left plain). The sphinx, its entrance portico and the obelisk stand east of the mapped square, at their
OpenStreetMap positions relative to the pyramid's center.

Sources:
  - height 111.0 m: project data (osm-height), trusted as is
  - plan: footprint.json (OSM way 27858544), a square of about 184 x 182 m with sides on the compass axes
    (longest edge bearing 179.6 deg); the four true corners are used, collinear mid-edge points dropped
  - ridge width, apex cap height, plinth height: estimated from refs/Luxor_pyramid_Las_Vegas.jpg
  - lit windows and the day floor grid: skyline integration v5 draws them on marked glass that slopes up to
    60 degrees from vertical (these faces: 39.7), so the faces are plain `windows=` glass, no baked panels
  - sphinx: OSM way 118344867 (79 x 28 m plan, 99..178 m east of the center, on the east-west axis, facing
    east); 33.5 m (110 ft, published). Body sections, head and headdress shape est. from the aerial and
    entrance photos in refs/
  - the entrance link between pyramid and sphinx (OSM way 118344870) is left to the app's own extrusion
  - obelisk: OSM way 399368723 (center 224 m east, 1.5 m north); 43 m (140 ft, published; the aerial photo
    shows it about 1.3 x the sphinx, which agrees; OSM's height=62 does not). Shaft taper est.
  - night: refs/Luxor_Las_Vegas_23692199928_.jpg (dark faces with sparse warm windows, white ridge lights,
    bright apex lamp); the ridge lights are spaced fittings, so the ridge is a dim strut
    with small bright boxes every 7 m (pitch est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bmesh  # noqa: E402
import landmark_kit as kit  # noqa: E402
from mathutils import Vector  # noqa: E402

GROUP = os.environ.get("LUXOR_GROUP", "pyramid")   # pyramid | sphinx | obelisk | all (one combined model)
STEM = "luxor" if GROUP == "pyramid" else f"luxor_{GROUP}"
MAX_TRIS = 12_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
HEIGHT = 111.0             # project data
# corners of the mapped square (footprint.json), NE, SE, SW, NW -> reordered counter-clockwise below
CORNERS = [(91.44, 91.32), (-92.45, 90.22), (-91.35, -91.26), (92.55, -90.14)]  # NE, NW, SW, SE (ccw)
APEX = (sum(p[0] for p in CORNERS) / 4.0, sum(p[1] for p in CORNERS) / 4.0)
Z_CAP = 105.5              # glass stops, apex light housing starts (day photo: the cap is the top ~5%)
Z_LAMP = 109.4             # lamp opening on top of the housing (est.)
PLINTH_TOP = 3.5           # low base band (est.)
RIDGE_HALF = 0.45          # inclined-elevator corner ridge half width (est.)
FLOORS = 30                # published floor count; rows of the lit-window grid
APP_FLOOR = 3.4            # the app's procedural floor height; the face lines sit on its floor joints
LINE_STEP = 3              # a faint spandrel line every third floor, so the faces read as glazing from afar
LIGHT_PITCH = 6.0          # spacing of the ridge strobe lights along the slope (est. from the night photo)
LIGHT_LEN, LIGHT_HALF = 1.2, 0.5   # one ridge light, enlarged to read from a distance (est.)

# sphinx (faces east, +X), entrance and obelisk: meters east/north of the pyramid's center
SPHINX_Y = 0.0             # OSM: plan spans 14 m either side of the axis
SPHINX_TOP = 33.5          # 110 ft, published
OBELISK = (224.0, 1.5)     # OSM
OBELISK_TOP = 43.0         # 140 ft, published
OBELISK_BASE, OBELISK_SHOULDER = 5.0, 38.6   # plinth top, start of the pyramidion (est.)

# ---------------------------------------------------------------------- style
COLORS = {
    "Glass": "2C2521",       # dark bronze glass: near black, the app adds the floor grid and the sky's reflection
    "FloorLine": "3A3029",   # faint spandrel line between floors
    "Ridge": "6E5E4A",       # bronze corner ridge over the inclined-elevator shafts (lighter than the glass)
    "RidgeLight": "8A8478",  # strobe fittings spaced up each ridge
    "Cap": "55504A",         # apex light housing (grey louvered metal)
    "CapSlot": "1E1C1A",     # louver slots in the housing
    "Lamp": "E8F0FF",        # lamp opening
    "Plinth": "A8946E",      # sandstone base walls
    "Stone": "DCCBA2",       # sandstone: sphinx body, entrance, obelisk
    "StoneDark": "B5A27A",   # shaded stone: cornices, bases
    "Face": "EADCB8",        # sphinx face
    "HeadGold": "C9A446",    # headdress stripes
    "HeadBlue": "3A68A4",
    "Eye": "23283A",
    "Door": "2A221C",        # entrance openings
    "Tip": "D8BC62",         # obelisk pyramidion
}
ROUGHNESS = {"Glass": 0.08, "FloorLine": 0.3, "Ridge": 0.45, "Cap": 0.5, "Lamp": 0.4, "Tip": 0.4}
WINDOWS = {"Glass": 0.6}   # below 1: the faces stay dark at night, with dim, sparse rooms

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)
FLOOD = (1.0, 0.86, 0.62)   # flood-lighting on the sphinx and obelisk
FLOOD_LEVEL = {"Stone": 0.50, "StoneDark": 0.32, "Face": 0.72, "HeadGold": 0.62, "HeadBlue": 0.30,
               "Eye": 0.04, "Tip": 0.75, "Plinth": 0.16}


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Glass", "FloorLine"):   # the app's lit windows carry the faces
        return kit.scaled(WARM, 0.03)
    if material == "Ridge":       # the ridge itself stays dim; the spaced lights carry it
        return kit.scaled(COOL, 0.06)
    if material == "RidgeLight":  # white strobe lights running up the corners
        return kit.scaled(COOL, 0.70)
    if material == "Lamp":
        return kit.scaled(COOL, 1.0)
    if material == "Cap":         # spill from the lamp
        return kit.scaled(COOL, 0.10 + 0.40 * max(0.0, (z - Z_CAP) / (HEIGHT - Z_CAP)))
    if material == "Door":        # lit entrance
        return kit.scaled(WARM, 0.85)
    if material == "Stone" and center[0] > OBELISK[0] - 10:   # obelisk: up-lit, fading towards the top
        return kit.scaled(FLOOD, 0.62 - 0.25 * min(1.0, center[2] / OBELISK_TOP))
    if material in FLOOD_LEVEL:
        return kit.scaled(FLOOD, FLOOD_LEVEL[material])
    return (0.0, 0.0, 0.0)


def ring(z: float, grow: float = 0.0) -> list:
    """The pyramid's square section at height z (ideal apex at HEIGHT), optionally pushed out by `grow` m."""
    k = max(0.0, (HEIGHT - z) / HEIGHT)
    out = []
    for x, y in CORNERS:
        dx, dy = x - APEX[0], y - APEX[1]
        d = math.hypot(dx, dy)
        g = grow * math.sqrt(2.0) / d
        out.append((APEX[0] + dx * (k + g), APEX[1] + dy * (k + g), z))
    return out


# --------------------------------------------------------------------- parts
def build_pyramid(b: kit.Builder) -> None:
    b.loft([ring(BURY), ring(Z_CAP)], "Glass")


def build_cap(b: kit.Builder) -> None:
    # light housing: follows the slope, slightly proud of the glass, two louver slots, lamp opening on top
    b.loft([ring(Z_CAP - 0.5, 0.35), ring(Z_LAMP, 0.35)], "Cap")
    for z in (106.6, 107.9):
        b.loft([ring(z, 0.45), ring(z + 0.45, 0.45)], "CapSlot")
    b.loft([ring(Z_LAMP - 0.2, 0.2), ring(HEIGHT, 0.7)], "Lamp")


def build_ridges(b: kit.Builder) -> None:
    lower, upper = ring(BURY, 0.3), ring(Z_CAP, 0.3)
    for lo, hi in zip(lower, upper):
        facing = (lo[0] - APEX[0], lo[1] - APEX[1], 0.0)
        b.strut(lo, hi, RIDGE_HALF, facing, "Ridge")
    # spaced strobe lights sitting on each ridge (a dotted line at night)
    lower, upper = ring(0.0, 0.75), ring(Z_CAP, 0.75)
    for lo, hi in zip(lower, upper):
        a, c = Vector(lo), Vector(hi)
        length = (c - a).length
        d = (c - a) / length
        facing = (lo[0] - APEX[0], lo[1] - APEX[1], 0.0)
        s = LIGHT_PITCH
        while s < length - LIGHT_PITCH * 0.5:
            b.strut(tuple(a + d * s), tuple(a + d * (s + LIGHT_LEN)), LIGHT_HALF, facing, "RidgeLight")
            s += LIGHT_PITCH


def build_floor_lines(b: kit.Builder) -> None:
    z = LINE_STEP * APP_FLOOR
    while z < Z_CAP - 2.0:
        b.loft([ring(z - 0.15, 0.05), ring(z + 0.15, 0.05)], "FloorLine")
        z += LINE_STEP * APP_FLOOR


def build_plinth(b: kit.Builder) -> None:
    b.loft([ring(BURY, 1.4), [(x, y, PLINTH_TOP) for x, y, _ in ring(PLINTH_TOP, 1.4)]], "Plinth")


def x_section(x: float, yc: float, half: float, z_side: float, z_top: float, z0: float = BURY) -> list:
    """A rounded cross-section across the sphinx's axis at x: ten points, flat base, arched back."""
    side = [(half, z0), (half, z_side * 0.55), (half * 0.93, z_side), (half * 0.62, z_top * 0.96), (half * 0.22, z_top)]
    pts = side + [(-y, z) for y, z in reversed(side)]
    return [(x, yc + y, z) for y, z in pts]


def build_sphinx_body(b: kit.Builder) -> None:
    # x, half width, height of the flank, height of the back; rump at the west end, chest at the east end
    body = [(99.5, 7.5, 4.5, 8.0), (102.0, 11.0, 8.5, 13.0), (108.0, 12.6, 10.5, 15.8), (117.0, 12.8, 11.0, 16.6),
            (128.0, 11.0, 10.0, 15.2), (138.0, 10.8, 10.5, 16.0), (146.0, 11.6, 12.0, 18.4), (151.0, 11.2, 12.5, 19.6),
            (154.5, 10.0, 10.5, 16.0), (157.0, 8.4, 6.0, 9.5)]
    b.loft([x_section(x, SPHINX_Y, hw, zs, zt) for x, hw, zs, zt in body], "Stone")
    for side in (1, -1):
        yc = SPHINX_Y + side * 9.6
        # front leg and paw, reaching east
        leg = [(145.0, 3.6, 7.5, 9.0), (156.0, 3.5, 6.2, 7.4), (168.0, 3.4, 5.6, 6.6), (175.0, 3.5, 5.0, 6.0),
               (178.0, 3.0, 2.2, 3.4)]
        b.loft([x_section(x, yc, hw, zs, zt) for x, hw, zs, zt in leg], "Stone")
        # folded hind leg: haunch against the flank, paw pointing forward
        yh = SPHINX_Y + side * 11.4
        haunch = [(101.5, 2.0, 4.0, 6.0), (105.0, 3.6, 8.5, 11.5), (113.0, 4.0, 10.0, 13.2), (121.0, 3.6, 7.0, 9.5),
                  (126.0, 3.0, 3.2, 4.4), (133.0, 2.8, 2.6, 3.6), (135.5, 2.4, 1.4, 2.2)]
        b.loft([x_section(x, yh, hw, zs, zt) for x, hw, zs, zt in haunch], "Stone")


def rect_ring(x0: float, x1: float, half: float, z: float, yc: float = SPHINX_Y) -> list:
    return [(x1, yc + half, z), (x0, yc + half, z), (x0, yc - half, z), (x1, yc - half, z)]


def build_sphinx_head(b: kit.Builder) -> None:
    # neck and face (looking east): chin at 21 m, brow at 29.5 m
    b.loft([rect_ring(147.5, 155.2, 4.6, 16.0), rect_ring(148.5, 155.0, 3.6, 21.2)], "Face")
    face = [(149.0, 156.6, 3.2, 20.6), (149.0, 157.7, 4.2, 22.6), (149.0, 158.0, 4.5, 25.5),
            (149.0, 157.7, 4.4, 29.0), (149.5, 156.9, 3.9, 31.0)]
    b.loft([rect_ring(x0, x1, half, z) for x0, x1, half, z in face], "Face")
    b.loft([rect_ring(157.6, 158.5, 0.9, 23.9), rect_ring(157.6, 158.9, 0.7, 24.5),
            rect_ring(157.6, 158.0, 0.45, 27.0)], "Face")  # nose
    for side in (1, -1):
        ye = SPHINX_Y + side * 2.2
        b.loft([rect_ring(157.5, 158.05, 1.05, 26.5, ye), rect_ring(157.5, 158.0, 1.05, 27.4, ye)], "Eye")
        yr = SPHINX_Y + side * 4.5
        b.loft([rect_ring(151.0, 153.5, 0.5, 23.0, yr), rect_ring(151.0, 153.5, 0.5, 26.6, yr)], "Face")  # ears
    b.loft([rect_ring(155.4, 157.0, 1.3, 15.2), rect_ring(155.0, 156.6, 1.5, 20.7)], ["HeadBlue"])  # ceremonial beard
    b.loft([rect_ring(156.7, 157.6, 0.6, 30.2), rect_ring(156.5, 157.3, 0.5, SPHINX_TOP)], ["HeadGold"])  # brow ornament


def build_sphinx_headdress(b: kit.Builder) -> None:
    # striped cloth headdress: wide at the shoulders, narrowing over the crown; the face stands proud of it
    profile = [(17.2, 145.0, 153.8, 10.4), (19.5, 145.6, 154.2, 10.0), (24.0, 146.4, 154.8, 8.8),
               (28.0, 147.2, 155.6, 7.0), (30.6, 147.8, 156.6, 5.4), (32.2, 148.8, 156.2, 4.2), (32.9, 150.2, 155.0, 2.8)]
    stripes = 16
    zs = [profile[0][0] + (profile[-1][0] - profile[0][0]) * i / stripes for i in range(stripes + 1)]
    rings = []
    for z in zs:
        x0 = kit.lerp_table([(p[0], p[1]) for p in profile], z)
        x1 = kit.lerp_table([(p[0], p[2]) for p in profile], z)
        half = kit.lerp_table([(p[0], p[3]) for p in profile], z)
        rings.append(rect_ring(x0, x1, half, z))
    b.loft(rings, ["HeadGold" if i % 2 == 0 else "HeadBlue" for i in range(stripes)])
    for side in (1, -1):   # lappets hanging on the chest
        yc = SPHINX_Y + side * 6.2
        zl = [10.5 + i * 1.4 for i in range(6)]
        b.loft([rect_ring(153.6, 155.6 - 0.12 * i, 2.2, z, yc) for i, z in enumerate(zl)],
               ["HeadBlue" if i % 2 == 0 else "HeadGold" for i in range(5)])


def build_entrance(b: kit.Builder) -> None:
    # portico between the paws: battered walls, cavetto cornice, dark doorway
    b.loft([rect_ring(156.0, 167.0, 5.6, BURY), rect_ring(156.0, 166.4, 5.2, 9.0)], "Stone")
    b.loft([rect_ring(155.6, 166.6, 5.3, 9.0), rect_ring(155.6, 167.4, 6.0, 10.4)], "StoneDark")
    b.loft([rect_ring(166.2, 167.15, 2.6, 0.0), rect_ring(166.2, 166.75, 2.6, 6.4)], "Door")


def build_obelisk(b: kit.Builder) -> None:
    c = OBELISK
    b.box(5.2, BURY, 1.6, "StoneDark", center=c)
    b.box(3.9, 1.6, OBELISK_BASE, "Stone", half_top=3.6, center=c)
    b.box(2.7, OBELISK_BASE, OBELISK_SHOULDER, "Stone", half_top=1.75, center=c)
    b.box(1.75, OBELISK_SHOULDER, OBELISK_TOP, "Tip", half_top=0.06, center=c)


GROUPS = {
    "pyramid": {"pyramid": build_pyramid, "cap": build_cap, "ridges": build_ridges, "floor_lines": build_floor_lines,
                "plinth": build_plinth},
    "sphinx": {"sphinx_body": build_sphinx_body, "sphinx_head": build_sphinx_head,
               "sphinx_headdress": build_sphinx_headdress, "entrance": build_entrance},
    "obelisk": {"obelisk": build_obelisk},
}
GROUP_COLORS = {
    "pyramid": ("Glass", "FloorLine", "Ridge", "RidgeLight", "Cap", "CapSlot", "Lamp", "Plinth"),
    "sphinx": ("Stone", "StoneDark", "Face", "HeadGold", "HeadBlue", "Eye", "Door"),
    "obelisk": ("Stone", "StoneDark", "Tip"),
}
GROUPS["all"] = {name: part for group in ("pyramid", "sphinx", "obelisk") for name, part in GROUPS[group].items()}
GROUP_COLORS["all"] = tuple(COLORS)
PARTS = GROUPS[GROUP]


def split_warped_faces(b: kit.Builder, tolerance: float = 0.002) -> None:
    """Triangulate the quads that are not flat (the sphinx's lofted skin), so every viewer splits them alike."""
    warped = []
    for f in b.bm.faces:
        if len(f.verts) < 4:
            continue
        f.normal_update()
        c = f.calc_center_median()
        if max(abs((v.co - c).dot(f.normal)) for v in f.verts) > tolerance:
            warped.append(f)
    if warped:
        bmesh.ops.triangulate(b.bm, faces=warped)


def build() -> "bpy.types.Object":  # noqa: F821
    colors = {name: COLORS[name] for name in GROUP_COLORS[GROUP]}
    b = kit.Builder(colors, glow, ROUGHNESS, windows=WINDOWS if GROUP in ("pyramid", "all") else None)
    for part in kit.selected(PARTS):
        part(b)
    split_warped_faces(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
