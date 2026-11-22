"""A lane to drive in (plan 02, task D3.8): which lane the car is in along a route.

The car is never in a lane that ends within 300 m (a lane ends where its taper starts to close
it), changes lane as rarely as possible, and is in a through lane at the end. Lanes are the
RoadNet lane ids, so "the same lane" means the same strip of pavement across sections.

    plan, markers, report = plan_lanes(sections, length, start_id, through_ids, speed_at)
    # plan: [{"s0": 0, "lane": 2}, {"s0": a, "s1": b, "lane": 3}, ...]  (routes.json "lanePlan")

Each change after the first entry moves one lane, from the previous entry's lane to `lane`, over
[s0, s1]: a quintic blend lasting CHANGE_SECONDS of travel at the posted speed there (longer
where a 1.0 m/s^2 lateral acceleration needs it), never inside a taper that moves either lane.
"""
import heapq

import numpy as np

from .crosssection import lane_centre, normalise_sections, tapers_of

END_CLEAR = 300.0  # m: never in a lane that ends this close ahead
CHANGE_SECONDS = 4.0
A_LAT = 0.95  # m/s^2 the duration is chosen for (the acceptance limit is 1.0)
Q5_PEAK = 10 / np.sqrt(3)  # peak of the quintic's second derivative, 5.774
GAP_SECONDS = 3.0  # between two changes in a row
MARGIN = 150.0  # m: a forced change finishes this far before it has to


def change_seconds(width):
    """Duration of a lane change across `width` metres: 4 s, or longer if 4 s would exceed A_LAT."""
    return max(CHANGE_SECONDS, float(np.sqrt(Q5_PEAK * width / A_LAT)))


def lane_extents(secs, length):
    """id -> (full_from, full_to, ends): where the lane has its full width, and whether it ends
    before the road does. A lane that only lives inside a taper is never full: (inf, -inf)."""
    tl = tapers_of(secs)

    def covering(j):  # the taper over section j's start, if any
        return next((tp for tp in tl if tp["from"] < j <= tp["i"]), None)

    first, last = {}, {}
    for i, sec in enumerate(secs):
        for l in sec["lanes"]:
            first.setdefault(l["id"], i)
            last[l["id"]] = i
    ids_of = [{l["id"] for l in sec["lanes"]} for sec in secs]
    out = {}
    for lid in first:
        a, b = first[lid], last[lid]
        lo, hi, ends = 0.0, float(length), b < len(secs) - 1
        if a > 0:
            tp = covering(a)
            lo = float(secs[a]["s0"]) if tp is None else (tp["s1"] if lid in ids_of[tp["i"]] else np.inf)
        if ends:
            tp = covering(b + 1)
            hi = float(secs[b + 1]["s0"]) if tp is None else (tp["s0"] if lid in ids_of[tp["from"]] else -np.inf)
        out[lid] = (float(lo), float(hi), ends)
    return out


def plan_lanes(sections, length, start_id, through_ids, speed_at):
    """See the module docstring. `speed_at(s)` is the posted speed in m/s; `through_ids` the lanes
    that go on past the end of the route (the others turn off there)."""
    secs = normalise_sections(sections)
    ext = lane_extents(secs, length)

    def allowed(lid, s):
        lo, hi, ends = ext[lid]
        return lo <= s <= (hi - END_CLEAR if ends else length)

    # segments between the points where the allowed set changes
    cuts = {0.0, float(length)}
    for lo, hi, ends in ext.values():
        if lo > hi:
            continue
        cuts.add(min(max(lo, 0.0), length))
        if ends:
            cuts.add(min(max(hi - END_CLEAR, 0.0), length))
    cuts = sorted(cuts)
    segs = [(a, b) for a, b in zip(cuts, cuts[1:]) if b - a > 1e-6]

    def order_at(s):
        k = max(i for i, sec in enumerate(secs) if sec["s0"] <= s)
        return [l["id"] for l in secs[k]["lanes"]]

    seg_info = []
    for a, b in segs:
        mid = (a + b) / 2
        ok = [lid for lid in order_at(mid) if allowed(lid, a + 1e-6) and allowed(lid, b - 1e-6)]
        seg_info.append({"a": a, "b": b, "order": order_at(mid), "ok": set(ok)})

    # shortest path over (segment, lane): staying costs 0, one lane over (within a segment) 1
    start = (0, start_id)
    if start_id not in seg_info[0]["ok"]:
        raise ValueError(f"the starting lane {start_id} is not drivable at the start")
    dist, prev = {start: (0, 0)}, {}
    heap = [(0, 0, 0, start_id)]
    goal = None
    while heap:
        cost, late, k, lid = heapq.heappop(heap)
        if (cost, late) > dist[(k, lid)]:
            continue
        if k == len(seg_info) - 1 and (not through_ids or lid in through_ids):
            goal = (k, lid)
            break
        nxt = []
        if k + 1 < len(seg_info) and lid in seg_info[k + 1]["ok"]:
            nxt.append(((k + 1, lid), cost, late))
        order = seg_info[k]["order"]
        if lid in order:
            p = order.index(lid)
            for q in (p - 1, p + 1):
                if 0 <= q < len(order) and order[q] in seg_info[k]["ok"]:
                    nxt.append(((k, order[q]), cost + 1, late - k))  # tie-break: change as late as possible
        for node, c, lt in nxt:
            if node not in dist or (c, lt) < dist[node]:
                dist[node], prev[node] = (c, lt), (k, lid)
                heapq.heappush(heap, (c, lt, node[0], node[1]))
    if goal is None:
        raise ValueError("no lane plan reaches a through lane at the end")
    path = [goal]
    while path[-1] in prev:
        path.append(prev[path[-1]])
    path.reverse()
    # path entries are (segment, lane); moves are lane changes within a segment
    moves = []
    for (k0, l0), (k1, l1) in zip(path, path[1:]):
        if k0 == k1 and l0 != l1:
            moves.append((k0, l0, l1))

    def lateral(lid, s):
        return lane_centre(secs, lid, np.atleast_1d(np.asarray(s, dtype=np.float64)))

    def still(lids, a, b):
        ss = np.linspace(a, b, 25)
        return all(np.ptp(lateral(lid, ss)) < 0.01 for lid in lids)

    # schedule the moves of each segment back to back, finishing MARGIN before the segment ends
    plan = [{"s0": 0, "lane": int(start_id)}]
    markers, report = [], []
    k = 0
    while k < len(moves):
        group = [m for m in moves if m[0] == moves[k][0]]
        seg = seg_info[group[0][0]]
        spans = []
        for _, a, b in group:
            sm = (seg["a"] + seg["b"]) / 2
            width = abs(float(lateral(a, sm)[0] - lateral(b, sm)[0]))
            T = change_seconds(width)
            spans.append((T, width))
        v = speed_at((seg["a"] + seg["b"]) / 2)
        total = sum(T * v for T, _ in spans) + GAP_SECONDS * v * (len(spans) - 1)
        end = seg["b"] - min(MARGIN, max(0.0, (seg["b"] - seg["a"] - total) / 2))
        best, clear = None, False
        for e in np.arange(end, seg["a"] + total - 1e-6, -10.0):
            ok = True
            s1 = e
            for (_, a, b), (T, _) in zip(reversed(group), reversed(spans)):
                s0 = s1 - T * speed_at(s1)
                if not still((a, b), s0, s1):
                    ok = False
                    break
                s1 = s0 - GAP_SECONDS * speed_at(s0)
            if best is None:
                best = e
            if ok:
                best, clear = e, True
                break
        s1 = best
        placed = []
        for (_, a, b), (T, width) in zip(reversed(group), reversed(spans)):
            s0 = s1 - T * speed_at(s1)
            placed.append((s0, s1, a, b, T, width))
            s1 = s0 - GAP_SECONDS * speed_at(s0)
        for s0, s1, a, b, T, width in reversed(placed):
            order = seg["order"]
            side = "left" if order.index(b) < order.index(a) else "right"
            plan.append({"s0": round(s0, 1), "s1": round(s1, 1), "lane": int(b)})
            pos = order.index(b) + 1
            markers.append({"s": round(s0, 1), "kind": "lane", "side": side, "lane": int(b),
                            "label": f"Move {side} to lane {pos}"})
            why = "lane ends" if ext[a][2] and ext[a][1] - END_CLEAR <= seg["b"] + 1e-6 else "through lane at the end"
            report.append({"s0": round(s0, 1), "s1": round(s1, 1), "from": int(a), "to": int(b), "side": side,
                           "seconds": round(T, 2), "width_m": round(width, 2), "why": why,
                           "clear_of_tapers": clear,
                           "from_lane_ends_at": round(ext[a][1], 1) if ext[a][2] else None})
        k += len(group)
    return plan, markers, report


def lane_at(plan, s):
    """The planned lane at s (the target lane from the start of a change)."""
    lid = plan[0]["lane"]
    for e in plan[1:]:
        if s >= e["s0"]:
            lid = e["lane"]
    return lid


def path_offsets(sections, plan, s):
    """The car's lateral offset at stations s (vectorised), as journey.js computes it."""
    secs = normalise_sections(sections)
    s = np.asarray(s, dtype=np.float64)
    d = lane_centre(secs, plan[0]["lane"], s)
    cur = plan[0]["lane"]
    for e in plan[1:]:
        nxt = e["lane"]
        ca, cb = lane_centre(secs, cur, s), lane_centre(secs, nxt, s)
        t = np.clip((s - e["s0"]) / (e["s1"] - e["s0"]), 0, 1)
        q = t * t * t * (t * (t * 6 - 15) + 10)
        m = s >= e["s0"]
        d = np.where(m & (s <= e["s1"]), ca + (cb - ca) * q, d)
        d = np.where(s > e["s1"], cb, d)
        cur = nxt
    return d


def path_dynamics(sections, plan, speed_at, length, step=1.0):
    """Lateral acceleration and jerk of the planned path relative to the reference line (v^2 d''
    and its rate), and where the path has no lane under it."""
    s = np.arange(0, length + 1e-9, step)
    d = path_offsets(sections, plan, s)
    gaps = s[np.isnan(d)]
    v = np.array([speed_at(x) for x in s])
    d1 = np.gradient(d, step)
    d2 = np.gradient(d1, step)
    a = v * v * d2
    jerk = np.gradient(a, step) * v
    ok = ~np.isnan(a) & ~np.isnan(jerk)
    ia = int(np.argmax(np.where(ok, np.abs(a), -1)))
    ij = int(np.argmax(np.where(ok, np.abs(jerk), -1)))
    return {"max_lateral_accel": round(float(abs(a[ia])), 3), "at_s": float(s[ia]),
            "max_lateral_jerk": round(float(abs(jerk[ij])), 3), "jerk_at_s": float(s[ij]),
            "no_lane_at": [float(x) for x in gaps[:10]], "no_lane_count": int(len(gaps))}
