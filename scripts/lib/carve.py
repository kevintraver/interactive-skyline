"""The road's cuts in a terrain patch, for build_terrain.py.

The elevation source predates part of the roads the drive follows: in Black Canyon it has the ridges that
I-11 (opened in 2018) cuts through. build_roads.py never puts a road below the ground, so over that ground
the road rides high above every wash on embankments to clear every ridge. A patch can name routes to
carve: for each of their carriageways a design profile is laid along the ground (the lowest-cost profile
within the grade and vertical-curve limits that build_roads.py uses, fill costing more than cut, as a
highway's designer balances earthwork), and the patch's posts are lowered under it, a bench either side
of the pavement and then a steep rock cut up to the natural ground. build_roads.py then lays the road on
the carved ground by its usual rule and finds the cuts already there.

Only the patch is carved, before it is eased into the wide grid at its edge. Under an OSM bridge the design
costs nothing (the deck spans whatever is there) and the ground is only lowered where it stands within
BRIDGE_CLEAR of the design line: the source still has the spurs the bridges' approaches were cut through. The plan of a road (its stations, headings and widths) does not depend on heights, so it is
read from the route's RoadNet as built: carving first and building the road after is not circular.

    roads = carriageways(roadnet_doc, roadnet_blob, ["us93.main", "us93s.opp"])
    h2, report = carve(h, grid, roads)   # h: (ny, nx) heights in metres on the patch's posts
"""
import numpy as np
from scipy.optimize import linprog
from scipy.spatial import cKDTree
from scipy.sparse import csr_matrix, diags, eye, hstack, vstack

from .crosssection import normalise_sections, pavement_edges
from .roadnet import decode_roadnet

GRADE = 0.0595  # as build_roads.py's GRADE_SOLVE
RADIUS = 3000.0  # m: no tighter than build_roads.py's vertical curves at 65 mph
FILL_COST, CUT_COST = 2.0, 1.0  # embankment shows from the car more than a cut does
MAX_CUT = 60.0  # m: deepest cut the design may take
DROP = 0.8  # m the carved bench lies below the design line (crossfall, the clearance build_roads adds)
WALL = 1.5  # rise per metre of the cut faces beyond the bench (rock cut, about 1:0.67)
BRIDGE_CLEAR = 6.0  # m kept clear under the design line of a bridge
PAIR_M = 60.0  # a carriageway within this of one designed before it follows that one's design
PAIR_COST = 8.0  # per metre of height away from it: the two carriageways of a divided highway stay level
LEAD_GRADE = 0.057  # the first carriageway's design grade: on a curve the other one, inside it, is a few % shorter


def bench_width(step):
    """Metres of flat bench beyond the pavement edge: build_roads.py samples the ground 2 m outside the edges, and a
    bilinear height there feels the posts a whole step away."""
    return 2.0 + step + 2.0


def carriageways(doc, blob, ids):
    """The plan of each named road: stations, headings, pavement edges, OSM bridges."""
    out = []
    for r in decode_roadnet(doc, blob):
        if r["id"] not in ids:
            continue
        s = np.arange(r["count"]) * r["spacing"]
        left, right = pavement_edges(normalise_sections(r["sections"]), s)
        bridge = np.zeros(r["count"], dtype=bool)
        for b in r.get("bridges", []):
            bridge |= (s >= b["s0"]) & (s <= b["s1"])
        out.append({"id": r["id"], "s": s, "x": r["x"], "y": r["y"], "heading": r["heading"], "left": left,
                    "right": right, "bridge": bridge, "spacing": r["spacing"]})
    return out


def design_profile(g, weight, spacing, grade=GRADE, radius=RADIUS, fill_cost=FILL_COST, cut_cost=CUT_COST,
                   max_cut=MAX_CUT, ref=None, ref_weight=None):
    """The profile z over ground g (one value per station) with |grade| <= grade and vertical curves no tighter
    than radius that minimises sum(weight * (fill_cost * fill + cut_cost * cut)), cuts at most max_cut deep.
    With ref (heights per station, NaN where none) it also pays ref_weight per metre away from ref."""
    if ref is not None:
        return _design_with_ref(g, weight, spacing, grade, radius, fill_cost, cut_cost, max_cut, ref, ref_weight)
    n = len(g)
    d1 = diags([-np.ones(n - 1), np.ones(n - 1)], [0, 1], shape=(n - 1, n))
    d2 = diags([np.ones(n - 2), -2 * np.ones(n - 2), np.ones(n - 2)], [0, 1, 2], shape=(n - 2, n))
    z1, z2 = csr_matrix((n - 1, n)), csr_matrix((n - 2, n))
    a_ub = vstack([hstack([d1, z1, z1]), hstack([-d1, z1, z1]), hstack([d2, z2, z2]), hstack([-d2, z2, z2])]).tocsr()
    b_ub = np.concatenate([np.full(2 * (n - 1), grade * spacing), np.full(2 * (n - 2), spacing**2 / radius)])
    a_eq = hstack([eye(n), -eye(n), eye(n)]).tocsr()  # z - fill + cut = g
    cost = np.concatenate([np.zeros(n), fill_cost * weight, cut_cost * weight])
    base = float(np.min(g))
    bounds = [(None, None)] * n + [(0, None)] * n + [(0, max_cut)] * n
    res = linprog(cost, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=np.asarray(g, float) - base, bounds=bounds,
                  method="highs")
    if res.status != 0:
        raise RuntimeError(f"design profile LP failed: {res.message}")
    return res.x[:n] + base


def _design_with_ref(g, weight, spacing, grade, radius, fill_cost, cut_cost, max_cut, ref, ref_weight):
    n = len(g)
    has = np.isfinite(ref)
    r = np.where(has, ref, 0.0)
    rw = np.where(has, ref_weight, 0.0)
    d1 = diags([-np.ones(n - 1), np.ones(n - 1)], [0, 1], shape=(n - 1, n))
    d2 = diags([np.ones(n - 2), -2 * np.ones(n - 2), np.ones(n - 2)], [0, 1, 2], shape=(n - 2, n))
    z1, z2 = csr_matrix((n - 1, n)), csr_matrix((n - 2, n))
    zero = lambda m: [m] * 4  # noqa: E731
    a_ub = vstack([hstack([d1, *zero(z1)]), hstack([-d1, *zero(z1)]), hstack([d2, *zero(z2)]), hstack([-d2, *zero(z2)])]).tocsr()
    b_ub = np.concatenate([np.full(2 * (n - 1), grade * spacing), np.full(2 * (n - 2), spacing**2 / radius)])
    e, zn = eye(n), csr_matrix((n, n))
    # z - fill + cut = g ; z - above + below = ref
    a_eq = vstack([hstack([e, -e, e, zn, zn]), hstack([e, zn, zn, -e, e])]).tocsr()
    base = float(np.min(g))
    b_eq = np.concatenate([np.asarray(g, float) - base, r - base])
    cost = np.concatenate([np.zeros(n), fill_cost * weight, cut_cost * weight, rw, rw])
    bounds = [(None, None)] * n + [(0, None)] * n + [(0, max_cut)] * n + [(0, None)] * (2 * n)
    res = linprog(cost, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=b_eq, bounds=bounds, method="highs")
    if res.status != 0:
        raise RuntimeError(f"design profile LP failed: {res.message}")
    return res.x[:n] + base


def carve(h, grid, roads):
    """Lower the patch's posts under each road's design profile. h is (ny, nx) metres, row 0 = south, on grid's posts
    (x0, y0, step, nx, ny). Returns the carved heights and a report per road."""
    out = np.array(h, dtype=np.float64)
    step = grid["step"]
    x1 = grid["x0"] + (grid["nx"] - 1) * step
    y1 = grid["y0"] + (grid["ny"] - 1) * step
    xs = grid["x0"] + np.arange(grid["nx"]) * step
    ys = grid["y0"] + np.arange(grid["ny"]) * step
    gx, gy = np.meshgrid(xs.astype(np.float64), ys.astype(np.float64))

    def sample(x, y):
        fx = np.clip((x - grid["x0"]) / step, 0, grid["nx"] - 1.001)
        fy = np.clip((y - grid["y0"]) / step, 0, grid["ny"] - 1.001)
        i, j = np.floor(fx).astype(int), np.floor(fy).astype(int)
        ax, ay = fx - i, fy - j
        return ((1 - ay) * ((1 - ax) * h[j, i] + ax * h[j, i + 1]) + ay * ((1 - ax) * h[j + 1, i] + ax * h[j + 1, i + 1]))

    bench = bench_width(step)
    report = {}
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    designed = []  # (tree over stations, design heights) of the carriageways designed so far
    for r in roads:
        on = (r["x"] > grid["x0"]) & (r["x"] < x1) & (r["y"] > grid["y0"]) & (r["y"] < y1)
        if on.sum() < 3:
            continue
        k = np.flatnonzero(on)
        k = np.arange(k[0], k[-1] + 1)  # one run: a road crosses the patch once
        g = sample(r["x"][k], r["y"][k])
        weight = (~r["bridge"][k]).astype(float)
        ref = np.full(len(k), np.nan)
        for t_prev, z_prev in designed:
            dd, nn = t_prev.query(np.column_stack([r["x"][k], r["y"][k]]), distance_upper_bound=PAIR_M)
            near = np.isfinite(dd) & ~np.isfinite(ref)
            ref[near] = z_prev[nn[near]]
        paired = int(np.isfinite(ref).sum())
        z = design_profile(g, weight, r["spacing"], grade=GRADE if designed else LEAD_GRADE,
                           ref=ref if paired else None, ref_weight=np.full(len(k), PAIR_COST))
        tree = cKDTree(np.column_stack([r["x"][k], r["y"][k]]))
        designed.append((tree, z))
        reach = float(np.max(np.maximum(r["left"][k], -r["right"][k]))) + bench + MAX_CUT / WALL + step
        dist, near = tree.query(pts, distance_upper_bound=reach)
        hit = np.isfinite(dist)
        q = near[hit]
        hd = r["heading"][k][q]
        dx, dy = pts[hit, 0] - r["x"][k][q], pts[hit, 1] - r["y"][k][q]
        along = dx * np.cos(hd) + dy * np.sin(hd)
        lateral = -dx * np.sin(hd) + dy * np.cos(hd)
        half = np.where(lateral > 0, r["left"][k][q], -r["right"][k][q])
        excess = np.maximum(0, np.abs(lateral) - half - bench)
        allowed = z[q] - np.where(r["bridge"][k][q], BRIDGE_CLEAR, DROP) + excess * WALL
        ok = np.abs(along) <= r["spacing"]
        flat = out.ravel()  # a view: writes go into out
        idx = np.flatnonzero(hit)[ok]
        before = flat[idx].copy()
        flat[idx] = np.minimum(flat[idx], allowed[ok])
        cut = before - flat[idx]
        fill = np.maximum(z - g, 0)[weight > 0]
        report[r["id"]] = {"stations": [float(r["s"][k[0]]), float(r["s"][k[-1]])],
                           "design_fill_m": {"mean": round(float(fill.mean()), 2), "max": round(float(fill.max()), 1)},
                           "design_cut_m": {"mean": round(float(np.maximum(g - z, 0)[weight > 0].mean()), 2),
                                            "max": round(float(np.maximum(g - z, 0)[weight > 0].max()), 1)},
                           "posts_lowered": int((cut > 0).sum()), "deepest_post_cut_m": round(float(cut.max()), 1),
                           "stations_paired": paired}
    return out, report
