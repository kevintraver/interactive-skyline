"""Low-poly model of the Eiffel Tower replica at Paris Las Vegas, built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_eiffel_lv.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the tower's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: the restaurant's roof-edge sign is a plain surface.

Sources (see research/dimensions.md and refs/sources.json):
  - height 164.6 m (540 ft) and observation deck at 140.2 m (460 ft): Wikipedia "Paris Las Vegas", Las Vegas Sun 1999
  - four feet north/east/south/west of the center, 29 m out, corner radius 7 m: OpenStreetMap way 27831699
    (through interactive-skyline's data/overrides.json)
  - every other height and width: ratios read off refs/Eiffel_Tower_at_Paris_Las_Vegas_by_day_March_15_2009.jpg
    (corner-on side view), scaled by the published height; marked "photo" below
  - top detail: refs/Las_Vegas_Eiffel_Tower_P4230741.jpg; night lighting: refs/Eiffel_Tower_in_Las_Vegas_at_night.jpg
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

STEM = "eiffel_lv"
MAX_TRIS = 8_000

# ----------------------------------------------------------------- dimensions
# "radius" of a square section = center to corner; corners point north/east/south/west (OSM).
BURY = -2.0
HEIGHT = 164.6                      # published (540 ft)
BEARINGS = (0.0, 90.0, 180.0, 270.0)  # math bearings of the four legs: E, N, W, S (OSM)

FOOT_CENTER, FOOT_RADIUS = 29.0, 7.0  # OSM
LEG1_TOP_Z = 30.0                   # photo: underside of the first platform
LEG1_TOP_CENTER, LEG1_TOP_RADIUS = 20.0, 5.0  # photo (outer edge ~25 m out), est. section
ARCH_SPRING_Z, ARCH_CROWN_Z = 4.0, 19.5  # photo: half-ellipse arch, crown just under the truss belt
TRUSS_Z = (20.5, 27.0)              # photo: lattice girder between the legs, under the first platform

PLATFORM1 = (27.0, 30.0, 31.0, 33.3, 37.5, 42.5)  # photo: truss, cornice, deck, glass band, roof edge, roof top
FASCIA_TOP_Z = 39.0                 # photo: plain roof-edge fascia (the sign band, left blank)
PLATFORM1_RADIUS = 28.0             # photo (box side ~40 m)

LEG2_Z = (41.0, 65.0)               # photo
LEG2_BOTTOM_CENTER, LEG2_BOTTOM_RADIUS = 16.5, 4.5  # photo (outer edge 21 m out)
LEG2_TOP_CENTER, LEG2_TOP_RADIUS = 9.2, 3.0         # photo (outer edge 12.2 m out)

PLATFORM2_Z = (63.0, 65.0, 67.0)    # photo
PLATFORM2_RADIUS = 13.9             # photo
BELT_Z, BELT_RADIUS = (56.0, 59.5), 14.9  # photo: lattice gallery belt around the upper legs

SHAFT_RADIUS = [(67.0, 10.0), (80.0, 8.2), (95.0, 6.8), (110.0, 5.6), (125.0, 4.7), (137.0, 4.2)]  # photo
SHAFT_LEVELS = (67.0, 74.0, 81.5, 89.5, 98.0, 107.0, 116.5, 126.5, 137.0)  # bays grow upward (est.)

DECK_Z = 140.2                      # published (460 ft): floor of the enclosed, flaring cabin
BALCONY_Z = (143.5, 145.4)          # photo: the widest ring, the open balcony above the cabin
DECK_RADIUS = 6.0                   # photo (11.5 m across)
CAGE_RADIUS, CAGE_TOP_Z = 4.2, 150.5  # photo: caged level, rounding in to 153.5
CUPOLA_TOP_Z, DOME_TOP_Z, LANTERN_TOP_Z = 153.5, 157.0, 160.4  # photo: cage top, lantern drum, dome top

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from the daylight side photo
    "Iron": "A8957A",      # painted lattice
    "Trim": "B8A68C",      # platform cornices and brackets
    "Glass": "1E2428",     # restaurant glazing
    "Roof": "6A5F54",      # restaurant roof
    "Fascia": "4A4640",    # plain roof-edge band (no lettering)
    "Core": "5E5244",      # elevator core seen through the lattice
    "Screen": "9C8A70",    # cabin lattice screen at the top
    "Lantern": "D8CBB0",   # dome and beacon
}
ROUGHNESS = {"Glass": 0.3}

GOLD = (1.0, 0.70, 0.32)   # night photos: amber light under the restaurant and on the lower legs
CREAM = (1.0, 0.85, 0.50)  # the lattice above the restaurant is flood-lit a paler yellow gold
PALE = (1.0, 0.92, 0.72)   # brighter, whiter light at the cornices and the top


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Iron":
        if z < PLATFORM1[0]:   # legs and arches below the restaurant: dimmer, amber
            return kit.scaled(GOLD, 0.42)
        return kit.scaled(CREAM, 0.72 + 0.28 * min((z - 40.0) / 100.0, 1.0))  # brighter higher up
    if material == "Trim":
        if z < 36.0:           # bracket cornice under the restaurant, lit from below
            return kit.scaled(GOLD, 0.85)
        return kit.scaled(PALE, 1.1 if z < 100.0 else 1.25)
    if material == "Screen":
        return kit.scaled(PALE, 1.25)
    if material == "Lantern":  # the brightest thing on the tower
        return kit.scaled(PALE, 1.5)
    if material == "Core":
        return kit.scaled(GOLD, 0.12)
    if material == "Glass":    # dim dining room; the app adds lit windows
        return kit.scaled(GOLD, 0.03)
    if material == "Fascia":   # the lit roof-edge band, kept plain
        return (0.22, 0.24, 0.28)
    if material == "Roof":
        return kit.scaled(GOLD, 0.02)
    return (0.0, 0.0, 0.0)


# -------------------------------------------------------------------- helpers
def lattice(b: kit.Builder, quad_at, center_at, levels, chord: float, bar: float, material: str = "Iron") -> None:
    """An open four-sided truss: quad_at(z) gives its four corners, center_at(z) its axis. Corner chords, a girt
    at every level above the first, and an X on every face of every bay."""
    quads = [quad_at(z) for z in levels]
    centers = [center_at(z) for z in levels]

    def outward(p: kit.Point, c: kit.Point) -> kit.Point:
        return (p[0] - c[0], p[1] - c[1], 0.0)

    for (lower, upper, c) in zip(quads, quads[1:], centers):
        for i in range(4):
            j = (i + 1) % 4
            b.strut(lower[i], upper[i], chord, outward(lower[i], c), material)
            mid = tuple((lower[i][k] + lower[j][k]) / 2 for k in range(3))
            facing = outward(mid, c)
            b.strut(lower[i], upper[j], bar, facing, material)
            b.strut(lower[j], upper[i], bar, facing, material)
            b.strut(upper[i], upper[j], bar, facing, material)


def leg(bearing: float, z0: float, z1: float, bottom: tuple[float, float], top: tuple[float, float]):
    """quad_at / center_at for a leg leaning from (center radius, section radius) `bottom` at z0 to `top` at z1."""
    def at(z: float) -> tuple[float, float]:
        t = (z - z0) / (z1 - z0)
        return (bottom[0] + (top[0] - bottom[0]) * t, bottom[1] + (top[1] - bottom[1]) * t)

    def quad_at(z: float) -> list[kit.Point]:
        c, r = at(z)
        return [kit.polar(bearing, c + r, 0.0, z), kit.polar(bearing, c, r, z),
                kit.polar(bearing, c - r, 0.0, z), kit.polar(bearing, c, -r, z)]

    def center_at(z: float) -> kit.Point:
        return kit.polar(bearing, at(z)[0], 0.0, z)

    return quad_at, center_at


def square(radius: float, z: float) -> list[kit.Point]:
    return kit.circle(radius, z, 4)


def octagon(radius: float, z: float) -> list[kit.Point]:
    return kit.circle(radius, z, 8, math.pi / 8)


# --------------------------------------------------------------------- parts
def build_lower_legs(b: kit.Builder) -> None:
    for bearing in BEARINGS:
        quad_at, center_at = leg(bearing, 0.0, LEG1_TOP_Z, (FOOT_CENTER, FOOT_RADIUS),
                                 (LEG1_TOP_CENTER, LEG1_TOP_RADIUS))
        lattice(b, quad_at, center_at, (BURY, 9.0, 19.0, 28.5), chord=0.7, bar=0.4)


def face_ends(bearing: float, radius: float, z: float) -> tuple[kit.Point, kit.Point, kit.Point]:
    """Ends of a line along one face (between neighboring legs) and the outward direction of that face."""
    p0, p1 = kit.polar(bearing, radius, 0.0, z), kit.polar(bearing + 90.0, radius, 0.0, z)
    return p0, p1, (p0[0] + p1[0], p0[1] + p1[1], 0.0)


def along(p0: kit.Point, p1: kit.Point, t: float) -> kit.Point:
    return tuple(p0[k] + (p1[k] - p0[k]) * t for k in range(3))


def build_arches(b: kit.Builder) -> None:
    """One half-ellipse arch per face, between neighboring legs, and the lattice girder above it."""
    segments = 8
    z0, z1 = TRUSS_Z
    for bearing in BEARINGS:
        p0, p1, facing = face_ends(bearing, 27.0, 0.0)

        def point(s: float) -> kit.Point:
            t = 0.5 - 0.41 * math.cos(math.pi * s)
            x, y, _ = along(p0, p1, t)
            return (x, y, ARCH_SPRING_Z + (ARCH_CROWN_Z - ARCH_SPRING_Z) * math.sin(math.pi * s))

        for k in range(segments):
            b.strut(point(k / segments), point((k + 1) / segments), 0.6, facing, "Iron")

        lo0, lo1, _ = face_ends(bearing, 26.2, z0)
        hi0, hi1, _ = face_ends(bearing, 24.6, z1)
        b.strut(along(lo0, lo1, 0.08), along(lo0, lo1, 0.92), 0.4, facing, "Iron")
        panels = 4
        for k in range(panels):
            ta, tb = 0.10 + 0.80 * k / panels, 0.10 + 0.80 * (k + 1) / panels
            b.strut(along(lo0, lo1, ta), along(hi0, hi1, tb), 0.3, facing, "Iron")
            b.strut(along(lo0, lo1, tb), along(hi0, hi1, ta), 0.3, facing, "Iron")


def build_first_platform(b: kit.Builder) -> None:
    truss, cornice, deck, glass0, glass1, roof = PLATFORM1
    r = PLATFORM1_RADIUS
    b.loft([square(r - 3.0, truss), square(r - 1.5, cornice), square(r, deck), square(r, glass0)],
           ["Iron", "Trim", "Trim"])
    b.loft([square(r - 1.2, glass0), square(r - 1.2, glass1)], ["Glass"])
    b.loft([square(r - 0.3, glass1), square(r - 0.3, FASCIA_TOP_Z), square(r - 9.0, roof)], ["Fascia", "Roof"])


def build_upper_legs(b: kit.Builder) -> None:
    z0, z1 = LEG2_Z
    for bearing in BEARINGS:
        quad_at, center_at = leg(bearing, z0, z1, (LEG2_BOTTOM_CENTER, LEG2_BOTTOM_RADIUS),
                                 (LEG2_TOP_CENTER, LEG2_TOP_RADIUS))
        lattice(b, quad_at, center_at, (z0, 49.0, 57.0, z1 - 0.5), chord=0.55, bar=0.32)
    b.prism(3.2, z0, PLATFORM2_Z[0] + 0.5, 4, "Core")  # elevator core between the legs (night photo)
    lo, hi = BELT_Z
    for bearing in BEARINGS:   # gallery belt: two chords and a zigzag per face
        a0, a1, facing = face_ends(bearing, BELT_RADIUS + 0.5, lo)
        c0, c1, _ = face_ends(bearing, BELT_RADIUS - 0.5, hi)
        b.strut(a0, a1, 0.3, facing, "Iron")
        b.strut(c0, c1, 0.3, facing, "Iron")
        for k in range(4):
            ta, tb = 0.14 + 0.18 * k, 0.14 + 0.18 * (k + 1)
            lower, upper = (a0, a1), (c0, c1)
            first, second = (lower, upper) if k % 2 == 0 else (upper, lower)
            b.strut(along(*first, ta), along(*second, tb), 0.25, facing, "Iron")


def build_second_platform(b: kit.Builder) -> None:
    under, deck, top = PLATFORM2_Z
    r = PLATFORM2_RADIUS
    b.loft([square(r - 2.2, under), square(r, deck), square(r, top)], ["Trim", "Trim"])
    b.loft([square(r - 1.0, top), square(r - 1.0, top + 1.2)], ["Iron"])  # railing band


def build_shaft(b: kit.Builder) -> None:
    def quad_at(z: float) -> list[kit.Point]:
        return square(kit.lerp_table(SHAFT_RADIUS, z), z)

    lattice(b, quad_at, lambda z: (0.0, 0.0, z), SHAFT_LEVELS, chord=0.5, bar=0.3)
    z0, z1 = SHAFT_LEVELS[0], SHAFT_LEVELS[-1]
    b.prism(3.4, z0 + 1.3, z1 + 1.0, 4, "Core", radius_top=1.9)  # est.: core about a third of the shaft's width


def build_top(b: kit.Builder) -> None:
    base = SHAFT_LEVELS[-1]
    lo, hi = BALCONY_Z
    b.loft([octagon(4.3, base - 0.5), octagon(4.5, DECK_Z), octagon(DECK_RADIUS - 0.3, lo)],
           ["Iron", "Screen"])                                                       # enclosed cabin, flaring out
    b.loft([octagon(DECK_RADIUS, lo), octagon(DECK_RADIUS, hi)], ["Trim"])           # balcony, the widest ring
    cage = [(CAGE_RADIUS, hi), (CAGE_RADIUS, CAGE_TOP_Z), (CAGE_RADIUS - 0.5, CAGE_TOP_Z + 1.5),
            (CAGE_RADIUS - 1.5, CUPOLA_TOP_Z)]
    b.loft([octagon(r, z) for r, z in cage], "Screen")                               # cage with a rounded top
    b.loft([octagon(2.9, CUPOLA_TOP_Z), octagon(2.9, CUPOLA_TOP_Z + 0.5)], ["Trim"])  # ledge under the lantern
    b.loft([octagon(2.4, CUPOLA_TOP_Z + 0.5), octagon(2.3, DOME_TOP_Z)], ["Lantern"])  # lantern drum
    dome = [(2.6, 0.0), (2.4, 0.2), (1.8, 0.55), (1.0, 0.85), (0.45, 1.0)]
    b.loft([octagon(r, DOME_TOP_Z + t * (LANTERN_TOP_Z - DOME_TOP_Z)) for r, t in dome], "Lantern")
    b.prism(0.25, LANTERN_TOP_Z, HEIGHT, 4, "Iron", radius_top=0)                    # mast


PARTS = {"lower_legs": build_lower_legs, "arches": build_arches, "first_platform": build_first_platform,
         "upper_legs": build_upper_legs, "second_platform": build_second_platform, "shaft": build_shaft,
         "top": build_top}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("EiffelReplica")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
