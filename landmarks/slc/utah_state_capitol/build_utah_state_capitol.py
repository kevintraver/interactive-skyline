"""Low-poly model of the Utah State Capitol (Salt Lake City), built with landmark_kit.

Sources: height 87 m = project data (osm-height); plan = mapped footprint (footprint.json);
levels measured on refs/Utah_State_Capitol_Building_in_2022.jpg (facade plane 13.7 px/m, dome axis 9.6 px/m):
base 0-5.5 m, columns 5.5-18 m, entablature to 21 m, balustrade 24 m, pediment apex 26.5 m; drum plinth 36-41.5 m,
drum colonnade 41.5-52.5 m (cornice 33 m across), attic drum 55-64 m (28 m across), copper dome 64-78.3 m
(24 m across), lantern to 87 m. Column spacing (about 4.2-4.5 m) counted on the same photo.
No signage or flags modeled.
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "utah_state_capitol"
MAX_TRIS = 5_000
BURY = -2.0
HEIGHT = 87.0

COLORS = {
    "Granite": "E6E2D6",   # pale granite, from daylight photos
    "Base": "CDC8BB",      # rusticated ground floor
    "Column": "F3F0E7",
    "Wall": "A3A39D",      # recessed wall behind the colonnade (in shade, rows of windows)
    "Copper": "6F7B74",    # weathered grey-green dome
    "Gold": "EFEBDD",      # lantern stone, lit from inside at night
    "Roof": "8E8B84",
}
ROUGHNESS = {"Copper": 0.5}
WINDOWS = {"Wall": 0.6}
WARM = (1.0, 0.80, 0.48)      # facade floodlights
WHITE = (1.0, 0.90, 0.70)     # drum, the brightest part
DRUM_Z = 35.0
CX, CY = 0.0, -1.4            # dome axis

Z_BASE, Z_COL, Z_ENT, Z_BAL = 5.5, 18.0, 21.0, 24.0
COL_R = 0.7


def glow(material, point, center):
    high = point[2] > DRUM_Z
    if material == "Wall":
        return kit.scaled(WHITE, 0.95) if high else kit.scaled(WARM, 0.55)
    if material == "Column":
        return kit.scaled(WHITE, 0.6) if high else kit.scaled(WARM, 0.32)
    if material == "Granite":
        return kit.scaled(WHITE, 0.7) if high else kit.scaled(WARM, 0.16)
    if material == "Base":
        return kit.scaled(WARM, 0.10)
    if material == "Copper":
        return kit.scaled(WHITE, 0.05)
    if material == "Gold":
        return kit.scaled(WHITE, 1.0)
    return (0.0, 0.0, 0.0)


def gable(b, center, half_w, depth, z0, z_apex, material, roof, turn_deg=0.0):
    """A triangular roof prism: gable face `half_w` either side of `center`, running `depth` back from it."""
    a = math.radians(turn_deg)
    ca, sa = math.cos(a), math.sin(a)

    def vert(u, v, z):
        return b.bm.verts.new((center[0] + u * ca - v * sa, center[1] + u * sa + v * ca, z))
    a0, b0, c0 = vert(-half_w, 0, z0), vert(half_w, 0, z0), vert(0, 0, z_apex)
    a1, b1, c1 = vert(-half_w, depth, z0), vert(half_w, depth, z0), vert(0, depth, z_apex)
    b.face((a0, b0, c0), material)
    b.face((b1, a1, c1), material)
    b.face((a0, a1, b1, b0), material)
    b.face((a0, c0, c1, a1), roof)
    b.face((b0, b1, c1, c0), roof)


def column_row(b, start, end, count, z0=Z_BASE, z1=Z_COL, radius=COL_R):
    for k in range(count):
        t = k / (count - 1)
        b.prism(radius, z0, z1, 6, "Column",
                center=(start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t))


def build_block(b, vols):
    main = vols[1]["outline"]
    b.extrude(main, BURY, Z_BASE, "Base", top="Granite")
    b.extrude(kit.offset_polygon(main, -2.6), Z_BASE, Z_COL, "Wall")           # recessed wall, 2.6 m behind columns
    b.extrude(main, Z_COL, Z_ENT, "Granite")                                   # entablature
    b.extrude(kit.offset_polygon(main, 0.7), Z_ENT - 0.9, Z_ENT, "Column")     # cornice
    b.extrude(kit.offset_polygon(main, -0.6), Z_ENT, Z_BAL, "Granite", top="Roof")  # balustrade / attic
    # low roof volumes behind the balustrade (chambers, north wing) and the central block under the drum
    for i in (4, 5, 8):
        b.extrude(vols[i]["outline"], Z_BAL - 1.0, 26.0, "Granite", top="Roof")
    b.extrude(vols[3]["outline"], Z_BAL - 1.0, 31.0, "Granite", top="Roof")
    for sx in (-1, 1):
        for y in (-24.9, 21.5):                                                # corner piers closing each colonnade
            b.block((sx * 58.2, y), 1.6, 1.6, Z_BASE, Z_COL, "Granite")
        column_row(b, (sx * 20.6, -25.6), (sx * 54.2, -25.6), 9)               # long south colonnade, 4.2 m apart
        column_row(b, (sx * 22.4, 22.2), (sx * 54.2, 22.2), 8)                 # north
        b.block((sx * 17.7, 29.4), 1.1, 6.3, Z_BASE, Z_COL, "Granite")         # piers closing the north center
    column_row(b, (-15.6, 34.9), (15.6, 34.9), 8)                              # north center


def build_porticos(b):
    # south portico: 34 m wide, 8 columns, pediment to 26.5 m with its roof running back to the central block
    b.block((0.0, -28.85), 17.0, 2.45, BURY, Z_BASE, "Base", top="Granite")
    column_row(b, (-15.75, -30.4), (15.75, -30.4), 8)
    b.block((0.0, -28.85), 17.0, 2.45, Z_COL, Z_ENT, "Granite")
    b.block((0.0, -28.85), 17.6, 3.05, Z_ENT - 0.9, Z_ENT, "Column")
    gable(b, (0.0, -31.9), 17.6, 14.0, Z_ENT, 26.5, "Column", "Roof")
    for k, top in enumerate((4.0, 2.2)):                                       # grand stair, two broad flights
        b.block((0.0, -32.8 - 3.0 * k), 10.0, 1.5, BURY, top, "Base")
    # east and west end porticos: 32 m wide, 8 columns, balustrade carried round (no pediment in the photos)
    for sx in (1, -1):
        x = sx * 61.1
        b.block((x, -1.5), 1.35, 16.0, BURY, Z_BASE, "Base", top="Granite")
        column_row(b, (sx * 61.6, -16.2), (sx * 61.6, 13.2), 8)
        b.block((x, -1.5), 1.35, 16.0, Z_COL, Z_ENT, "Granite")
        b.block((x, -1.5), 1.95, 16.6, Z_ENT - 0.9, Z_ENT, "Column")
        b.block((x, -1.5), 1.35, 15.4, Z_ENT, Z_BAL, "Granite", top="Roof")


def ring(b, r0, z0, z1, material, r1=None, seg=24):
    b.prism(r0, z0, z1, seg, material, radius_top=r1, center=(CX, CY))


def build_dome(b, vols):
    b.extrude(vols[0]["outline"], 30.0, 36.5, "Granite", top="Roof")   # square base of the drum
    ring(b, 17.0, 36.0, 40.0, "Granite", r1=16.2)                      # stepped round plinth
    ring(b, 15.8, 40.0, 41.5, "Granite")
    ring(b, 12.2, 41.5, 52.5, "Wall")                                  # drum wall behind the colonnade
    for k in range(24):                                                # 24 columns, 11 m tall
        a = 2 * math.pi * (k + 0.5) / 24
        b.prism(0.62, 41.5, 52.5, 6, "Column", center=(CX + 14.7 * math.cos(a), CY + 14.7 * math.sin(a)))
    ring(b, 15.7, 52.5, 54.2, "Granite")                               # entablature
    ring(b, 16.5, 54.2, 55.0, "Column")                                # cornice, 33 m across
    ring(b, 14.9, 55.0, 56.6, "Column")                                # balustrade
    ring(b, 13.8, 55.0, 63.0, "Granite")                               # attic drum, 28 m across
    ring(b, 14.3, 63.0, 64.0, "Column")                                # attic cornice
    # copper dome: 24 m across, a little taller than a hemisphere
    prof = [(12.2 * math.cos(math.radians(t)), 64.0 + 14.9 * math.sin(math.radians(t)))
            for t in (0, 14, 28, 42, 56, 68)]
    prof.append((3.5, 78.3))
    b.loft([kit.circle(r, z, 24, 0.0, (CX, CY)) for r, z in prof], ["Copper"] * (len(prof) - 1))
    # lantern: balustraded platform, lit open drum, small copper cap, light at the top
    ring(b, 3.7, 78.3, 79.3, "Column", seg=12)
    ring(b, 2.5, 79.3, 83.3, "Gold", seg=12)
    ring(b, 3.1, 83.3, 83.9, "Column", seg=12)
    ring(b, 2.7, 83.9, 85.9, "Copper", r1=0.9, seg=12)
    ring(b, 0.55, 85.9, HEIGHT, "Gold", r1=0.0, seg=8)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    build_block(b, vols)
    build_porticos(b)
    build_dome(b, vols)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Utah_State_Capitol")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
