"""Low-poly model of the McIntyre Building (Salt Lake City), built procedurally with landmark_kit.
No logos or signage modeled (the name lettering on the entrance and cornice is left plain).
Sources:
  - height 36.8 m, 8 floors: project data (lidar). Plan: mapped footprint (footprint.json), 42 x 16 m.
  - Look (gray terracotta/stone facade, pier-and-window-band rhythm, dark storefront base, projecting dark
    cornice): refs/McIntyre_Building_2_.jpg and _3_.jpg (Commons, CC BY-SA 4.0). Floor heights, base height,
    cornice size and pier spacing are estimated from those photos.
"""
import importlib, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "mcintyre_building"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 36.8          # project data (lidar)
BASE_TOP = 4.5         # storefront base (est.)
CORNICE_Z = 35.8       # cornice starts (est.); roof at HEIGHT
FLOORS = 7             # upper floors between base and cornice (est.)
XW, YW = 21.0, 8.1     # footprint half sizes (footprint.json)

COLORS = {"Wall": "A29A8E", "Base": "2E3A36", "Pier": "B3AB9D", "Cornice": "3A3733", "Glass": "3C4B58", "Roof": "6E6B68"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Base":
        return kit.scaled(WARM, 0.25)
    if material in ("Wall", "Pier"):
        return kit.scaled(WARM, 0.06 + 0.12 * math.exp(-max(point[2], 0.0) / 15.0))
    if material == "Cornice":
        return kit.scaled(WARM, 0.08)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(fp, BURY, BASE_TOP, "Base")
    b.extrude(fp, BASE_TOP, CORNICE_Z, "Wall")
    # projecting cornice
    b.extrude(kit.offset_polygon(fp, 0.7), CORNICE_Z, HEIGHT, "Cornice", top="Roof")


def build_facade(b):
    fh = (CORNICE_Z - BASE_TOP) / FLOORS
    # glass window bands and piers on the long (north/south) faces and the ends
    for sy in (1, -1):
        n = 9
        w = 2 * XW / n
        for i in range(n):
            cx = -XW + w * (i + 0.5)
            for f in range(FLOORS):
                z0 = BASE_TOP + f * fh + 0.8
                b.block((cx, sy * (YW + 0.1)), w * 0.5 - 0.5, 0.15, z0, z0 + fh - 1.5, "Glass")
        for i in range(n + 1):
            cx = -XW + w * i
            b.block((cx, sy * (YW + 0.2)), 0.35, 0.3, BASE_TOP, CORNICE_Z, "Pier")
    for sx in (1, -1):
        n = 4
        w = 2 * YW / n
        for i in range(n):
            cy = -YW + w * (i + 0.5)
            for f in range(FLOORS):
                z0 = BASE_TOP + f * fh + 0.8
                b.block((sx * (XW + 0.1), cy), 0.15, w * 0.5 - 0.5, z0, z0 + fh - 1.5, "Glass")
        for i in range(n + 1):
            cy = -YW + w * i
            b.block((sx * (XW + 0.2), cy), 0.3, 0.35, BASE_TOP, CORNICE_Z, "Pier")
    # string course above the base
    b.block((0.0, 0.0), XW + 0.35, YW + 0.35, BASE_TOP, BASE_TOP + 0.5, "Cornice")


PARTS = {"body": build_body, "facade": build_facade}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
