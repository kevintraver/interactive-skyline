"""Low-poly model of the Utah State Capitol (Salt Lake City), built with landmark_kit.

Sources: height 87 m = project data (osm-height); plan and volume tops = mapped footprint (footprint.json);
dome drum/dome/lantern split (drum to ~58 m, dome to 77 m, lantern to 87 m) estimated from refs photos
(Utah_State_Capitol_Building_in_2022.jpg elevation, dome-at-night photo). Colonnade spacing, column size,
cornice are estimated. No signage or flags modeled.
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
    "Granite": "EAE6DA",   # pale granite, from daylight photos
    "Base": "B8B3A6",
    "Column": "F4F1E8",
    "Arcade": "8A7656",    # recessed bay behind columns
    "Copper": "7F8F84",    # green-grey dome
    "Gold": "B89A4E",
    "Roof": "8E8B84",
}
ROUGHNESS = {"Copper": 0.5}
WINDOWS = {}
WARM = (1.0, 0.78, 0.45)


def glow(material, point, center):
    z = point[2]
    if material == "Arcade":
        return kit.scaled(WARM, 0.75)
    if material == "Column":
        return kit.scaled(WARM, 0.30 if z < 30 else 0.45)
    if material == "Granite":
        return kit.scaled(WARM, 0.12 + (0.25 if z > 38 else 0.0))
    if material == "Base":
        return kit.scaled(WARM, 0.15)
    if material == "Copper":
        return kit.scaled(WARM, 0.18 + 0.2 * (z - 58) / 20)
    if material == "Gold":
        return kit.scaled(WARM, 0.9)
    return (0.0, 0.0, 0.0)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    # wings and pavilions: volumes 1,3..8,11..13 (all low, 25-35 m)
    for i in (1, 3, 4, 5, 6, 7, 8, 11, 12, 13):
        v = vols[i]
        b.extrude(v["outline"], BURY, v["top"], "Granite", top="Roof")
    # plinth band around the main wing
    b.extrude(vols[1]["outline"], BURY, 4.0, "Base", top="Granite")
    # cornice cap on main wing
    b.extrude(kit.scale_polygon(vols[1]["outline"], 1.01), 25.0, 26.2, "Column", top="Roof")
    # colonnades: south and north faces of the long wing, east/west wing fronts
    def colonnade(x0, x1, y, outward, z0, z1, step, w=1.5):
        n = max(2, int(round((x1 - x0) / step)))
        b.block(((x0 + x1) / 2, y), (x1 - x0) / 2, 0.4, z0, z1, "Arcade")  # recessed warm bay
        for k in range(n + 1):
            x = x0 + (x1 - x0) * k / n
            b.block((x, y + outward * 1.2), w / 2, w / 2, z0, z1, "Column")
    colonnade(-58.0, 58.0, -26.5, -1, 4.0, 24.0, 4.0)
    colonnade(-17.0, 17.0, -31.3, -1, 4.0, 30.0, 3.4, 1.0)
    colonnade(-17.0, 17.0, 14.8, 1, 35.0 - 12.0, 34.0, 4.0)
    colonnade(-38.0, -18.0, -18.6, -1, 4.0, 32.0, 4.0)
    colonnade(18.0, 38.0, -18.85, -1, 4.0, 32.0, 4.0)
    # central pediment block on the south portico
    b.block((0.0, -31.4), 17.0, 0.8, 30.0, 33.5, "Column", top="Roof")
    # rotunda, drum, dome, lantern (polygons are round: use circular rings)
    b.prism(15.0, BURY, 42.0, 20, "Granite", center=(-0.0, -1.4))
    b.prism(15.6, 42.0, 43.5, 20, "Column", center=(0.0, -1.4))
    b.prism(12.3, 43.5, 58.0, 20, "Granite", center=(0.0, -1.4))
    for k in range(16):
        a = 2 * math.pi * k / 16
        b.block((0.0 + 13.2 * math.cos(a), -1.4 + 13.2 * math.sin(a)), 0.55, 0.55, 44.0, 57.0, "Column",
                turn_deg=math.degrees(a))
    b.prism(13.8, 57.0, 58.6, 20, "Column", center=(0.0, -1.4))
    # dome and lantern about the dome axis
    cx, cy = 0.0, -1.4
    prof = [(12.8, 58.6, "Copper"), (12.6, 62.0, "Copper"), (11.2, 67.0, "Copper"), (8.6, 72.0, "Copper"),
            (4.6, 76.0, "Copper"), (3.6, 77.0, "Copper"), (3.6, 77.0, "Gold")]
    pts = [(r, z, m) for r, z, m in prof[:-1]] + [(3.6, 77.0, "Copper")]
    b.revolve([(12.8, 58.6, "Copper"), (12.6, 62.0, "Copper"), (11.2, 67.0, "Copper"),
               (8.6, 72.0, "Copper"), (4.6, 76.0, "Copper"), (3.4, 77.0, "Copper")], 20)
    b.prism(3.0, 77.0, 81.0, 12, "Column", center=(cx, cy))
    b.prism(3.4, 81.0, 81.8, 12, "Column", center=(cx, cy))
    b.prism(2.2, 81.8, 83.5, 12, "Gold", radius_top=1.2, center=(cx, cy))
    b.prism(0.8, 83.5, HEIGHT, 8, "Gold", radius_top=0.0, center=(cx, cy))


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Utah_State_Capitol")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
