# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: build_roads.py <city>

Build the drive's roads from OpenStreetMap (fetched by fetch_osm.py) and the terrain the app
draws. For each route in the city's "routes" (data/cities.json): stitch the directional route
relation between the route's start and end, fit a smoothing spline held within 0.5 m of the OSM
nodes, resample it to 4 m stations, set the profile on top of the terrain (never below it under
the pavement, grade at most 6%), and split it into lane sections, speed zones, bridges and
exits. The opposite carriageway between the same two ends is built the same way, as scenery.
Then the reveal: where the target building's top first clears the terrain for an eye 1.2 m
above the lane.

The format of roadnet.json and roadnet.bin is specified at the top of
src/drive/roadnet/format.js. The script checks its acceptance numbers, writes them to the
report and exits non-zero when one is missed (the outputs are still written, to look at).

Output: public/data/<city>/roadnet.json, roadnet.bin, routes.json
        data/derived/<city>/roads_report.json
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.alignment import fit_line, stations  # noqa: E402
from lib.frame import create_frame, curve_drop  # noqa: E402
from lib.ground import drawn_surface  # noqa: E402
from lib.heights import load_heights  # noqa: E402
from lib.osm import exit_links, junctions, load_osm, mph, route_relations, stitch  # noqa: E402
from lib.profile import envelope, smooth_from_above  # noqa: E402
from lib.refline import Refline  # noqa: E402
from lib.roadnet import decode_roadnet, encode_roadnet  # noqa: E402
from lib.sightline import building_top, eye_scene_y, visible  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SPACING = 4.0
LANE_W = 3.66
SHOULDER_WIDE, SHOULDER_NARROW = 3.05, 1.22
CLEARANCE = 0.3  # m of pavement above the highest ground under it
MARGIN = 2.0  # m beyond the outer shoulder edges that must also be cleared
GRADE = 0.06
GRADE_SOLVE = 0.0595  # the solver aims a little inside the limit: the runtime's Hermite overshoots between stations
COMFORT = 0.3  # m/s^2 vertical acceleration at the posted speed sets the vertical-curve radius
CROWN = 0.02  # 2% falling to the right on tangents
E_MAX, F_SIDE = 0.08, 0.10  # superelevation cap and side friction for the curve rule
EYE = 1.2
LEAD_SECONDS = 70  # starts.reveal: this long before the reveal at the posted speed
MPH = 0.44704
OPPOSITE = {"north": "south", "south": "north", "east": "west", "west": "east"}

# acceptance
EXPECT_LENGTH = {"i15n": 68400}
LENGTH_TOL = 0.005
EXPECT_EXITS = {"i15n": ["1", "12", "25", "27", "33", "36", "38", "39", "40", "41", "42"]}
EXPECT_REVEAL = {"i15n": (42800, 1500)}
NODE_TOL, NODE_SHARE = 0.5, 0.95
MAX_BYTES = 1.5e6


def rnd(v, nd=1):
    """Round for the JSON files; integral values come out as ints."""
    v = round(float(v), nd)
    return int(v) if v == int(v) else v


def runs(breaks, length):
    """[(s0, value)] in order -> merged runs [(s0, s1, value)] clipped to [0, length]."""
    out = []
    for k, (s0, v) in enumerate(breaks):
        s1 = breaks[k + 1][0] if k + 1 < len(breaks) else length
        s0, s1 = max(0.0, s0), min(length, s1)
        if s1 <= s0:
            continue
        if out and out[-1][2] == v:
            out[-1] = (out[-1][0], s1, v)
        else:
            out.append((s0, s1, v))
    if out:
        out[0] = (0.0, out[0][1], out[0][2])
        out[-1] = (out[-1][0], length, out[-1][2])
    return out


def absorb_short(rs, min_len):
    """Merge runs shorter than min_len into their longer neighbour."""
    rs = list(rs)
    changed = True
    while changed and len(rs) > 1:
        changed = False
        for k, (s0, s1, v) in enumerate(rs):
            if s1 - s0 >= min_len:
                continue
            if k == 0:
                j = 1
            elif k == len(rs) - 1:
                j = k - 1
            else:
                j = k - 1 if rs[k - 1][1] - rs[k - 1][0] >= rs[k + 1][1] - rs[k + 1][0] else k + 1
            a, b = min(k, j), max(k, j)
            keep = rs[j][2]
            rs[a:b + 1] = [(rs[a][0], rs[b][1], keep)]
            changed = True
            break
    # neighbours may now be equal
    out = []
    for r in rs:
        if out and out[-1][2] == r[2]:
            out[-1] = (out[-1][0], r[1], r[2])
        else:
            out.append(r)
    return out


def shoulders(tags, lanes):
    """Left and right shoulder widths: the format's defaults unless OSM says there is none."""
    left = SHOULDER_WIDE if lanes >= 3 else SHOULDER_NARROW
    right = SHOULDER_WIDE
    sh = tags.get("shoulder")
    if sh == "no":
        left = right = 0.0
    elif sh == "left":
        right = 0.0
    elif sh == "right":
        left = 0.0
    if tags.get("shoulder:left") == "no":
        left = 0.0
    if tags.get("shoulder:right") == "no":
        right = 0.0
    return left, right


def placement_ok(p, lanes):
    m = re.fullmatch(r"(left_of|middle_of|right_of):(\d+)", p or "")
    return p == "centre" or bool(m and 1 <= int(m.group(2)) <= lanes)


def left_edge(placement, lanes):
    """Offset of lane 1's left edge from the reference line (crosssection.js leftEdgeOffset)."""
    total = lanes * LANE_W
    if placement == "centre":
        return total / 2
    kind, n = placement.split(":")
    n = int(n)
    before = (n - 1) * LANE_W
    return {"left_of": before, "middle_of": before + LANE_W / 2, "right_of": before + LANE_W}[kind]


def crossfall_rule(curvature, speed_mph):
    """2% falling to the right on tangents and gentle curves; on curves the AASHTO-style rule
    e = e_max * Rmin / R, banked into the curve. A left curve keeps the normal crown until it
    needs half of it, then the adverse crown is rolled out until it banks at 2%, then follows e.
    Positive crossfall means the left edge is higher (format.js)."""
    v = speed_mph * MPH
    r_min = v * v / (9.81 * (E_MAX + F_SIDE))
    e = np.minimum(E_MAX, E_MAX * r_min * np.abs(curvature))
    c_right = np.maximum(CROWN, e)  # bank to the right: left edge higher
    half = CROWN / 2
    c_left = np.where(e <= half, CROWN, np.where(e < CROWN, CROWN - 4 * (e - half), -e))
    return np.where(curvature < 0, c_right, c_left)


def smooth(a, n):
    """Moving average over n stations, ends held."""
    if n <= 1:
        return a
    k = np.ones(n) / n
    pad = np.r_[np.full(n // 2, a[0]), a, np.full(n - 1 - n // 2, a[-1])]
    return np.convolve(pad, k, mode="valid")


def exit_label(osm, nid, links):
    """A plain label for an exit: the junction's name or destination, else its exit link's."""
    t = osm.nodes[nid][2]
    for src in [t] + [osm.ways[w]["tags"] for w in links]:
        for key in ("name", "destination", "destination:street", "destination:ref"):
            if src.get(key):
                parts = [p.strip() for p in src[key].split(";") if p.strip()]
                return " / ".join(parts[:2])
    return None


def exit_ref(osm, nid, links):
    t = osm.nodes[nid][2]
    if t.get("ref"):
        return t["ref"]
    for w in links:
        if osm.ways[w]["tags"].get("junction:ref"):
            return osm.ways[w]["tags"]["junction:ref"]
    return ""


def exit_text(osm, nid, links):
    """Everything an exit says about where it goes, for matching place names."""
    srcs = [osm.nodes[nid][2]] + [osm.ways[w]["tags"] for w in links]
    return " ".join(s.get(k, "") for s in srcs for k in ("name", "destination", "destination:ref", "destination:street"))


def build_road(osm, frame, hs, top, road_id, ref, direction, start, end):
    """One carriageway between two ends. Returns (road dict for the writer, info for the report)."""
    to_local = frame.to_local
    sxy = tuple(float(v) for v in to_local(start["lat"], start["lon"]))
    exy = tuple(float(v) for v in to_local(end["lat"], end["lon"]))
    rels = route_relations(osm, ref, direction)
    if not rels:
        raise ValueError(f"no {ref} {direction} route relation in the OSM data")
    chain = stitch(osm, rels, sxy, to_local, stop_xy=exy)
    lat, lon = osm.latlon(chain.node_ids)
    x, y = to_local(lat, lon)
    P = np.column_stack([x, y])
    a = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]

    def poly_project(q):
        best = (np.inf, 0.0)
        for k in range(len(P) - 1):
            ab = P[k + 1] - P[k]
            t = np.clip(np.dot(np.asarray(q) - P[k], ab) / max(np.dot(ab, ab), 1e-12), 0, 1)
            d = np.hypot(*(np.asarray(q) - P[k] - t * ab))
            if d < best[0]:
                best = (d, a[k] + t * (a[k + 1] - a[k]))
        return best

    d_s, a_s = poly_project(sxy)
    d_e, a_e = poly_project(exy)
    if a_e <= a_s:
        raise ValueError(f"{road_id}: the end comes before the start along the stitched line")
    if d_s > 200 or d_e > 200:
        raise ValueError(f"{road_id}: an end is {max(d_s, d_e):.0f} m off the stitched line")
    # the nodes from 400 m before the start to 400 m after the end
    i0 = max(0, int(np.searchsorted(a, a_s - 400)) - 1)
    i1 = min(len(P), int(np.searchsorted(a, a_e + 400)) + 1)
    ids = chain.node_ids[i0:i1]
    seg_way = chain.seg_way[i0:i1 - 1]
    fit = fit_line(P[i0:i1], tol=NODE_TOL)
    a0 = float(fit.project(*sxy)[0][0])
    a1 = float(fit.project(*exy)[0][0])
    st = stations(fit, a0, a1, SPACING)
    n = len(st["s"])
    length = float(st["s"][-1])
    node_s = fit.node_arc - a0
    on_road = (node_s >= 0) & (node_s <= length)

    # attributes by way, as runs along s
    def way_runs(fn):
        br, last = [], object()
        for k, w in enumerate(seg_way):
            v = fn(osm.ways[w]["tags"])
            if v != last:
                br.append((float(node_s[k]), v))
                last = v
        return runs(br, length)

    def section_key(t):
        lanes = int(t.get("lanes", "0") or 0) or 3
        pl = t.get("placement", "centre")
        pl = "centre" if pl in ("transition", "") or not placement_ok(pl, lanes) else pl
        return (lanes, pl, shoulders(t, lanes))

    raw_sections = way_runs(section_key)
    sec_runs = absorb_short(raw_sections, 40.0)
    speed_runs = absorb_short(way_runs(lambda t: mph(t.get("maxspeed"))), 100.0)
    bridge_runs = [r for r in way_runs(lambda t: t.get("bridge") if t.get("bridge") not in (None, "no") else None) if r[2]]
    surface_runs = absorb_short(way_runs(lambda t: t.get("surface", "asphalt")), 100.0)

    s = st["s"]
    speed = np.full(n, np.nan)
    for s0, s1, v in speed_runs:
        speed[(s >= s0) & (s <= s1)] = v if v else np.nan
    speed = np.where(np.isnan(speed), np.nanmedian(speed), speed)

    # crossfall by rule, eased over 60 m so the pavement rolls rather than steps
    st["crossfall"] = smooth(crossfall_rule(smooth(st["curvature"], 15), speed), 15)

    # pavement edges per station from the sections
    left = np.zeros(n)
    right = np.zeros(n)
    sections = []
    for s0, s1, (lanes, pl, (sl, sr)) in sec_runs:
        m = (s >= s0) & (s <= s1)
        le = left_edge(pl, lanes)
        left[m] = np.maximum(left[m], le + sl) if m.any() else left[m]
        right[m] = np.minimum(right[m], le - lanes * LANE_W - sr)
        sec = {"s0": rnd(s0), "s1": rnd(s1), "lanes": [{"w": LANE_W, "kind": "drive"} for _ in range(lanes)]}
        if (sl, sr) != (SHOULDER_WIDE if lanes >= 3 else SHOULDER_NARROW, SHOULDER_WIDE):
            sec["left"] = {"shoulder": sl}
            sec["right"] = {"shoulder": sr}
        if pl != "centre":
            sec["placement"] = pl
        sec["provenance"] = {"lanes": "osm", "widths": "rule", "placement": "osm" if pl != "centre" else "rule",
                             "crossfall": "rule"}
        sections.append(sec)
    sections[-1]["s1"] = length  # exactly the road's length, as the format checks
    # stations on a boundary take the wider of the two sections (both were applied above)

    # heights: the envelope over the highest drawn or queried ground, then smoothed from above
    def ground(px, py):
        return np.maximum(hs.height_at(px, py), top(px, py))

    env = envelope(st, left, right, ground, clearance=CLEARANCE, margin=MARGIN, across=1.0)
    radius = np.maximum(1500.0, (speed * MPH) ** 2 / COMFORT)
    h = smooth_from_above(env, SPACING, GRADE_SOLVE, radius)
    st["h"] = h

    road = {
        "id": road_id, "ref": ref, "dir": direction, "class": "motorway",
        "stations": {"spacing": SPACING},
        "sections": sections,
        "speed": [{"s0": rnd(s0), "mph": int(v)} for s0, s1, v in speed_runs if v],
        "surface": [{"s0": rnd(s0), "kind": v} for s0, s1, v in surface_runs],
        "bridges": [{"s0": rnd(s0), "s1": rnd(s1), "kind": "viaduct" if v == "viaduct" else "bridge"}
                    for s0, s1, v in bridge_runs],
        "links": [],
        "spacing": SPACING,
        "x": st["x"], "y": st["y"], "h": h, "heading": st["heading"], "curvature": st["curvature"],
        "crossfall": st["crossfall"],
    }

    # exits
    exits = []
    main_ways = set(chain.ways)
    for k, nid in junctions(osm, ids):
        sj = float(node_s[k])
        if sj < 0 or sj > length:
            continue
        links = exit_links(osm, nid, main_ways)
        side = "right"
        if links:
            ln = osm.ways[links[0]]["nodes"]
            if len(ln) > 1:
                lx, ly = (float(v) for v in to_local(*osm.nodes[ln[min(2, len(ln) - 1)]][:2]))
                jx, jy = (float(v) for v in to_local(*osm.nodes[nid][:2]))
                i = min(n - 1, int(round(sj / SPACING)))
                cross = np.cos(st["heading"][i]) * (ly - jy) - np.sin(st["heading"][i]) * (lx - jx)
                side = "left" if cross > 0 else "right"
        e = {"s": rnd(sj), "side": side, "kind": "exit", "ref": exit_ref(osm, nid, links),
             "label": exit_label(osm, nid, links) or "", "osm": f"n{nid}"}
        exits.append((e, exit_text(osm, nid, links)))
    road["links"] = [e for e, _ in exits]

    info = {
        "chain": chain, "fit": fit, "node_s": node_s, "on_road": on_road, "env": env, "left": left,
        "right": right, "speed": speed, "radius": radius, "exits": exits, "length": length,
        "end_offsets": {"start_m": round(float(d_s), 1), "end_m": round(float(d_e), 1)},
        "raw_sections": raw_sections, "sec_runs": sec_runs, "relations": rels, "speed_runs": speed_runs,
    }
    return road, info


def check_clearance(road_dec, hs, top, along=1.0, across=0.5):
    """Lowest height of the pavement (lanes and shoulders, with crossfall, as the refline
    interpolates it) above the ground, sampled every `along` m and `across` m. Returns the
    minimum against the drawn surface and against the bilinear height query, and where."""
    line = Refline(road_dec)
    s = np.arange(0, line.length + 1e-9, along)
    worst = {"drawn": (np.inf, 0.0), "query": (np.inf, 0.0)}
    secs = road_dec["sections"]
    for c in range(0, len(s), 4000):
        ss = s[c:c + 4000]
        p = line.at(ss)
        # pavement edges at each s from the sections
        le = np.zeros(len(ss))
        ri = np.zeros(len(ss))
        for sec in secs:
            m = (ss >= sec["s0"]) & (ss <= sec["s1"])
            lanes = len(sec["lanes"])
            sl = sec.get("left", {}).get("shoulder", SHOULDER_WIDE if lanes >= 3 else SHOULDER_NARROW)
            sr = sec.get("right", {}).get("shoulder", SHOULDER_WIDE)
            e = left_edge(sec.get("placement", "centre"), lanes)
            le[m] = np.maximum(le[m], e + sl)
            ri[m] = np.minimum(ri[m], e - lanes * LANE_W - sr)
        k = int(np.ceil((le - ri).max() / across)) + 1
        d = ri[:, None] + (le - ri)[:, None] * np.linspace(0, 1, k)[None, :]
        nx, ny = -np.sin(p["heading"]), np.cos(p["heading"])
        px = p["x"][:, None] + d * nx[:, None]
        py = p["y"][:, None] + d * ny[:, None]
        ph = p["h"][:, None] + p["crossfall"][:, None] * d
        for name, g in (("drawn", top(px, py)), ("query", hs.height_at(px, py))):
            gap = ph - g
            i = np.unravel_index(np.argmin(gap), gap.shape)
            if gap[i] < worst[name][0]:
                worst[name] = (float(gap[i]), float(ss[i[0]]))
    return {k: {"min_m": round(v[0], 3), "at_s": round(v[1], 1)} for k, v in worst.items()}


def carriageways(main, opp, step=100.0):
    """How the opposite carriageway lies beside the main one, for the report and the browser:
    the distance between the reference lines, which side the opposite one is on, and how much
    higher it is, per 1 km of the main road, plus the stretches out of the ordinary."""
    from scipy.spatial import cKDTree

    tree = cKDTree(np.column_stack([opp["x"], opp["y"]]))
    k = int(round(step / main["spacing"]))
    idx = np.arange(0, main["count"], k)
    d, j = tree.query(np.column_stack([main["x"][idx], main["y"][idx]]))
    hd = main["heading"][idx]
    lateral = -(opp["x"][j] - main["x"][idx]) * np.sin(hd) + (opp["y"][j] - main["y"][idx]) * np.cos(hd)
    dh = opp["h"][j] - main["h"][idx]
    s = idx * main["spacing"]
    per_km = []
    for km in range(int(np.ceil(s[-1] / 1000))):
        m = (s >= km * 1000) & (s < (km + 1) * 1000)
        if m.any():
            per_km.append({"km": km, "apart_m": [round(float(d[m].min()), 1), round(float(d[m].max()), 1)],
                           "opp_higher_m": [round(float(dh[m].min()), 2), round(float(dh[m].max()), 2)]})

    def stretches(mask):
        out, start = [], None
        for i, v in enumerate(mask):
            if v and start is None:
                start = i
            if (not v or i == len(mask) - 1) and start is not None:
                end = i if v else i - 1
                out.append({"s0": float(s[start]), "s1": float(s[end])})
                start = None
        return out

    return {
        "apart_m": {"min": round(float(d.min()), 1), "median": round(float(np.median(d)), 1), "max": round(float(d.max()), 1)},
        "opposite_on_left_everywhere": bool(np.all(lateral > 0)),
        "wrong_side": stretches(lateral <= 0),
        "far_apart_over_45m": stretches(d > 45),
        "height_differs_over_3m": stretches(np.abs(dh) > 3),
        "per_km": per_km,
    }


def posted_seconds(speed_list, s0, s1):
    t = 0.0
    for k, z in enumerate(speed_list):
        a = max(s0, z["s0"])
        b = min(s1, speed_list[k + 1]["s0"] if k + 1 < len(speed_list) else s1)
        if b > a:
            t += (b - a) / (z["mph"] * MPH)
    return t


def s_before(speed_list, s_target, seconds):
    """The chainage from which the posted speeds reach s_target in `seconds`."""
    s, left = s_target, seconds
    for k in range(len(speed_list) - 1, -1, -1):
        z0 = speed_list[k]["s0"]
        if z0 >= s:
            continue
        v = speed_list[k]["mph"] * MPH
        if (s - z0) / v >= left:
            return s - left * v
        left -= (s - z0) / v
        s = z0
    return 0.0


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    city = sys.argv[1]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    routes_cfg = cfg.get("routes") or sys.exit(f"{city} has no routes in data/cities.json")
    frame = create_frame(cfg)
    hs = load_heights(city)
    top = drawn_surface(hs)
    out_dir = ROOT / "public" / "data" / city
    rep_dir = ROOT / "data" / "derived" / city
    rep_dir.mkdir(parents=True, exist_ok=True)

    roads, routes, report, failures = [], [], {"routes": {}}, []
    snapshots = set()
    for rc in routes_cfg:
        osm_path = ROOT / "data" / "raw" / city / f"osm-{rc['ref'].lower().replace(' ', '')}.json"
        if not osm_path.exists():
            sys.exit(f"{osm_path.relative_to(ROOT)} is missing: run  uv run scripts/fetch_osm.py {city}")
        osm = load_osm(json.loads(osm_path.read_text()))
        snapshots.add(osm.timestamp)
        rid = rc["id"]
        print(f"{rid}: stitching and fitting {rc['ref']} {rc['direction']}")
        main_road, mi = build_road(osm, frame, hs, top, f"{rid}.main", rc["ref"], rc["direction"], rc["start"], rc["end"])
        roads.append(main_road)
        opp_dir = OPPOSITE[rc["direction"]]
        opp_id = re.sub(r"[nsew]$", opp_dir[0], rid) + ".opp"
        rr = {"id": rid, "main": {}, "opposite": {}}
        try:
            print(f"{rid}: the opposite carriageway, {rc['ref']} {opp_dir}")
            opp_road, oi = build_road(osm, frame, hs, top, opp_id, rc["ref"], opp_dir, rc["end"], rc["start"])
            if oi["chain"].gaps or oi["chain"].against_oneway:
                raise ValueError(f"stitching needed gaps {oi['chain'].gaps} or ran against oneway {oi['chain'].against_oneway}")
            roads.append(opp_road)
        except ValueError as ex:
            opp_road, oi = None, None
            rr["opposite"] = {"built": False, "why": str(ex)}
            print(f"  not built: {ex}")
        report["routes"][rid] = rr
        rr["_main"], rr["_opp"] = (main_road, mi), (opp_road, oi)

    source = {"osm": " ".join(sorted(snapshots)), "osmLicence": "ODbL, (c) OpenStreetMap contributors",
              "dem": "AWS Terrain Tiles (Terrarium), USGS 3DEP; the app's near, far and wide grids",
              "method": "scripts/build_roads.py"}
    doc, blob = encode_roadnet({"version": 1, "source": source, "roads": roads})
    (out_dir / "roadnet.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    (out_dir / "roadnet.bin").write_bytes(blob)
    decoded = {r["id"]: r for r in decode_roadnet(json.loads((out_dir / "roadnet.json").read_text()), blob)}

    for rc in routes_cfg:
        rid = rc["id"]
        rr = report["routes"][rid]
        main_road, mi = rr.pop("_main")
        opp_road, oi = rr.pop("_opp")
        for key, road, info in (("main", main_road, mi), ("opposite", opp_road, oi)):
            if road is None:
                continue
            dec = decoded[road["id"]]
            fit = info["fit"]
            dist = fit.node_distance[info["on_road"]]
            grade = Refline(dec).at(np.arange(0, dec["length"], 1.0))["grade"]
            lift = dec["h"] - hs.height_at(dec["x"], dec["y"])
            clear = check_clearance(dec, hs, top)
            ch = info["chain"]
            rr[key] = {
                "built": True, "road": road["id"], "relations": info["relations"],
                "length_m": info["length"], "stations": dec["count"],
                "ends_off_line_m": info["end_offsets"],
                "stitch": {"ways": len(ch.ways), "gaps": ch.gaps, "reversed_ways": ch.reversed_ways,
                           "against_oneway": ch.against_oneway},
                "fit": {"nodes": int(len(dist)), "within_0_5m": round(float((dist <= NODE_TOL).mean()), 4),
                        "p95_m": round(float(np.percentile(dist, 95)), 3), "max_m": round(float(dist.max()), 3),
                        "sigma_m": fit.sigma,
                        "max_curvature": round(float(np.abs(dec["curvature"]).max()), 6),
                        "min_radius_m": round(float(1 / max(np.abs(dec["curvature"]).max(), 1e-9)), 0)},
                "profile": {"max_grade": round(float(np.abs(grade).max()), 4),
                            "min_vertical_radius_m": round(float(info["radius"].min()), 0),
                            "lift_over_terrain_m": {"max": round(float(lift.max()), 2),
                                                    "max_at_s": float(np.argmax(lift) * SPACING),
                                                    "median": round(float(np.median(lift)), 2),
                                                    "p95": round(float(np.percentile(lift, 95)), 2)},
                            "pavement_clearance": clear,
                            "summit": {"h": round(float(dec["h"].max()), 1),
                                       "s": round(float(np.argmax(dec["h"]) * SPACING), 0)}},
                "sections": [{"s0": sec["s0"], "s1": sec["s1"], "lanes": len(sec["lanes"]),
                              **({"placement": sec["placement"]} if "placement" in sec else {}),
                              **({"shoulders": [sec["left"]["shoulder"], sec["right"]["shoulder"]]} if "left" in sec else {})}
                             for sec in road["sections"]],
                "speed": road["speed"],
                "bridges": len(road["bridges"]),
                "exits": [{k: e[k] for k in ("s", "ref", "label", "side")} for e in road["links"]],
            }

        # the route the journey drives, and its acceptance
        dec = decoded[main_road["id"]]
        length = dec["length"]
        line = Refline(dec)
        target_id = "w135457469"
        target = building_top(city, target_id)
        s_eye = np.arange(0, length + 1e-9, SPACING)
        p = line.at(s_eye)
        lane = 2
        # lane centre offsets from the sections, lane clamped to each section's count
        d_eye = np.zeros(len(s_eye))
        for sec in dec["sections"]:
            m = (s_eye >= sec["s0"]) & (s_eye <= sec["s1"])
            nl = len(sec["lanes"])
            ln = min(lane, nl)
            d_eye[m] = left_edge(sec.get("placement", "centre"), nl) - (ln - 0.5) * LANE_W
        ex = p["x"] - d_eye * np.sin(p["heading"])
        ey = p["y"] + d_eye * np.cos(p["heading"])
        eh = p["h"] + p["crossfall"] * d_eye
        eY = eye_scene_y(eh, ex, ey, cfg["base"], EYE)
        vis_q, worst_q = visible(hs.ground_y, ex, ey, eY, target)
        vis_d, _ = visible(lambda x, y: top(x, y) - cfg["base"] - curve_drop(x, y), ex, ey, eY, target)

        def first_true(v):
            idx = np.flatnonzero(v)
            return float(s_eye[idx[0]]) if len(idx) else None

        def stays_from(v):
            idx = np.flatnonzero(~v)
            return float(s_eye[idx[-1] + 1]) if len(idx) and idx[-1] + 1 < len(v) else (0.0 if not len(idx) else None)

        reveal_s = first_true(vis_q)
        k_rev = int(np.flatnonzero(vis_q)[0]) if reveal_s is not None else None
        reveal_info = {
            "target": target_id, "target_point": {k: round(float(target[k]), 2) for k in ("x", "y", "Y", "h")},
            "target_how": target["how"], "eye_m": EYE, "lane": lane,
            "first_visible_s": reveal_s, "stays_visible_from_s": stays_from(vis_q),
            "first_visible_s_drawn_surface": first_true(vis_d),
            "range_m": round(float(np.hypot(target["x"] - ex[k_rev], target["y"] - ey[k_rev])), 0) if k_rev is not None else None,
            "road_h_m": round(float(eh[k_rev]), 1) if k_rev is not None else None,
            "visible_share_after": round(float(vis_q[k_rev:].mean()), 3) if k_rev is not None else None,
        }

        exits = [(e, txt) for e, txt in mi["exits"]]

        def find_exit(word):
            for e, txt in exits:
                if word.lower() in txt.lower():
                    return e
            return None

        markers = []
        for e, _ in exits:
            label = e["label"] or (f"Exit {e['ref']}" if e["ref"] else "Exit")
            markers.append({"s": e["s"], "kind": "exit", "ref": e["ref"], "label": label})
        places = {}
        for pl in rc.get("places", []):
            if pl.get("at") == "end":
                sp = length
            elif pl.get("at") == "start":
                sp = 0
            else:
                e = find_exit(pl["exit"])
                sp = e["s"] if e else None
            places[pl["label"]] = sp
            if sp is not None:
                markers.append({"s": rnd(sp), "kind": "place", "label": pl["label"]})
        if reveal_s is not None:
            markers.append({"s": rnd(reveal_s), "kind": "reveal", "label": "First view of the Strip"})
        order = {"exit": 0, "place": 1, "reveal": 2}
        markers.sort(key=lambda m: (m["s"], order[m["kind"]]))

        city_exit = find_exit(rc.get("cityStart", {}).get("exit", "")) if rc.get("cityStart") else None
        speed_list = main_road["speed"]
        rev_s = reveal_s if reveal_s is not None else 0.0
        route = {
            "id": rid, "label": rc["label"], "from": rc.get("from", ""), "to": rc.get("to", ""),
            "road": main_road["id"], "s0": 0, "s1": rnd(length), "length": rnd(length), "lane": lane,
            "postedSeconds": int(round(posted_seconds(speed_list, 0, length))),
            "reveal": {"s": rnd(rev_s), "target": target_id, "label": "The Strip comes into view"},
            "starts": {"reveal": rnd(s_before(speed_list, rev_s, LEAD_SECONDS)), "start": 0,
                       "city": rnd(city_exit["s"]) if city_exit else None},
            "markers": markers,
        }
        if opp_road is not None:
            route["opposite"] = opp_road["id"]
        routes.append(route)

        # acceptance
        acc = {}
        exp_len = EXPECT_LENGTH.get(rid)
        if exp_len:
            ok = abs(length - exp_len) <= LENGTH_TOL * exp_len
            acc["length"] = {"ok": ok, "measured_m": length, "expected_m": exp_len, "tolerance": LENGTH_TOL}
        share = rr["main"]["fit"]["within_0_5m"]
        acc["fit"] = {"ok": share >= NODE_SHARE, "share_within_0_5m": share}
        prof = rr["main"]["profile"]
        acc["grade"] = {"ok": prof["max_grade"] <= GRADE + 1e-6, "max": prof["max_grade"]}
        cl = prof["pavement_clearance"]
        acc["above_terrain"] = {"ok": cl["drawn"]["min_m"] >= 0 and cl["query"]["min_m"] >= 0, **cl,
                                "lift_on_centre_line_m": prof["lift_over_terrain_m"]}
        if oi is not None:
            ocl = rr["opposite"]["profile"]["pavement_clearance"]
            acc["opposite_above_terrain"] = {"ok": ocl["drawn"]["min_m"] >= 0 and ocl["query"]["min_m"] >= 0,
                                             "max_grade": rr["opposite"]["profile"]["max_grade"], **ocl}
            acc["opposite_above_terrain"]["ok"] &= rr["opposite"]["profile"]["max_grade"] <= GRADE + 1e-6
        mphs = [z["mph"] for z in speed_list]
        change = next((z["s0"] for z in speed_list if z["mph"] == 65), None)
        acc["speed"] = {"ok": bool(mphs) and mphs[0] == 70 and 65 in mphs and change is not None,
                        "zones": speed_list, "change_to_65_km": round(change / 1000, 2) if change else None,
                        "plan_km": 41.6}
        want = EXPECT_EXITS.get(rid, [])
        have = [e["ref"] for e in main_road["links"]]
        missing = [w for w in want if not any(re.fullmatch(rf"{w}[A-Z]?", h) for h in have)]
        acc["exits"] = {"ok": not missing, "missing": missing, "present": have}
        if rid in EXPECT_REVEAL:
            exp, tol = EXPECT_REVEAL[rid]
            acc["reveal"] = {"ok": reveal_s is not None and abs(reveal_s - exp) <= tol,
                             "measured_s": reveal_s, "expected_s": exp, "tolerance_m": tol}
        if opp_road is not None:
            # the opposite carriageway must lie to the left of the main one and clear of it
            cw = rr["carriageways"] = carriageways(dec, decoded[opp_road["id"]])
            acc["carriageways"] = {"ok": cw["opposite_on_left_everywhere"] and cw["apart_m"]["min"] >= 10,
                                   "apart_m": cw["apart_m"], "wrong_side": cw["wrong_side"]}
        rr["reveal"] = reveal_info
        rr["places"] = places
        rr["acceptance"] = acc

    size = (out_dir / "roadnet.json").stat().st_size + (out_dir / "roadnet.bin").stat().st_size
    report["files"] = {"roadnet.json": (out_dir / "roadnet.json").stat().st_size,
                       "roadnet.bin": len(blob), "total": size, "ok": size < MAX_BYTES}
    routes_doc = {"version": 1, "source": {"osm": source["osm"]}, "routes": routes}
    (out_dir / "routes.json").write_text(json.dumps(routes_doc, indent=1) + "\n")
    report["source"] = source
    (rep_dir / "roads_report.json").write_text(json.dumps(report, indent=1, default=float) + "\n")

    for rid, rr in report["routes"].items():
        for name, a in rr["acceptance"].items():
            flag = "ok  " if a["ok"] else "MISS"
            if not a["ok"]:
                failures.append(f"{rid} {name}")
            print(f"  {flag} {rid} {name}: {json.dumps({k: v for k, v in a.items() if k != 'ok'}, default=float)[:220]}")
    print(f"  {'ok  ' if report['files']['ok'] else 'MISS'} files: {size / 1e6:.2f} MB")
    if not report["files"]["ok"]:
        failures.append("files")
    print(f"wrote {out_dir.relative_to(ROOT)}/roadnet.json, roadnet.bin, routes.json and "
          f"{(rep_dir / 'roads_report.json').relative_to(ROOT)}")
    if failures:
        sys.exit(f"acceptance missed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
