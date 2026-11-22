"""Acceptance checks of the road pipeline that look at a built road: the pavement above the terrain,
the two carriageways side by side and clear of each other, lane counts against OSM, and how fast
lane edges move sideways. All of them read the tapered cross-section (lib.crosssection), the
same one the browser meshes.
"""
import numpy as np

from .crosssection import normalise_sections, pavement_edges
from .lanes import RATE, max_edge_rate
from .refline import Refline


def check_clearance(road_dec, hs, top, along=1.0, across=0.5):
    """Lowest height of the pavement (lanes and shoulders, tapers included, with crossfall, as the
    refline interpolates it) above the ground, sampled every `along` m and `across` m. Returns the
    minimum against the drawn surface and against the bilinear height query, and where."""
    line = Refline(road_dec)
    secs = normalise_sections(road_dec["sections"])
    s = np.arange(0, line.length + 1e-9, along)
    worst = {"drawn": (np.inf, 0.0), "query": (np.inf, 0.0)}
    for c in range(0, len(s), 4000):
        ss = s[c:c + 4000]
        p = line.at(ss)
        le, ri = pavement_edges(secs, ss)
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


def _stretches(mask, s):
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        if (not v or i == len(mask) - 1) and start is not None:
            end = i if v else i - 1
            out.append({"s0": float(s[start]), "s1": float(s[end])})
            start = None
    return out


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
    return {
        "apart_m": {"min": round(float(d.min()), 1), "median": round(float(np.median(d)), 1), "max": round(float(d.max()), 1)},
        "opposite_on_left_everywhere": bool(np.all(lateral > 0)),
        "wrong_side": _stretches(lateral <= 0, s),
        "far_apart_over_45m": _stretches(d > 45, s),
        "height_differs_over_3m": _stretches(np.abs(dh) > 3, s),
        "per_km": per_km,
    }


def _median_edge(road):
    """Points of a road's left (median-side) pavement edge at every station, and its normals."""
    secs = normalise_sections(road["sections"])
    s = np.arange(road["count"]) * road["spacing"]
    left, _ = pavement_edges(secs, s)
    nx, ny = -np.sin(road["heading"]), np.cos(road["heading"])
    return road["x"] + left * nx, road["y"] + left * ny, left, nx, ny


def plan_overlap(main, opp):
    """The narrowest gap in plan between the two carriageways' pavements (median edge to median
    edge, tapers included), seen from each road in turn; negative means they overlap. Returns
    {"min_gap_m", "at_s" (on the road it was seen from), "from", "overlap_stretches"}."""
    from scipy.spatial import cKDTree

    worst = {"min_gap_m": np.inf}
    stretches = []
    for a, b, name in ((main, opp, "main"), (opp, main, "opposite")):
        ex, ey, left, nx, ny = _median_edge(a)
        bx, by, _, _, _ = _median_edge(b)
        tree = cKDTree(np.column_stack([b["x"], b["y"]]))
        _, j = tree.query(np.column_stack([a["x"], a["y"]]))
        # the other road's median edge, sideways from this road's reference line, against this road's edge
        lat = (bx[j] - a["x"]) * nx + (by[j] - a["y"]) * ny
        gap = lat - left
        # only where the other road actually runs alongside (both ends of a route may diverge)
        alongside = np.hypot(b["x"][j] - a["x"], b["y"][j] - a["y"]) < 200
        gap = np.where(alongside, gap, np.inf)
        i = int(np.argmin(gap))
        s = np.arange(a["count"]) * a["spacing"]
        stretches += [{**st, "from": name} for st in _stretches(gap < 0, s)]
        if gap[i] < worst["min_gap_m"]:
            worst = {"min_gap_m": float(gap[i]), "at_s": float(s[i]), "from": name}
    worst["min_gap_m"] = round(worst["min_gap_m"], 2)
    worst["overlap_stretches"] = stretches
    return worst


def lane_counts_match(sections, osm_runs, length, n=200, seed=11):
    """Lane counts of the built sections against the OSM ways at n random chainages."""
    rng = np.random.default_rng(seed)
    s = rng.uniform(0, length, n)
    out = []
    for v in s:
        built = next(len(sec["lanes"]) for sec in sections if sec["s0"] <= v <= sec["s1"])
        osm = next(r[2][0] for r in osm_runs if r[0] <= v <= r[1])
        if built != osm:
            out.append({"s": round(float(v), 1), "built": built, "osm": osm})
    return {"stations": n, "matching": n - len(out), "mismatches": out}


def edge_rates(road_dec):
    """The fastest sideways movement of any lane edge (metres per metre) over the road, and
    whether every boundary where the cross-section changes has a taper."""
    s = np.arange(0, road_dec["length"] + 1e-9, 0.5)
    rate, at = max_edge_rate(road_dec["sections"], s)
    from .crosssection import tapers_of
    from .lanes import boundary_geometry
    secs = normalise_sections(road_dec["sections"])
    covered = {j for tp in tapers_of(secs) for j in range(tp["from"] + 1, tp["i"] + 1)}
    abrupt = [secs[i]["s0"] for i in range(1, len(secs))
              if i not in covered and boundary_geometry(secs[i - 1], secs[i])[0] > 1e-6]
    return {"max_m_per_m": round(rate, 4), "at_s": at, "limit": round(1 / RATE, 4), "abrupt_changes": abrupt}
