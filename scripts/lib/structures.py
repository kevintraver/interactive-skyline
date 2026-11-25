"""Structures by rule for the interchanges (plan 02, D3.4): where a road is on a deck, where its
piers stand, its abutment slopes, how far each road's embankment may reach before it would
bury another road, and the plan-overlap rule that every pair of road surfaces must keep.

All of it works on RoadFrames (lib.roadframe) of finished roads. Records are written as
format.js specifies them ("structures", road "bridges" and "embankment").
"""
import numpy as np

from .roadframe import RoadFrame

DECK = 1.2
EMBANKMENT = [[24.0, 6.0], [20.0, 40.0]]  # as src/drive/roadnet/mesher.js
EMB_W = EMBANKMENT[0][0] + EMBANKMENT[1][0]
SEPARATE = 4.9
MAX_SPAN = 38.0
PIER_T = 1.2  # m along the road
PIER_CLEAR = 1.0  # m from any pavement below
ABUT_SLOPE = 1.5  # horizontal per vertical


def emb_drop(e):
    (w1, d1), (w2, d2) = EMBANKMENT
    e = np.asarray(e, dtype=np.float64)
    return np.where(e <= w1, e * d1 / w1, d1 + (np.minimum(e, w1 + w2) - w1) * (d2 / w2))


def runs(mask, s, min_gap=0.0, min_len=0.0):
    """[(s0, s1)] of True runs in mask over stations s, gaps < min_gap closed, runs < min_len dropped."""
    out = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        if start is not None and (not v or i == len(mask) - 1):
            end = i if v else i - 1
            out.append([float(s[start]), float(s[end])])
            start = None
    merged = []
    for a, b in out:
        if merged and a - merged[-1][1] < min_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= min_len]


def surfaces_below(F, others, s, grow, min_drop):
    """Per station s of F: whether some other road's pavement (grown by `grow`) lies under F's
    pavement there, more than `min_drop` m lower."""
    pts = F.pavement_points(step=F.spacing, across=1.5)
    k = np.round(pts["s"] / F.spacing).astype(int)
    hit = np.zeros(len(s), dtype=bool)
    for B in others:
        if B is F:
            continue
        m, sb, db = B.inside(pts["x"], pts["y"], grow=grow)
        if not m.any():
            continue
        zb = B.surface(sb[m], db[m])
        low = pts["z"][m] - zb > min_drop
        hit[np.unique(k[m][low])] = True
    # and the other way round: every other road's own pavement that lies under F's, with `grow` m of F either side of
    # it, so that a road whose end lies under F (which F's points beyond that end do not see) is under a deck too
    reach = int(np.ceil(grow / F.spacing))
    x0, y0, x1, y1 = F.bbox
    for B in others:
        if B is F:
            continue
        bx0, by0, bx1, by1 = B.bbox
        if bx0 > x1 or bx1 < x0 or by0 > y1 or by1 < y0:
            continue
        pb = B.pavement_points(step=F.spacing / 2, across=1.5)
        m, sf, df = F.inside(pb["x"], pb["y"])
        if not m.any():
            continue
        low = F.surface(sf[m], df[m]) - pb["z"][m] > min_drop
        for i in np.unique(np.round(sf[m][low] / F.spacing).astype(int)):
            hit[max(0, i - reach):i + reach + 1] = True
    return hit


def deck_spans(F, others, ground, osm_bridge, grow=11.0):
    """Where F is on a deck: over another road (grown by `grow`, more than 3 m lower), or on an
    OSM bridge more than 3 m above the ground. Returns [(s0, s1)]."""
    s = np.arange(len(F.x)) * F.spacing
    over = surfaces_below(F, others, s, grow, 3.0)
    p = F.line.at(s)
    high = p["h"] - ground(p["x"], p["y"]) > 3.0
    mask = over | (osm_bridge & high)
    return runs(mask, s, min_gap=30.0, min_len=12.0)


def piers_and_abutments(F, spans, others, ground):
    """Piers along each deck span, never on a pavement below, about MAX_SPAN apart at most, and an
    abutment slope at each end. Returns structure records."""
    out = []
    p_all = None
    for s0, s1 in spans:
        cand = np.arange(s0 + 4, s1 - 4 + 1e-9, 2.0)
        ok = np.zeros(len(cand), dtype=bool)
        info = []
        for i, s in enumerate(cand):
            le, ri = F.edges(np.array([s]))
            le, ri = float(le[0]), float(ri[0])
            w = max(1.0, (le - ri) - 1.5)
            dc = (le + ri) / 2
            dd = np.linspace(dc - w / 2, dc + w / 2, max(2, int(np.ceil(w)) + 1))
            ss = np.concatenate([np.full(len(dd), s - PIER_T / 2), np.full(len(dd), s + PIER_T / 2)])
            dd2 = np.concatenate([dd, dd])
            x, y = F.xy(ss, dd2)
            top = float(F.surface(np.array([s]), np.array([dc]))[0]) - DECK
            g = ground(x, y)
            free = True
            for B in others:
                if B is F:
                    continue
                m, sb, db = B.inside(x, y, grow=PIER_CLEAR)
                if m.any() and (B.surface(sb[m], db[m]) < top - 0.5).any():
                    free = False
                    break
            bottom = float(g.min()) - 0.5
            ok[i] = free and top - bottom > 2.5
            info.append((s, dc, w, bottom, top))
        prev = s0
        while s1 - prev > MAX_SPAN:
            within = [i for i in range(len(cand)) if ok[i] and prev + 8 < cand[i] <= prev + MAX_SPAN]
            if within:
                i = within[-1]
            else:
                beyond = [i for i in range(len(cand)) if ok[i] and cand[i] > prev + MAX_SPAN]
                if not beyond:
                    break
                i = beyond[0]
            s, dc, w, bottom, top = info[i]
            if s1 - s < 8:
                break
            out.append({"kind": "pier", "road": F.id, "s": round(s, 2), "d": round(dc, 2), "w": round(w, 2),
                        "t": PIER_T, "h0": round(bottom, 2), "h1": round(top, 2)})
            prev = s
        for s_end, direction in ((s0, 1), (s1, -1)):
            le, ri = F.edges(np.array([s_end]))
            le, ri = float(le[0]), float(ri[0])
            dc = (le + ri) / 2
            top = float(F.surface(np.array([s_end]), np.array([dc]))[0]) - DECK
            # the toe: as far under the span as the slope reaches, short of any pavement below
            x, y = F.xy(np.array([s_end]), np.array([dc]))
            g0 = float(ground(x, y)[0])
            reach = max(0.0, (top - g0) * ABUT_SLOPE)
            span_len = s1 - s0
            reach = min(reach, span_len / 2 - 1)
            for t in np.arange(1.0, reach + 1e-9, 1.0):
                ss = np.full(5, s_end + direction * t)
                dd = np.linspace(ri, le, 5)
                xx, yy = F.xy(ss, dd)
                blocked = False
                for B in others:
                    if B is F:
                        continue
                    m, sb, db = B.inside(xx, yy, grow=PIER_CLEAR)
                    if m.any() and (B.surface(sb[m], db[m]) < top - 0.5).any():
                        blocked = True
                        break
                if blocked:
                    reach = max(0.0, t - 1.0)
                    break
            # the toe is the abutment's width across: it comes down to the lowest ground anywhere along it
            dd = np.linspace(ri - 0.5, le + 0.5, 9)
            xt, yt = F.xy(np.full(9, s_end + direction * reach), dd)
            g1 = float(np.min(ground(xt, yt)))
            if top - g1 < 0.5 or reach < 1:
                continue
            out.append({"kind": "abutment", "road": F.id, "s": round(s_end, 2), "dir": direction, "d": round(dc, 2),
                        "w": round(le - ri + 1.0, 2), "len": round(reach, 2), "h1": round(top, 2),
                        "h0": round(min(g0, g1) - 0.5, 2)})
    _ = p_all
    return out


def embankment_room(F, others, near_mask=None, step=1.0):
    """How far F's embankment may reach on each side before it would bury another road's
    pavement (one that is not well above it). Returns [{"s0", "s1", "side", "w"}] where w < EMB_W."""
    n = len(F.x)
    s = np.arange(n) * F.spacing
    idx = np.arange(n) if near_mask is None else np.flatnonzero(near_mask)
    out = []
    if not len(idx):
        return out
    ss = s[idx]
    le, ri = F.edges(ss)
    p = F.line.at(ss)
    t = np.arange(0.5, EMB_W + 1e-9, step)
    drop = emb_drop(t)
    for side, edge, sg in (("left", le, 1.0), ("right", ri, -1.0)):
        d = edge[:, None] + sg * t[None, :]
        nx, ny = -np.sin(p["heading"]), np.cos(p["heading"])
        x = p["x"][:, None] + d * nx[:, None]
        y = p["y"][:, None] + d * ny[:, None]
        ze = (p["h"] + p["crossfall"] * edge)[:, None] - drop[None, :]
        room = np.full(len(idx), EMB_W)
        for B in others:
            if B is F:
                continue
            m, sb, db = B.inside(x.ravel(), y.ravel(), grow=0.3)
            if not m.any():
                continue
            zb = np.full(m.shape, np.inf)
            zb[m] = B.surface(sb[m], db[m])
            hit = (m & (zb < ze.ravel() + 0.5)).reshape(x.shape)
            first = np.where(hit.any(axis=1), np.argmax(hit, axis=1), len(t))
            room = np.minimum(room, np.where(first < len(t), t[np.minimum(first, len(t) - 1)] - 0.5, EMB_W))
        # a narrow conflict holds for its neighbours too
        full = np.full(n, EMB_W)
        full[idx] = room
        full = np.minimum(full, np.minimum(np.r_[full[1:], EMB_W], np.r_[EMB_W, full[:-1]]))
        w = np.floor(full * 2) / 2
        k = 0
        while k < n:
            if w[k] >= EMB_W:
                k += 1
                continue
            j = k
            while j + 1 < n and w[j + 1] == w[k]:
                j += 1
            out.append({"s0": round(float(max(0.0, s[k] - F.spacing / 2)), 1),
                        "s1": round(float(min(s[-1], s[j] + F.spacing / 2)), 1), "side": side, "w": float(w[k])})
            k = j + 1
    out.sort(key=lambda r: (r["side"], r["s0"]))
    return out


def exempt_mask(junctions, a_id, a_s, b_id, b_s, pad=6.0):
    m = np.zeros(len(a_s), dtype=bool)
    for j in junctions:
        for x, y in (("a", "b"), ("b", "a")):
            if j[x]["road"] == a_id and j[y]["road"] == b_id:
                m |= ((a_s >= j[x]["s0"] - pad) & (a_s <= j[x]["s1"] + pad)
                      & (b_s >= j[y]["s0"] - pad) & (b_s <= j[y]["s1"] + pad))
    return m


def plan_overlaps(frames, junctions, step=2.0, across=1.0, shrink=0.05):
    """The rule of D3.4: wherever two road surfaces overlap in plan they are more than SEPARATE m
    apart vertically, or the overlap is covered by a junction record between them. Returns
    {"pairs": number of overlapping pairs, "violations": [...], "min_separation_m", "min_clearance_m"}
    (clearance: from the upper deck's soffit, DECK under its surface, to the lower surface)."""
    pts = {F.id: F.pavement_points(step=step, across=across) for F in frames}
    viol, pairs = [], 0
    min_sep, min_clear = np.inf, np.inf
    for i, A in enumerate(frames):
        pa = pts[A.id]
        for B in frames[i + 1:]:
            m, sb, db = B.inside(pa["x"], pa["y"], grow=-shrink)
            if not m.any():
                continue
            # A's points inside B, but not on A's own edge (touching pavements do not overlap)
            le, ri = A.edges(pa["s"][m])
            inner = (pa["d"][m] < le - shrink) & (pa["d"][m] > ri + shrink)
            mm = np.flatnonzero(m)[inner]
            if not len(mm):
                continue
            pairs += 1
            zb = B.surface(sb[mm], db[mm])
            dz = pa["z"][mm] - zb
            ex = exempt_mask(junctions, A.id, pa["s"][mm], B.id, sb[mm])
            bad = (np.abs(dz) <= SEPARATE) & ~ex
            sep = np.abs(dz[~ex])
            if len(sep):
                min_sep = min(min_sep, float(sep.min()))
                big = sep > SEPARATE
                if big.any():
                    min_clear = min(min_clear, float(sep[big].min() - DECK))
            if bad.any():
                k = np.flatnonzero(bad)
                viol.append({"a": A.id, "b": B.id, "points": int(bad.sum()),
                             "a_s": [round(float(pa["s"][mm][k].min()), 1), round(float(pa["s"][mm][k].max()), 1)],
                             "b_s": [round(float(sb[mm][k].min()), 1), round(float(sb[mm][k].max()), 1)],
                             "dz_m": round(float(np.abs(dz[k]).min()), 2)})
    return {"pairs": pairs, "violations": viol,
            "min_separation_m": None if not np.isfinite(min_sep) else round(min_sep, 2),
            "min_clearance_m": None if not np.isfinite(min_clear) else round(min_clear, 2)}


__all__ = ["RoadFrame", "deck_spans", "piers_and_abutments", "embankment_room", "plan_overlaps", "runs"]
