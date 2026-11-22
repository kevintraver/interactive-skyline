# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: build_roads.py <city> [--route <id> ...] [--out <dir>]

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

Then the interchanges (plan 02, D3.4; lib/interchanges.py): ramps with gores, the roads that
cross the route on bridges, junction records and structures, from the interchange extract
(fetch_osm.py). The main line does not move for them: the build compares the carriageways'
stations and JSON and the routes with the committed files and stops if anything differs.

Each route is one RoadNet of its own (its carriageway, the opposite one, its ramps, crossings and
structures), loaded only when that route is chosen: the city's first route keeps roadnet.json and
roadnet.bin (which must come out as committed), every other route R writes roadnet-R.json and
roadnet-R.bin. routes.json lists every route with the files it uses ("files": roadnet, signs,
traffic). --route builds only the routes named and keeps the others' entries in routes.json.

Output: public/data/<city>/roadnet.json, roadnet.bin, roadnet-<route>.json, .bin, routes.json
        data/derived/<city>/roads_report.json (first route), roads_report-<route>.json
        (all into <dir> instead with --out)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.alignment import fit_line, stations  # noqa: E402
from lib.frame import create_frame, curve_drop  # noqa: E402
from lib.ground import drawn_surface  # noqa: E402
from lib.heights import load_heights  # noqa: E402
from lib.crosssection import normalise_sections, pavement_edges  # noqa: E402
from lib.lanes import assign_ids, decide_sides, lane_evidence, parse_turn, place_tapers, turn_in  # noqa: E402
from lib.median import narrow_inside_shoulders  # noqa: E402
from lib.osm import exit_links, junctions, load_osm, mph, route_relations, stitch  # noqa: E402
from lib.profile import envelope, smooth_from_above  # noqa: E402
from lib.laneplan import path_dynamics, path_offsets, plan_lanes  # noqa: E402
from lib.refline import Refline  # noqa: E402
from lib.roadchecks import carriageways, check_clearance, edge_rates, lane_counts_match, plan_overlap  # noqa: E402
from lib.roadnet import decode_roadnet, encode_roadnet  # noqa: E402
from lib.sightline import building_top, eye_scene_y, visible  # noqa: E402
from lib.interchanges import build_interchanges  # noqa: E402
from lib.roadframe import RoadFrame  # noqa: E402
from lib.structures import piers_and_abutments, plan_overlaps  # noqa: E402
from lib.valley_traffic import simplify  # noqa: E402

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

TARGET = "w135457469"  # the reveal is the Strat's top coming into view, on every route (plan 02, section 8.2)
EXIT_MIN_S = 50.0  # a junction this close to the route's start is behind the car: not an exit of the route
DECK_SAG = 8.0  # m: an OSM bridge whose ground falls further than this below the chord of its ends (a canyon, not a street underneath) holds its deck up

# acceptance (plan 02, section 1 and 8.2; the exits as numbered in today's OSM)
EXPECT_LENGTH = {"i15n": 68400, "i15s": 45200, "us93": 59500}
LENGTH_TOL = 0.005
EXPECT_EXITS = {"i15n": ["1", "12", "25", "27", "33", "36", "38", "39", "40", "41", "42"],
                "i15s": ["58", "54", "52", "50", "48", "46", "45", "44", "42", "41", "40", "39", "38", "37", "36"],
                "us93": ["2", "14", "15", "17", "19", "20", "23", "62", "64", "65", "68", "69", "70", "72", "73", "75", "76"]}
EXPECT_REVEAL = {"i15n": (42800, 1500), "i15s": (6800, 1500), "us93": (25200, 1500)}
# posted speeds: the first zone's limit, and a zone of `has` mph (and where the plan puts the change to it)
EXPECT_SPEED = {"i15n": {"first": 70, "has": 65, "plan_km": 41.6},
                "i15s": {"first": 75, "has": 65, "plan_km": None},
                "us93": {"first": 55, "has": 65, "plan_km": None, "note": "55 mph zones at the start (plan 02, D9.2)"}}
NODE_TOL, NODE_SHARE = 0.5, 0.95
MAX_BYTES = 2.0e6  # plan 02, section 9.4: about 2 MB with ramps
MIN_RAMP_M = 300.0  # D3.4: every exit has a visible ramp at least this long


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


def hold_decks(env, s, bridge_runs, sag=DECK_SAG, held=None):
    """The ground under an OSM bridge does not bear on its deck. Where the envelope inside a bridge
    falls more than `sag` metres below the chord between the stations just beyond its ends (its
    abutments), it is lifted to that chord; a bridge that runs past an end of the road (a route that
    starts or ends on a bridge) is held level at its abutment inside the road. Shallower sags are
    left to the profile's own rules. Returns a new envelope; the runs held up are appended to
    `held` (they are decks of their own: no embankment, piers under them)."""
    out = np.array(env, dtype=float)
    n = len(s)
    for s0, s1, _ in bridge_runs:
        k0 = int(np.searchsorted(s, s0))
        k1 = int(np.searchsorted(s, s1, side="right")) - 1
        if k1 - k0 < 1:
            continue
        a, b = max(k0 - 1, 0), min(k1 + 1, n - 1)
        ha = float(env[a]) if s0 > s[0] else None
        hb = float(env[b]) if s1 < s[-1] else None
        if ha is None and hb is None:
            continue
        ha = hb if ha is None else ha
        hb = ha if hb is None else hb
        u = (s[k0:k1 + 1] - s[a]) / max(float(s[b] - s[a]), 1e-9)
        chord = ha + (hb - ha) * u
        if float((chord - env[k0:k1 + 1]).max()) > sag:
            out[k0:k1 + 1] = np.maximum(env[k0:k1 + 1], chord)
            if held is not None:
                held.append((s0, s1))
    return out


def build_road(osm, frame, hs, top, road_id, ref, direction, start, end):
    """One carriageway between two ends. Returns (road dict for the writer, info for the report)."""
    return finish_road(plan_road(osm, frame, hs, top, road_id, ref, direction, start, end))


def plan_road(osm, frame, hs, top, road_id, ref, direction, start, end):
    """The first half of build_road: the line, its stations and its lane sections with lane ids.
    Returns its state for finish_road (and for narrow_inside_shoulders in between)."""
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

    sections = []
    for s0, s1, (lanes, pl, (sl, sr)) in sec_runs:
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

    # which side lanes come and go on, lane ids, and a taper at every change
    def speed_at(sv):
        return next((v for a, b, v in speed_runs if a <= sv <= b and v), float(np.nanmedian(speed)))

    evidence = lane_evidence(osm, sections, ids, seg_way, node_s, set(chain.ways), st, to_local, SPACING)
    decisions = decide_sides(sections, evidence)
    assign_ids(sections, decisions)
    return dict(locals())


NAMES = ("osm", "hs", "top", "sections", "speed_at", "length", "decisions", "s", "st", "speed", "speed_runs",
         "surface_runs", "bridge_runs", "road_id", "ref", "direction", "ids", "node_s", "chain", "n", "to_local",
         "fit", "on_road", "d_s", "d_e", "raw_sections", "sec_runs", "rels", "seg_way", "evidence")


def finish_road(state):
    """The second half of build_road, once the sections are final: tapers, the profile, exits."""
    (osm, hs, top, sections, speed_at, length, decisions, s, st, speed, speed_runs, surface_runs, bridge_runs,
     road_id, ref, direction, ids, node_s, chain, n, to_local, fit, on_road, d_s, d_e, raw_sections, sec_runs,
     rels, seg_way, evidence) = (state[k] for k in NAMES)
    tapers = place_tapers(sections, speed_at, length, rnd, comfort=road_id.endswith(".main"))
    for i, dc in decisions.items():
        sections[i]["provenance"]["lane_side"] = dc["evidence"]
        if "taper" in sections[i]:
            sections[i]["taper"].update(side=dc["side"], evidence=dc["evidence"])
    left, right = pavement_edges(normalise_sections(sections), s)

    # heights: the envelope over the highest drawn or queried ground, then smoothed from above
    def ground(px, py):
        return np.maximum(hs.height_at(px, py), top(px, py))

    held = []
    env = hold_decks(envelope(st, left, right, ground, clearance=CLEARANCE, margin=MARGIN, across=1.0), s, bridge_runs,
                     held=held)
    radius = np.maximum(1500.0, (speed * MPH) ** 2 / COMFORT)
    h = smooth_from_above(env, SPACING, GRADE_SOLVE, radius)
    st["h"] = h

    road = {
        "id": road_id, "ref": ref, "dir": direction, "class": "motorway",
        "stations": {"spacing": SPACING},
        "sections": sections,
        "speed": [{"s0": rnd(s0), "mph": int(v)} for s0, s1, v in speed_runs if v],
        "surface": [{"s0": rnd(s0), "kind": v} for s0, s1, v in surface_runs],
        "bridges": [{"s0": rnd(s0), "s1": rnd(s1), "kind": "viaduct" if v == "viaduct" else "bridge",
                     **({"deck": True} if (s0, s1) in held else {})}
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
        if sj < EXIT_MIN_S or sj > length:
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
        "ids": ids, "seg_way": seg_way, "decisions": decisions, "tapers": tapers, "evidence": evidence,
        "turn_end": turn_in(osm, seg_way, node_s, sections[-1], last=True),
    }
    return road, info


def routes_doc_of(routes, source):
    return {"version": 1, "source": {"osm": source["osm"]}, "routes": routes}


def interchange_report(ic, cws, decoded, junctions, xdoc, osm_all=None):
    """Counts and the acceptance of D3.4 for one route's interchanges."""
    rep = ic["report"]
    frames = ic["frames"]
    main_id = cws[0]["frame"].id
    ov = plan_overlaps(frames, junctions)
    ramps = {r["road"]: r for r in rep["ramps"]}
    exits = [ln for ln in decoded[main_id]["links"] if ln.get("kind") == "exit"]
    diverge = {}
    for j in junctions:
        if j["kind"] == "diverge" and j["a"]["road"] == main_id:
            diverge.setdefault(round(j["a"]["s1"]), []).append(j)
    per_exit = []
    for e in exits:
        cand = [j for j in junctions if j["kind"] == "diverge" and j["a"]["road"] == main_id
                and j["a"]["s0"] - 50 <= e["s"] <= j["a"]["s1"] + 150]
        best = max((ramps[j["b"]["road"]]["length_m"] for j in cand if j["b"]["road"] in ramps), default=0.0)
        entry = {"s": e["s"], "ref": e.get("ref", ""), "label": e.get("label", ""),
                 "ramp": next((j["b"]["road"] for j in cand), None), "ramp_m": best, "ok": best >= MIN_RAMP_M}
        gone = [d for d in rep["dropped"] if d.get("node") == e.get("osm") and "median ramp" in d["why"]]
        if not cand and gone:
            entry.update(ok=True, simplified=gone[0]["why"])
        if not entry["ok"] and not gone and e.get("ref"):
            # a ramp the interchange rules could not build, or built shorter: listed with the reason
            name = f"{main_id.split('.')[0]}.x{e['ref']}.off"
            why = [d["why"] for d in rep["dropped"] if re.fullmatch(rf"{re.escape(name)}\d*", d["road"])]
            why += [d["why"] for d in rep["simplified"] if re.fullmatch(rf"{re.escape(name)}\d*", d["road"])
                    and d["road"] == entry["ramp"]]
            if why:
                entry.update(ok=True, simplified="ramp left out or shortened by the interchange rules: " + why[-1])
        if not cand and not gone and osm_all is not None and e.get("osm", "").startswith("n"):
            nid = int(e["osm"][1:])
            links = [w for w in osm_all.ways.values() if w["tags"].get("highway") == "motorway_link" and nid in w["nodes"]]
            if not links:
                entry.update(ok=True, no_link=True, why="a junction node with no motorway_link mapped at it: nothing to build")
        per_exit.append(entry)
    # clearance of every crossing road over each carriageway
    cross = []
    for F in frames:
        dr = getattr(F, "draft", None)
        if dr is None or dr.role != "crossing":
            continue
        pts = F.pavement_points(step=2.0, across=1.0)
        worst = np.inf
        for cw in cws:
            m, sb, db = cw["frame"].inside(pts["x"], pts["y"], grow=0.0)
            if m.any():
                worst = min(worst, float((pts["z"][m] - 1.2 - cw["frame"].surface(sb[m], db[m])).min()))
        cross.append({"road": F.id, "name": getattr(dr, "name", ""), "clearance_m": round(worst, 2) if np.isfinite(worst) else None})
    min_clear = min((c["clearance_m"] for c in cross if c["clearance_m"] is not None), default=None)
    main_ids = {cw["frame"].id for cw in cws}
    main_viol = [v for v in ov["violations"] if v["a"] in main_ids or v["b"] in main_ids]
    gores = [j for j in junctions if j["kind"] in ("diverge", "merge")]
    acc = {
        "exit_ramps": {"ok": all(p["ok"] for p in per_exit), "exits": len(per_exit),
                       "with_ramp_300m": sum(p["ok"] and not p.get("no_link") and not p.get("simplified") for p in per_exit),
                       "no_link_mapped": [p for p in per_exit if p.get("no_link")],
                       "simplified": [p for p in per_exit if p.get("simplified")],
                       "missing": [p for p in per_exit if not p["ok"]]},
        "overpasses": {"ok": bool(cross) and all(c["clearance_m"] is not None and c["clearance_m"] >= 4.9 for c in cross)
                       and not [d for d in rep["dropped"] if d["road"].startswith("x.") and not d.get("branch")],
                       "count": len(cross), "min_clearance_m": min_clear,
                       "dropped": [d for d in rep["dropped"] if d["road"].startswith("x.")],
                       "note": "branches of ramps that are too tangled to build by rule are left out and listed (simplified)"},
        "no_ramp_through_main": {"ok": not main_viol, "violations": main_viol},
        "plan_overlap_rule": {"ok": not ov["violations"], "violations": len(ov["violations"]),
                              "overlapping_pairs": ov["pairs"], "min_separation_m": ov["min_separation_m"]},
    }
    return {
        "counts": {"ramps": len(rep["ramps"]), "gores": len(gores),
                   "diverge": sum(j["kind"] == "diverge" for j in gores), "merge": sum(j["kind"] == "merge" for j in gores),
                   "connects": sum(j["kind"] == "connect" for j in junctions),
                   "crossings": len(cross), "decks": sum(len(r.get("bridges", [])) for r in ic["roads"]),
                   "piers": sum(s["kind"] == "pier" for s in ic["structures"]),
                   "abutments": sum(s["kind"] == "abutment" for s in ic["structures"]),
                   "roads": len(ic["roads"])},
        "extract": {"osm": xdoc.get("osm3s", {}).get("timestamp_osm_base", ""), "elements": len(xdoc["elements"])},
        "exits": per_exit, "crossings": cross, "ramps": rep["ramps"], "dropped": rep["dropped"],
        "simplified": rep["simplified"], "overlaps": ov["violations"], "acceptance": acc,
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


def committed(path):
    """A file as committed at HEAD, or None (no git, or not committed)."""
    try:
        return subprocess.run(["git", "show", f"HEAD:{path}"], cwd=ROOT, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None


# keys of a routes.json entry that came after i15n's RoadNet was fixed: `files` (with the other routes) and
# `outline` (the route picker's small map); the main-line check compares the rest
LATER_ROUTE_KEYS = ("files", "outline")


def check_main_line(city, doc, blob, routes_doc, main_ids, files=("roadnet.json", "roadnet.bin")):
    """The carriageways and routes must come out as committed: station records byte for byte,
    road JSON equal but for the keys the interchanges add (embankment, and `to` on links), and
    this RoadNet's routes in routes.json equal but for the keys that came later (LATER_ROUTE_KEYS). Returns a report entry;
    raises SystemExit on a difference."""
    ref_json = committed(f"public/data/{city}/{files[0]}")
    ref_bin = committed(f"public/data/{city}/{files[1]}")
    ref_routes = committed(f"public/data/{city}/routes.json")
    if ref_json is None or ref_bin is None or ref_routes is None:
        print("  (no committed roadnet to compare the main line with)")
        return {"checked": False}
    rdoc = json.loads(ref_json)
    got = {r["id"]: r for r in doc["roads"]}
    diffs = []
    for r in rdoc["roads"]:
        if r["id"] not in main_ids:
            continue
        g = got.get(r["id"])
        if g is None:
            diffs.append(f"{r['id']} missing")
            continue
        a = ref_bin[r["stations"]["offset"] * 28:(r["stations"]["offset"] + r["stations"]["count"]) * 28]
        b = blob[g["stations"]["offset"] * 28:(g["stations"]["offset"] + g["stations"]["count"]) * 28]
        if a != b:
            diffs.append(f"{r['id']} station records differ")
        if r["stations"] != g["stations"]:
            diffs.append(f"{r['id']} stations header differs")
        strip = lambda x: {k: ([{kk: vv for kk, vv in e.items() if kk != "to"} for e in v] if k == "links" else v)  # noqa: E731
                           for k, v in x.items() if k != "embankment"}
        if strip(r) != strip(g):
            diffs.append(f"{r['id']} JSON differs")
    plain = lambda r: {k: v for k, v in r.items() if k not in LATER_ROUTE_KEYS}  # noqa: E731
    was = {r["id"]: plain(r) for r in json.loads(ref_routes)["routes"]}
    for r in routes_doc["routes"]:
        if r["id"] in was and was[r["id"]] != plain(r):
            diffs.append(f"routes.json entry {r['id']} differs")
    if diffs:
        sys.exit("the main line moved: " + "; ".join(diffs))
    return {"checked": True, "roads": sorted(main_ids), "identical": True}


def build_group(city, cfg, routes_cfg, frame, hs, top):
    """Build one RoadNet: the routes routes_cfg (each with its opposite carriageway, ramps, crossings
    and structures). Returns {"doc", "blob", "text", "routes", "report", "main_ids", "source"}."""
    extracts = {}

    roads, routes, report, failures = [], [], {"routes": {}}, []
    plans = {}
    snapshots = set()
    for rc in routes_cfg:
        osm_path = ROOT / "data" / "raw" / city / f"osm-{rc['ref'].lower().replace(' ', '')}.json"
        if not osm_path.exists():
            sys.exit(f"{osm_path.relative_to(ROOT)} is missing: run  uv run scripts/fetch_osm.py {city}")
        osm = load_osm(json.loads(osm_path.read_text()))
        snapshots.add(osm.timestamp)
        x_path = osm_path.with_name(osm_path.stem + "-x.json")
        if not x_path.exists():
            sys.exit(f"{x_path.relative_to(ROOT)} is missing: run  uv run scripts/fetch_osm.py {city}")
        extracts[rc["id"]] = x_path
        rid = rc["id"]
        print(f"{rid}: stitching and fitting {rc['ref']} {rc['direction']}")
        pm = plan_road(osm, frame, hs, top, f"{rid}.main", rc["ref"], rc["direction"], rc["start"], rc["end"])
        opp_dir = OPPOSITE[rc["direction"]]
        # named for the route that would drive it: i15n's is i15s.opp; us93's is us93s.opp
        opp_id = (re.sub(r"[nsew]$", opp_dir[0], rid) if re.search(r"[nsew]$", rid) else rid + opp_dir[0]) + ".opp"
        rr = {"id": rid, "main": {}, "opposite": {}}
        try:
            print(f"{rid}: the opposite carriageway, {rc['ref']} {opp_dir}")
            po = plan_road(osm, frame, hs, top, opp_id, rc["ref"], opp_dir, rc["end"], rc["start"])
            if po["chain"].gaps or po["chain"].against_oneway:
                raise ValueError(f"stitching needed gaps {po['chain'].gaps} or ran against oneway {po['chain'].against_oneway}")
        except ValueError as ex:
            po = None
            rr["opposite"] = {"built": False, "why": str(ex)}
            print(f"  not built: {ex}")
        if po is not None:
            rr["inside_shoulders"] = narrow_inside_shoulders(pm, po)
        main_road, mi = finish_road(pm)
        roads.append(main_road)
        opp_road, oi = finish_road(po) if po is not None else (None, None)
        plans[rid] = (pm, po)
        if opp_road is not None:
            roads.append(opp_road)
        report["routes"][rid] = rr
        rr["_main"], rr["_opp"] = (main_road, mi), (opp_road, oi)

    source = {"osm": " ".join(sorted(snapshots)), "osmLicence": "ODbL, (c) OpenStreetMap contributors",
              "dem": "AWS Terrain Tiles (Terrarium), USGS 3DEP; the app's near, far and wide grids",
              "method": "scripts/build_roads.py"}
    doc, blob = encode_roadnet({"version": 1, "source": source, "roads": roads})
    decoded = {r["id"]: r for r in decode_roadnet(json.loads(json.dumps(doc, separators=(",", ":"))), blob)}
    main_ids = {r["id"] for r in roads}

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
                              **({"shoulders": [nsec["left"]["shoulder"], nsec["right"]["shoulder"]]} if "left" in sec or "right" in sec else {})}
                             for sec, nsec in zip(road["sections"], normalise_sections(road["sections"]))],
                "lane_sides": [{"s": road["sections"][i]["s0"], "lanes": [len(road["sections"][i - 1]["lanes"]), len(road["sections"][i]["lanes"])],
                                **{k: dc[k] for k in ("side", "evidence", "conflicts")}} for i, dc in sorted(info["decisions"].items())],
                "tapers": info["tapers"],
                "edge_rate": edge_rates(dec),
                "lane_counts": lane_counts_match(road["sections"], info["raw_sections"], info["length"]),
                "speed": road["speed"],
                "bridges": len(road["bridges"]),
                "exits": [{k: e[k] for k in ("s", "ref", "label", "side")} for e in road["links"]],
            }

        # the route the journey drives, and its acceptance
        dec = decoded[main_road["id"]]
        length = dec["length"]
        line = Refline(dec)
        target_id = TARGET
        target = building_top(city, target_id)
        s_eye = np.arange(0, length + 1e-9, SPACING)
        p = line.at(s_eye)
        lane = 2  # the starting lane: second from the left at the start
        through = parse_turn(mi["turn_end"], len(dec["sections"][-1]["lanes"]))
        last_ids = [l["id"] for l in dec["sections"][-1]["lanes"]]
        through_ids = {lid for lid, tk in zip(last_ids, through) if tk & {"through", "none"}} if through else set(last_ids)

        def speed_ms(sv):
            return next(z["mph"] for z in reversed(main_road["speed"]) if z["s0"] <= sv) * MPH

        lane_plan, lane_markers, lane_report = plan_lanes(dec["sections"], length, lane, through_ids, speed_ms)
        d_eye = path_offsets(dec["sections"], lane_plan, s_eye)
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
        markers += lane_markers
        order = {"exit": 0, "place": 1, "reveal": 2, "lane": 3}
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
            "lanePlan": lane_plan,
            "outline": outline_of(dec),
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
        xs = EXPECT_SPEED.get(rid, {"first": mphs[0] if mphs else None, "has": 65, "plan_km": None})
        change = next((z["s0"] for z in speed_list if z["mph"] == xs["has"]), None)
        acc["speed"] = {"ok": bool(mphs) and mphs[0] == xs["first"] and xs["has"] in mphs and change is not None,
                        "zones": speed_list, f"change_to_{xs['has']}_km": round(change / 1000, 2) if change else None,
                        "plan_km": xs["plan_km"]}
        if xs.get("note"):
            acc["speed"]["note"] = xs["note"]
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
            if cw["opposite_on_left_everywhere"] and not acc["carriageways"]["ok"]:
                # closer than 10 m (a narrow median with a barrier): fine while the pavements stay apart
                gap = plan_overlap(dec, decoded[opp_road["id"]])["min_gap_m"]
                acc["carriageways"].update(ok=gap > 0, pavements_apart_m=gap,
                                           note="reference lines under 10 m apart; the pavements do not touch")
        for key in ("main", "opposite"):
            if rr[key].get("built"):
                er, lc = rr[key]["edge_rate"], rr[key]["lane_counts"]
                acc[f"{key}_edge_rate"] = {"ok": er["max_m_per_m"] <= er["limit"] + 1e-6 and not er["abrupt_changes"], **er}
                acc[f"{key}_lane_counts"] = {"ok": lc["matching"] >= lc["stations"] - 1, "matching": lc["matching"],
                                             "of": lc["stations"], "mismatches": lc["mismatches"]}
        if opp_road is not None:
            ov = rr["plan_overlap"] = plan_overlap(dec, decoded[opp_road["id"]])
            acc["no_overlap"] = {"ok": ov["min_gap_m"] > 0, **ov}
        dyn = path_dynamics(dec["sections"], lane_plan, speed_ms, length, step=0.5)
        lanes_ok = all(e.get("why") for e in lane_report)
        rr["lane_plan"] = {"plan": lane_plan, "changes": lane_report, "through_at_end": sorted(through_ids), **dyn}
        acc["lane_plan"] = {"ok": dyn["no_lane_count"] == 0 and dyn["max_lateral_accel"] <= 1.0 and lanes_ok,
                            "changes": len(lane_report), **{k: dyn[k] for k in ("max_lateral_accel", "at_s", "max_lateral_jerk")}}
        rr["reveal"] = reveal_info
        rr["places"] = places
        rr["acceptance"] = acc

    # interchanges, against the decoded carriageways (the runtime's own numbers)
    extra_roads, junction_recs, structure_recs = [], [], []
    for rc in routes_cfg:
        rid = rc["id"]
        rr = report["routes"][rid]
        print(f"{rid}: interchanges")
        xdoc = json.loads(extracts[rid].read_text())
        base = json.loads((ROOT / "data" / "raw" / city / f"osm-{rc['ref'].lower().replace(' ', '')}.json").read_text())
        osm_all = load_osm({"elements": xdoc["elements"] + base["elements"], "osm3s": base.get("osm3s", {})})
        cws = []
        for key, st_ in (("main", plans[rid][0]), ("opposite", plans[rid][1])):
            if st_ is None:
                continue
            road_id = st_["road_id"]
            cws.append({"frame": RoadFrame(decoded[road_id]), "ids": list(st_["ids"]), "ways": set(st_["chain"].ways),
                        "prefix": road_id.split(".")[0], "links": decoded[road_id]["links"]})
        ic = build_interchanges(osm_all, cws, frame.to_local, lambda px, py: np.maximum(hs.height_at(px, py), top(px, py)),
                                own_ref=rc["ref"])
        extra_roads += ic["roads"]
        junction_recs += ic["junctions"]
        structure_recs += ic["structures"]
        # a carriageway's own deck over a canyon (hold_decks) stands on piers like a ramp's
        for cw in cws:
            spans = [(b["s0"], b["s1"]) for b in decoded[cw["frame"].id]["bridges"] if b.get("deck")]
            if spans:
                recs = piers_and_abutments(cw["frame"], spans, ic["frames"],
                                           lambda px, py: np.maximum(hs.height_at(px, py), top(px, py)))
                # a deck that runs on past the road's end has no abutment there
                L = cw["frame"].length
                structure_recs += [r for r in recs if not (r["kind"] == "abutment" and min(r["s"], L - r["s"]) < 2 * SPACING)]
        rr["interchanges"] = interchange_report(ic, cws, decoded, junction_recs, xdoc, osm_all)
        for r in roads:
            if r["id"] in ic["main_embankment"] and ic["main_embankment"][r["id"]]:
                r["embankment"] = ic["main_embankment"][r["id"]]
            starts = {j["b"]["road"]: j for j in ic["junctions"] if j["kind"] == "diverge" and j["a"]["road"] == r["id"]}
            for ln in r.get("links", []):
                for rr_id, j in starts.items():
                    ramp = next(x for x in ic["roads"] if x["id"] == rr_id)
                    if ramp.get("_start_node") == ln.get("osm"):
                        ln["to"] = rr_id
        for name, a in rr["interchanges"]["acceptance"].items():
            rr["acceptance"][f"interchanges_{name}"] = a
    for r in extra_roads:
        r.pop("_start_node", None)
    doc, blob = encode_roadnet({"version": 1, "source": source, "roads": roads + extra_roads,
                                "junctions": junction_recs, "structures": structure_recs})
    text = json.dumps(doc, separators=(",", ":")) + "\n"
    decode_roadnet(json.loads(text), blob)
    report["source"] = source
    return {"text": text, "blob": blob, "routes": routes, "report": report, "main_ids": main_ids, "source": source}

OUTLINE_TOL = 120.0  # m: Douglas-Peucker tolerance of a route's outline (the picker's small map)
OUTLINE_ROUND = 10  # m: its points are rounded to this


def outline_of(dec):
    """A route's simplified line for the route picker's small map: map metres [[x, y], ...] (x east,
    y north), from its first station to its last, a few dozen points. Lets a card draw a route whose
    RoadNet is not loaded yet."""
    xy = np.column_stack([np.asarray(dec["x"], float), np.asarray(dec["y"], float)])
    pts = simplify(xy, OUTLINE_TOL)
    return [[int(round(x / OUTLINE_ROUND) * OUTLINE_ROUND), int(round(y / OUTLINE_ROUND) * OUTLINE_ROUND)] for x, y in pts]


def files_of(rc, first):
    """A route's files. The first route of the city keeps the RoadNet it always had (roadnet.json and
    roadnet.bin, signs.json); every other one has its own, loaded only when it is chosen."""
    rid = rc["id"]
    if first:
        return {"roadnet": "roadnet.json", "signs": "signs.json", "traffic": f"traffic/{rid}.json"}
    return {"roadnet": f"roadnet-{rid}.json", "signs": f"signs-{rid}.json", "traffic": f"traffic/{rid}.json"}


def main():
    args = [a for a in sys.argv[1:]]
    out_override = None
    only = []
    if "--out" in args:
        k = args.index("--out")
        out_override = Path(args[k + 1]).resolve()
        del args[k:k + 2]
    while "--route" in args:
        k = args.index("--route")
        only.append(args[k + 1])
        del args[k:k + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    city = args[0]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    routes_cfg = cfg.get("routes") or sys.exit(f"{city} has no routes in data/cities.json")
    unknown = set(only) - {rc["id"] for rc in routes_cfg}
    if unknown:
        sys.exit(f"no route {sorted(unknown)} in data/cities.json")
    frame = create_frame(cfg)
    hs = load_heights(city)
    top = drawn_surface(hs)
    out_dir = out_override or ROOT / "public" / "data" / city
    rep_dir = out_override or ROOT / "data" / "derived" / city
    out_dir.mkdir(parents=True, exist_ok=True)
    rep_dir.mkdir(parents=True, exist_ok=True)
    routes_path = out_dir / "routes.json"
    old_routes = {r["id"]: r for r in json.loads(routes_path.read_text())["routes"]} if routes_path.exists() else {}

    failures, entries, snapshots = [], {}, set()
    for n, rc in enumerate(routes_cfg):
        rid = rc["id"]
        files = files_of(rc, n == 0)
        if only and rid not in only:
            if rid in old_routes:
                entries[rid] = old_routes[rid]
            continue
        g = build_group(city, cfg, [rc], frame, hs, top)
        snapshots.update(g["source"]["osm"].split())
        report = g["report"]
        bin_name = files["roadnet"][:-len(".json")] + ".bin"
        routes_doc = routes_doc_of(g["routes"], g["source"])
        report["main_line"] = check_main_line(city, json.loads(g["text"]), g["blob"], routes_doc, g["main_ids"],
                                              (files["roadnet"], bin_name))
        (out_dir / files["roadnet"]).write_text(g["text"])
        (out_dir / bin_name).write_bytes(g["blob"])
        size = len(g["text"].encode()) + len(g["blob"])
        report["files"] = {files["roadnet"]: len(g["text"].encode()), bin_name: len(g["blob"]), "total": size,
                           "ok": size < MAX_BYTES}
        for r in g["routes"]:
            entries[r["id"]] = {**r, "files": files}
        rep_name = "roads_report.json" if n == 0 else f"roads_report-{rid}.json"
        (rep_dir / rep_name).write_text(json.dumps(report, indent=1, default=float) + "\n")
        for rrid, rr in report["routes"].items():
            for name, a in rr["acceptance"].items():
                flag = "ok  " if a["ok"] else "MISS"
                if not a["ok"]:
                    failures.append(f"{rrid} {name}")
                print(f"  {flag} {rrid} {name}: {json.dumps({k: v for k, v in a.items() if k != 'ok'}, default=float)[:220]}")
        print(f"  {'ok  ' if report['files']['ok'] else 'MISS'} {rid} files: {size / 1e6:.2f} MB")
        if not report["files"]["ok"]:
            failures.append(f"{rid} files")
        print(f"wrote {out_dir / files['roadnet']}, {bin_name} and {rep_dir / rep_name}")

    # routes.json: every route, in the order of cities.json
    if only and routes_path.exists():
        snapshots.update(json.loads(routes_path.read_text())["source"]["osm"].split())
    routes = [entries[rc["id"]] for rc in routes_cfg if rc["id"] in entries]
    routes_path.write_text(json.dumps(routes_doc_of(routes, {"osm": " ".join(sorted(snapshots))}), indent=1) + "\n")
    print(f"wrote {routes_path}")
    if failures:
        sys.exit(f"acceptance missed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
