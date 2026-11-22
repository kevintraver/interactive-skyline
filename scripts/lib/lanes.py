"""Lane identity and tapers for the road pipeline (plan 02, task D3.1).

At every change of lane count, decide on which side lanes are added or dropped, from the data in
this order: the ways' `placement` (when both sides carry one and only one choice keeps the
shared lanes in place), their `turn:lanes` (an entrance lane that merges, an exit-only lane), the
side of an entrance or exit ramp at that place, `placement` on one side with the other taken as
centred (weak: it only says which choice keeps the lanes still), and otherwise the right. Number the lanes so that
a lane keeps its id across sections, then place a taper at every boundary where any edge moves:
length L = W x S (MUTCD 3B.09; W the largest edge movement in feet, S the limit in mph, so in
metres L = W x S as well), a dropped lane tapering away before its boundary and an added lane
opening after it. Tapers that would overlap are shortened proportionally, never below the length
that keeps every edge within 1 m per 20 m, and moved apart where even that does not fit.

    evidence = lane_evidence(osm, sections, ...)        # what the ways say at each boundary
    decisions = decide_sides(sections, evidence)       # one per boundary
    assign_ids(sections, decisions)                     # writes lane["id"]
    report = place_tapers(sections, speed_at, length)   # writes section["taper"]

The rules the taper fields follow are specified at the top of src/drive/roadnet/format.js.
"""
import numpy as np

from .crosssection import left_edge_offset, normalise_sections, union_ids
from .osm import ramps

RATE = 20.0  # metres along per metre sideways, at the steepest point of a taper
SLOPE_PEAK = 1.875  # the smootherstep's steepest slope over its average
LMIN_PER_W = 38.0  # m of taper per metre of movement: 1.875 / 38 = 1 m per 20.3 m at the steepest
RAMP_REACH = 250.0  # m: a ramp this close to a boundary is evidence for its side
EXIT_ONLY = {"slight_right", "right", "sharp_right"}
EXIT_ONLY_LEFT = {"slight_left", "left", "sharp_left"}


def parse_turn(value, lanes):
    """turn:lanes as a list of token sets, one per lane, or None when it does not fit `lanes`."""
    if not value:
        return None
    parts = value.split("|")
    if len(parts) != lanes:
        return None
    return [set(p.split(";")) - {""} or {"none"} for p in parts]


def _special_counts(turn):
    """(leading, trailing): lanes at the left and right that leave or end, by turn:lanes."""
    def right(t):
        return "merge_to_left" in t or (t <= EXIT_ONLY and bool(t))

    def left(t):
        return "merge_to_right" in t or (t <= EXIT_ONLY_LEFT and bool(t))

    lead = 0
    while lead < len(turn) and left(turn[lead]):
        lead += 1
    trail = 0
    while trail < len(turn) - lead and right(turn[-1 - trail]):
        trail += 1
    return lead, trail


def _shared_shift(P, C, j):
    """Largest movement of a shared lane edge when j lanes are added (or dropped) on the left."""
    small, big = (P, C) if len(P["lanes"]) <= len(C["lanes"]) else (C, P)
    os_, ob = left_edge_offset(small), left_edge_offset(big)
    ws = np.cumsum([0.0] + [l["w"] for l in small["lanes"]])
    wb = np.cumsum([0.0] + [l["w"] for l in big["lanes"]])
    n = len(small["lanes"])
    a = os_ - ws  # edges of the small section's lanes
    b = ob - wb[j:j + n + 1]
    return float(np.abs(a - b).max())


def decide_sides(sections, evidence):
    """For each boundary (between section i-1 and i), how many lanes change on the LEFT (the rest
    on the right), and why. `evidence[i]` describes boundary i: {"placement_tagged": (bool, bool),
    "turn_prev": str|None, "turn_cur": str|None, "ramps": [{"s", "kind", "side"}]}.
    Returns {i: {"left": j, "count": d, "side": "left"|"right"|"both", "evidence": source,
    "conflicts": [...]}} for boundaries where the count changes."""
    secs = normalise_sections(sections)
    out = {}
    for i in range(1, len(secs)):
        P, C = secs[i - 1], secs[i]
        n, m = len(P["lanes"]), len(C["lanes"])
        if n == m:
            continue
        d = abs(m - n)
        ev = evidence.get(i, {})
        votes = {}
        # placement: both sides tagged and exactly one choice keeps the shared lanes still
        if all(ev.get("placement_tagged", (False, False))):
            shifts = [_shared_shift(P, C, j) for j in range(d + 1)]
            still = [j for j, sh in enumerate(shifts) if sh < 0.3]
            if len(still) == 1:
                votes["placement"] = still[0]
        # turn:lanes on the side that has the extra lanes
        turn = parse_turn(ev.get("turn_cur") if m > n else ev.get("turn_prev"), max(m, n))
        if turn:
            lead, trail = _special_counts(turn)
            if lead or trail:
                votes["turn:lanes"] = min(lead, d) if lead else 0
        # the nearest ramp of the fitting kind (entrance for an added lane, exit for a dropped one)
        want = "entrance" if m > n else "exit"
        ramps = sorted(ev.get("ramps", []), key=lambda r: (r["kind"] != want, abs(r["ds"])))
        if ramps and abs(ramps[0]["ds"]) <= RAMP_REACH:
            votes["ramp"] = d if ramps[0]["side"] == "left" else 0
        # placement on one side only, the other taken as centred: weak, but better than a guess
        if "placement" not in votes and any(ev.get("placement_tagged", (False, False))):
            shifts = [_shared_shift(P, C, j) for j in range(d + 1)]
            still = [j for j, sh in enumerate(shifts) if sh < 0.3]
            if len(still) == 1:
                votes["placement+centre"] = still[0]
        for source in ("placement", "turn:lanes", "ramp", "placement+centre"):
            if source in votes:
                j = votes[source]
                break
        else:
            source, j = "rule", 0
        side = "right" if j == 0 else "left" if j == d else "both"
        conflicts = sorted(k for k, v in votes.items() if v != j)
        out[i] = {"left": j, "count": d, "side": side, "evidence": source, "conflicts": conflicts,
                  "added": m > n}
    return out


def assign_ids(sections, decisions):
    """Write lane ids: the first section's lanes are 1..n from the left; a lane keeps its id across a
    boundary; new lanes take the next unused id, left to right."""
    nxt = len(sections[0]["lanes"]) + 1
    for k, lane in enumerate(sections[0]["lanes"]):
        lane["id"] = k + 1
    for i in range(1, len(sections)):
        P, C = sections[i - 1]["lanes"], sections[i]["lanes"]
        n, m = len(P), len(C)
        j = decisions[i]["left"] if i in decisions else 0
        if m >= n:
            for k, lane in enumerate(C):
                if j <= k < j + n:
                    lane["id"] = P[k - j]["id"]
                else:
                    lane["id"] = nxt
                    nxt += 1
        else:
            for k, lane in enumerate(C):
                lane["id"] = P[k + j]["id"]


def boundary_geometry(P, C):
    """(W, f): the largest edge movement across the boundary, and where the taper belongs: 1 when
    lanes are only dropped (before the boundary), 0 when only added (after), else 0.5."""
    ids = union_ids([l["id"] for l in P["lanes"]], [l["id"] for l in C["lanes"]])
    wa = {l["id"]: l["w"] for l in P["lanes"]}
    wb = {l["id"]: l["w"] for l in C["lanes"]}

    def edges(o, sl, sr, w):
        e = [o + sl, o]
        for x in ids:
            e.append(e[-1] - w.get(x, 0.0))
        e.append(e[-1] - sr)
        return np.array(e)

    ea = edges(left_edge_offset(P), P["left"]["shoulder"], P["right"]["shoulder"], wa)
    eb = edges(left_edge_offset(C), C["left"]["shoulder"], C["right"]["shoulder"], wb)
    W = float(np.abs(eb - ea).max())
    dropped = any(x not in wb for x in ids)
    added = any(x not in wa for x in ids)
    f = 1.0 if dropped and not added else 0.0 if added and not dropped else 0.5
    return W, f


def _pack(items, length):
    """Place intervals [x, x + L], each covering its boundaries [lo, hi], in order, not overlapping,
    within [0, length], as near as possible to where they want to be. Returns (x, the indices of
    items that could not be fitted)."""
    x = [it["want"] for it in items]
    for _ in range(200):
        moved = False
        for k, it in enumerate(items):  # forward: clear of the previous, still covering its boundaries
            lo = max(it["hi"] - it["Lp"], 0.0 if k == 0 else x[k - 1] + items[k - 1]["Lp"])
            if x[k] < lo - 1e-9:
                x[k], moved = min(lo, it["lo"]), True
        for k in range(len(items) - 1, -1, -1):  # backward
            it = items[k]
            hi = min(it["lo"], (length if k == len(items) - 1 else x[k + 1]) - it["Lp"])
            if x[k] > hi + 1e-9:
                x[k], moved = max(hi, it["hi"] - it["Lp"]), True
        if not moved:
            break
    bad = [k for k in range(len(items)) if (k + 1 < len(items) and x[k] + items[k]["Lp"] > x[k + 1] + 1e-6)
           or x[k] < -1e-6 or x[k] + items[k]["Lp"] > length + 1e-6]
    return x, bad


def _item(secs, sections, a, i, speed_at):
    """A taper from section a to section i (a < i), covering the boundaries a+1..i."""
    W, f = boundary_geometry(secs[a], secs[i])
    lo, hi = float(sections[a + 1]["s0"]), float(sections[i]["s0"])
    S = max(speed_at(lo - 1.0), speed_at(hi + 1.0))
    L = W * S if W > 1e-6 else 0.0
    span = hi - lo
    Lmin = max(LMIN_PER_W * W, span) if W > 1e-6 else span
    return {"a": a, "i": i, "lo": lo, "hi": hi, "W": W, "f": f, "S": S, "L": max(L, Lmin if L else 0.0),
            "L_mutcd": L, "Lmin": Lmin, "Lp": max(L, Lmin if L else 0.0)}


def _want(it):
    """Where a taper would start: a dropped lane closes before its boundary, an added one opens after."""
    return it["lo"] - it["f"] * (it["Lp"] - (it["hi"] - it["lo"]))


def place_tapers(sections, speed_at, length, rnd=lambda v: round(float(v), 1)):
    """Write section["taper"] at every boundary where an edge moves. `speed_at(s)` is the posted
    limit in mph. Returns a report: one entry per taper, with where tapers were shortened, moved
    or merged across a short section."""
    secs = normalise_sections(sections)
    items = [_item(secs, sections, i - 1, i, speed_at) for i in range(1, len(secs))]

    def shorten():
        # proportional shortening where neighbours (or the road's ends) want the same ground
        scale = [1.0] * len(items)
        for it in items:
            it["Lp"] = it["L"]
            it["want"] = _want(it)
        for k in range(len(items) + 1):
            a = items[k - 1] if k > 0 else None
            c = items[k] if k < len(items) else None
            need = ((1 - a["f"]) * (a["L"] - a["hi"] + a["lo"]) if a else 0.0) + (c["f"] * (c["L"] - c["hi"] + c["lo"]) if c else 0.0)
            gap = (c["lo"] if c else length) - (a["hi"] if a else 0.0)
            if need > gap >= 0 and need > 0:
                for idx in (k - 1, k):
                    if 0 <= idx < len(items):
                        scale[idx] = min(scale[idx], gap / need)
        for it, sc in zip(items, scale):
            if it["L"] > 0:
                it["Lp"] = max(it["Lmin"], (it["hi"] - it["lo"]) + (it["L"] - it["hi"] + it["lo"]) * sc)
            it["want"] = _want(it)
        return _pack(items, length)

    x, bad = shorten()
    while bad:  # a cluster that will not fit: one taper across the shortest section in it
        k = min((k for k in bad if k + 1 < len(items)), key=lambda k: items[k + 1]["lo"] - items[k]["hi"], default=None)
        if k is None:
            k = bad[0] - 1
        items[k:k + 2] = [_item(secs, sections, items[k]["a"], items[k + 1]["i"], speed_at)]
        x, bad = shorten()

    report = []
    for sec in sections:
        sec.pop("taper", None)
    for it, x0 in zip(items, x):
        if it["Lp"] <= 0 or it["W"] <= 1e-6:
            continue
        sec = sections[it["i"]]
        s0, s1 = rnd(x0), rnd(x0 + it["Lp"])
        s0, s1 = min(s0, rnd(it["lo"])), max(s1, rnd(it["hi"]))
        tp = {"s0": s0, "s1": s1, "W": round(it["W"], 2), "L": rnd(it["L_mutcd"])}
        shortened = it["Lp"] < it["L_mutcd"] - 0.05
        moved = abs(x0 - it["want"]) > 0.5
        merged = it["i"] - it["a"] > 1
        if shortened:
            tp["shortened"] = round(it["Lp"] / it["L_mutcd"], 3)
        if moved:
            tp["moved"] = True
        if merged:
            tp["across"] = [sections[j]["s0"] for j in range(it["a"] + 1, it["i"])]
        sec["taper"] = tp
        report.append({"s": rnd(it["hi"]), "W_m": round(it["W"], 2), "mph": it["S"], "L_mutcd_m": rnd(it["L_mutcd"]),
                       "L_m": round(s1 - s0, 1), "s0": s0, "s1": s1,
                       "place": {1.0: "before", 0.0: "after"}.get(it["f"], "across"),
                       "shortened": shortened, "moved": moved, "merged_across": tp.get("across", []),
                       "rate_ok": (s1 - s0) >= RATE * SLOPE_PEAK * it["W"] - 1e-6})
    return report


def max_edge_rate(sections, s):
    """Largest sideways speed of any lane or shoulder edge (metres per metre) over stations s, from
    the tapered cross-section: for the acceptance check."""
    from .crosssection import blend, tapers_of
    secs = normalise_sections(sections)
    worst = (0.0, None)
    for tp in tapers_of(secs):
        W, _ = boundary_geometry(secs[tp["from"]], secs[tp["i"]])
        ss = s[(s >= tp["s0"]) & (s <= tp["s1"])]
        if len(ss) < 2:
            continue
        u = blend((ss - tp["s0"]) / (tp["s1"] - tp["s0"]))
        rate = W * np.abs(np.diff(u)) / np.diff(ss)
        k = int(np.argmax(rate))
        if rate[k] > worst[0]:
            worst = (float(rate[k]), float(ss[k]))
    return worst


def turn_in(osm, seg_way, node_s, sec, last=False):
    """turn:lanes of the way nearest one end of a section that has one fitting its lane count."""
    n = len(sec["lanes"])
    ks = [k for k in range(len(seg_way)) if node_s[k] < sec["s1"] and node_s[k + 1] > sec["s0"]]
    for k in (reversed(ks) if last else ks):
        v = osm.ways[seg_way[k]]["tags"].get("turn:lanes")
        if parse_turn(v, n):
            return v
    return None


def lane_evidence(osm, sections, ids, seg_way, node_s, main_ways, st, to_local, spacing):
    """What the data says at each boundary: whether both placements are tagged, the nearest
    turn:lanes either side, and the ramps nearby with their side (for lib.lanes.decide_sides)."""
    found = []
    for k, kind, wid in ramps(osm, ids, main_ways):
        sr = float(node_s[k])
        if sr < -500 or sr > st["s"][-1] + 500:
            continue
        ns = osm.ways[wid]["nodes"]
        if osm.ways[wid]["tags"].get("oneway") == "-1":
            ns = ns[::-1]
        far = ns[min(2, len(ns) - 1)] if kind == "exit" else ns[max(0, len(ns) - 3)]
        lx, ly = (float(v) for v in to_local(*osm.nodes[far][:2]))
        jx, jy = (float(v) for v in to_local(*osm.nodes[ids[k]][:2]))
        i = int(np.clip(round(sr / spacing), 0, len(st["s"]) - 1))
        cross = np.cos(st["heading"][i]) * (ly - jy) - np.sin(st["heading"][i]) * (lx - jx)
        found.append({"s": sr, "kind": kind, "side": "left" if cross > 0 else "right", "way": wid})
    # each ramp counts only at the change of lane count nearest to it
    changes = [i for i in range(1, len(sections)) if len(sections[i]["lanes"]) != len(sections[i - 1]["lanes"])]
    for r in found:
        r["at"] = min(changes, key=lambda i: abs(float(sections[i]["s0"]) - r["s"])) if changes else None
    out = {}
    for i in range(1, len(sections)):
        P, C = sections[i - 1], sections[i]
        b = float(C["s0"])
        out[i] = {"placement_tagged": ("placement" in P, "placement" in C),
                  "turn_prev": turn_in(osm, seg_way, node_s, P, last=True),
                  "turn_cur": turn_in(osm, seg_way, node_s, C),
                  "ramps": [{**r, "ds": r["s"] - b} for r in found if r["at"] == i]}
    return out
