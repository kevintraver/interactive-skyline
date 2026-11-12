"""Build the Bellagio fountain data file for interactive-skyline from OpenStreetMap data.

    python make_fountain.py LAKE_OSM.json NOZZLES_OSM.json OUT.json

LAKE_OSM.json: Overpass `out geom` result holding the lake way (natural=water, "Fountains of Bellagio",
way 22971030); NOZZLES_OSM.json: the 250 nozzle nodes of relation 19511963 (fountain=nozzle).
The mapped nozzles trace the layout: a long curved front line, two concentric rings in the middle and two
small rings north and south. They are fitted (circles by RANSAC, the rest as a smoothed curve) and then
filled with the real show's 1,214 nozzles in their published types (Wikipedia, "Fountains of Bellagio"):
208 oarsmen (77 ft), 798 mini-shooters (100 ft), 192 super-shooters (240 ft), 16 extreme-shooters (460 ft).
Coordinates are meters east and north of the Las Vegas origin, the same transverse Mercator approximation
as `skyline_tool.py locate`.
"""
import json
import math
import random
import sys

ORIGIN = {"lat": 36.1147, "lon": -115.1728}
A, E2 = 6378137.0, 6.69437999014e-3
PHI = math.radians(ORIGIN["lat"])
W = math.sqrt(1 - E2 * math.sin(PHI) ** 2)
N_RADIUS, M_RADIUS = A / W, A * (1 - E2) / W ** 3
FT = 0.3048
TYPES = [  # name, count, height m
    ("oarsman", 208, 77 * FT), ("mini-shooter", 798, 100 * FT),
    ("super-shooter", 192, 240 * FT), ("extreme-shooter", 16, 460 * FT)]


def local(lat, lon):
    return (math.radians(lon - ORIGIN["lon"]) * N_RADIUS * math.cos(PHI),
            math.radians(lat - ORIGIN["lat"]) * M_RADIUS)


def circle3(p, q, r):
    ax, ay = p
    bx, by = q
    cx, cy = r
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, math.dist((ux, uy), p)


def solve(m, v):
    n = len(v)
    m = [row[:] + [v[i]] for i, row in enumerate(m)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(m[r][i]))
        m[i], m[p] = m[p], m[i]
        for r in range(n):
            if r != i:
                f = m[r][i] / m[i][i]
                m[r] = [a - f * b for a, b in zip(m[r], m[i])]
    return [m[i][n] / m[i][i] for i in range(n)]


def fit_circle(pts):
    """Least-squares circle (x^2 + y^2 + Dx + Ey + F = 0) through points."""
    rows = [[p[0], p[1], 1.0] for p in pts]
    rhs = [-(p[0] ** 2 + p[1] ** 2) for p in pts]
    ata = [[sum(r[i] * r[j] for r in rows) for j in range(3)] for i in range(3)]
    atb = [sum(r[i] * b for r, b in zip(rows, rhs)) for i in range(3)]
    d, e, f = solve(ata, atb)
    cx, cy = -d / 2, -e / 2
    return cx, cy, math.sqrt(cx * cx + cy * cy - f)


def ransac_circles(pts, count, tol=0.7):
    rng = random.Random(7)
    rest, circles = list(pts), []
    for _ in range(count):
        best = None
        for _ in range(6000):
            c = circle3(*rng.sample(rest, 3))
            if not c or not 5 < c[2] < 45:
                continue
            inl = [p for p in rest if abs(math.dist(p, c[:2]) - c[2]) < tol]
            if best is None or len(inl) > len(best[1]):
                best = (c, inl)
        c = fit_circle(best[1])
        inl = [p for p in rest if abs(math.dist(p, c[:2]) - c[2]) < tol]
        circles.append({"center": [round(c[0], 2), round(c[1], 2)], "radius": round(c[2], 2), "mapped": len(inl)})
        rest = [p for p in rest if p not in inl]
    return circles, rest


def smooth_curve(pts):
    """Order the front-line nozzles along their main axis and fit a cubic for the offset across it."""
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ax, ay = math.cos(ang), math.sin(ang)
    st = [((p[0] - mx) * ax + (p[1] - my) * ay, -(p[0] - mx) * ay + (p[1] - my) * ax) for p in pts]
    x = [[1, s, s * s, s ** 3] for s, _ in st]
    y = [o for _, o in st]
    xtx = [[sum(r[i] * r[j] for r in x) for j in range(4)] for i in range(4)]
    xty = [sum(r[i] * b for r, b in zip(x, y)) for i in range(4)]
    coef = solve(xtx, xty)
    lo, hi = min(s for s, _ in st), max(s for s, _ in st)
    resid = max(abs(o - sum(c * s ** i for i, c in enumerate(coef))) for s, o in st)
    dense, s = [], lo
    while s <= hi + 1e-6:
        o = sum(c * s ** i for i, c in enumerate(coef))
        dense.append((mx + s * ax - o * ay, my + s * ay + o * ax))
        s += 0.25
    total = sum(math.dist(a, b) for a, b in zip(dense, dense[1:]))
    return dense, total, resid


def along_polyline(poly, u):
    """Point and unit tangent at fraction u of a polyline's length."""
    lens = [math.dist(a, b) for a, b in zip(poly, poly[1:])]
    target, acc = u * sum(lens), 0.0
    for i, l in enumerate(lens):
        if acc + l >= target or i == len(lens) - 1:
            a, b = poly[i], poly[i + 1]
            k = min(max((target - acc) / l, 0.0), 1.0)
            return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k), ((b[0] - a[0]) / l, (b[1] - a[1]) / l)
        acc += l
    raise ValueError("empty polyline")


def main(lake_path, nozzles_path, out_path):
    lake_doc = json.load(open(lake_path, encoding="utf-8"))
    way = next(e for e in lake_doc["elements"] if e["type"] == "way" and e.get("tags", {}).get("natural") == "water")
    lake = [local(p["lat"], p["lon"]) for p in way["geometry"]]
    if lake[0] == lake[-1]:
        lake = lake[:-1]
    nodes = [local(e["lat"], e["lon"]) for e in json.load(open(nozzles_path, encoding="utf-8"))["elements"]
             if e.get("tags", {}).get("fountain") == "nozzle"]
    circles, line_pts = ransac_circles(nodes, 4)
    circles.sort(key=lambda c: -c["radius"])
    curve, line_len, resid = smooth_curve(line_pts)
    if curve[0][1] < curve[-1][1]:  # run the line from north to south
        curve = curve[::-1]
    lake_c = (sum(p[0] for p in lake) / len(lake), sum(p[1] for p in lake) / len(lake))
    figures = [{"kind": "line", "length": round(line_len, 1), "mapped": len(line_pts), "fit_residual_m": round(resid, 2)}]
    for c in circles:
        figures.append({"kind": "ring", **c, "length": round(2 * math.pi * c["radius"], 1)})
    lengths = [f["length"] for f in figures]
    total_len = sum(lengths)
    # oarsmen all on the front line (they sweep along it); extreme-shooters 10 on the line and 6 on the
    # outer ring; mini- and super-shooters shared by length
    share = {0: [208, 0, 0, 0, 0], 3: [10, 6, 0, 0, 0]}
    for t in (1, 2):
        count = TYPES[t][1]
        raw = [count * l / total_len for l in lengths]
        alloc = [int(v) for v in raw]
        for i in sorted(range(len(raw)), key=lambda i: raw[i] - alloc[i], reverse=True)[:count - sum(alloc)]:
            alloc[i] += 1
        share[t] = alloc
    rng = random.Random(11)
    jets = []
    for fig_i, fig in enumerate(figures):
        kinds = []
        for t in range(4):
            n = share[t][fig_i]
            kinds += [((k + 0.5) / n, t) for k in range(n)]
        kinds.sort()
        for u, t in kinds:
            if fig["kind"] == "line":
                (e, n), (te, tn) = along_polyline(curve, u)
                ne, nn = tn, -te
                if ne < 0:  # the normal points east, toward the boulevard and the crowds
                    ne, nn = -ne, -nn
            else:
                a = 2 * math.pi * u
                ce, cn = fig["center"]
                ne, nn = math.cos(a), math.sin(a)
                e, n = ce + fig["radius"] * ne, cn + fig["radius"] * nn
                te, tn = -nn, ne
            jets.append([round(e, 2), round(n, 2), t, fig_i, round(u, 4), round(te, 3), round(tn, 3),
                         round(ne, 3), round(nn, 3), round(rng.random(), 3)])
    counts = [sum(1 for j in jets if j[2] == t) for t in range(4)]
    doc = {
        "version": 1,  # bump when the data changes; install replaces older copies
        "name": "Fountains of Bellagio",
        "city": "lv",
        "building": "w25723909",
        "frame": "meters east and north of the city origin (transverse Mercator about it, as skyline_tool.py locate)",
        "sources": {
            "lake": "OpenStreetMap way 22971030 (natural=water, Fountains of Bellagio)",
            "layout": "OpenStreetMap relation 19511963: 250 mapped nozzles (fountain=nozzle), fitted as one curved "
                      "line and four rings",
            "nozzles": "Wikipedia, Fountains of Bellagio: 1,214 nozzles; 208 oarsmen (77 ft), 798 mini-shooters "
                       "(100 ft), 192 super-shooters (240 ft), 16 extreme-shooters (460 ft); 4,792 lights",
            "license": "Map data (c) OpenStreetMap contributors, ODbL 1.0",
        },
        "lake": [[round(x, 2), round(y, 2)] for x, y in lake],
        "center": [round(lake_c[0], 1), round(lake_c[1], 1)],
        "radius": round(max(math.dist(p, lake_c) for p in lake), 1),
        "types": [{"name": n, "count": c, "height": round(h, 1)} for (n, _, h), c in zip(TYPES, counts)],
        "figures": figures,
        "line": [[round(x, 2), round(y, 2)] for x, y in curve[::8]],
        "jet_fields": ["east", "north", "type", "figure", "u", "tangent_e", "tangent_n", "normal_e", "normal_n", "seed"],
        "jets": jets,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(json.dumps({k: doc[k] for k in ("center", "radius", "types", "figures")}, indent=1))
    print("jets", len(jets), "; line fitted from", len(line_pts), "points; residual", round(resid, 2))


if __name__ == "__main__":
    main(*sys.argv[1:4])
