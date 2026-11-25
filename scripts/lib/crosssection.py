"""The cross-section of a road at a chainage: the Python twin of src/drive/roadnet/crosssection.js.
Change both together; tests hold them to 1 mm. The rules (lane ids, tapers and how they blend)
are specified at the top of src/drive/roadnet/format.js.

    secs = normalise_sections(road["sections"])     # fills the format's defaults
    cs = edges_at(secs, s)                          # one chainage: strips, lines, edges, left, right
    left, right = pavement_edges(secs, s_array)     # outer shoulder edges, vectorised
    d = lane_centre(secs, lane_id, s_array)         # a lane's centre, vectorised (nan where absent)

Offsets are metres from the reference line, positive to the left.
"""
import numpy as np

LANE_W = 3.66
SHOULDER_WIDE, SHOULDER_NARROW = 3.05, 1.22


def normalise_sections(sections):
    """Sections with the format's defaults filled in (as decodeRoadNet does)."""
    out = []
    for sec in sections:
        lanes = [{"w": l.get("w", LANE_W), "kind": l.get("kind", "drive"), "line": l.get("line", "broken"),
                  "id": l.get("id", j + 1)} for j, l in enumerate(sec["lanes"])]
        n = len(lanes)
        left = {"shoulder": SHOULDER_WIDE if n >= 3 else SHOULDER_NARROW, "edge": "yellow", **(sec.get("left") or {})}
        right = {"shoulder": SHOULDER_WIDE, "edge": "white", **(sec.get("right") or {})}
        out.append({**sec, "lanes": lanes, "left": left, "right": right, "placement": sec.get("placement", "centre")})
    return out


def left_edge_offset(sec):
    widths = [l["w"] for l in sec["lanes"]]
    if sec["placement"] == "centre":
        return sum(widths) / 2
    kind, num = sec["placement"].split(":")
    n = int(num)
    before = sum(widths[:n - 1])
    if kind == "left_of":
        return before
    if kind == "middle_of":
        return before + widths[n - 1] / 2
    return before + widths[n - 1]


def blend(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def union_ids(a, b):
    """Lane ids of two consecutive sections in order: previous-only first, then this-only, then shared."""
    in_a, in_b = set(a), set(b)
    out, i, j = [], 0, 0
    while i < len(a) or j < len(b):
        if i < len(a) and a[i] not in in_b:
            out.append(a[i])
            i += 1
        elif j < len(b) and b[j] not in in_a:
            out.append(b[j])
            j += 1
        else:
            out.append(a[i])
            i += 1
            j += 1
    return out


def section_index(secs, s, side="after"):
    starts = np.array([sec["s0"] for sec in secs], dtype=np.float64)
    s = np.asarray(s, dtype=np.float64)
    k = np.searchsorted(starts, s, side="left" if side == "before" else "right") - 1
    return np.clip(k, 0, len(secs) - 1)


def tapers_of(secs):
    """The road's tapers in order: [{"i": section, "from": section it blends from, "s0", "s1"}]."""
    out = []
    for i, sec in enumerate(secs):
        tp = sec.get("taper")
        if not tp:
            continue
        frm = i - 1
        while frm > 0 and secs[frm]["s0"] > tp["s0"]:
            frm -= 1
        out.append({"i": i, "from": frm, "s0": float(tp["s0"]), "s1": float(tp["s1"])})
    return out


def taper_at(secs, s, side="after"):
    """Index into tapers_of(secs) of the taper holding each s ('after': s0 <= s < s1; 'before':
    s0 < s <= s1), or -1. Vectorised over s."""
    tl = tapers_of(secs)
    s = np.asarray(s, dtype=np.float64)
    if not tl:
        return np.full(s.shape, -1, dtype=np.intp)
    s0 = np.array([x["s0"] for x in tl])
    s1 = np.array([x["s1"] for x in tl])
    k = np.searchsorted(s0, s, side="left" if side == "before" else "right") - 1
    kk = np.maximum(k, 0)
    inside = (s <= s1[kk]) if side == "before" else (s < s1[kk])
    return np.where((k >= 0) & inside, k, -1)


def _assemble(lanes, o, sl, sr, edge_l, edge_r, hidden, index, taper):
    strips, lines = [], []
    d = o
    left_outer = d + sl
    strips.append({"kind": "shoulder", "side": "left", "left": left_outer, "right": d})
    lines.append({"d": d, "kind": edge_l, "edge": "left"})
    for i, lane in enumerate(lanes):
        right = d - lane["w"]
        strips.append({"kind": "lane", "lane": i, "id": lane["id"], "laneKind": lane["kind"], "left": d, "right": right})
        if i < len(lanes) - 1:
            lines.append({"d": right, "kind": "none" if hidden(i) else lane["line"], "edge": "lane"})
        d = right
    lines.append({"d": d, "kind": edge_r, "edge": "right"})
    strips.append({"kind": "shoulder", "side": "right", "left": d, "right": d - sr})
    edges = [left_outer] + [ln["d"] for ln in lines] + [d - sr]
    return {"sectionIndex": index, "strips": strips, "lines": lines, "edges": edges, "left": left_outer,
            "right": edges[-1], "taper": taper}


def edges_at(secs, s, side="after"):
    """The cross-section at one chainage, as edgesAt in crosssection.js returns it."""
    s = float(s)
    index = int(section_index(secs, s, side))
    k = int(taper_at(secs, s, side))
    if k < 0:
        sec = secs[index]
        return _assemble(sec["lanes"], left_edge_offset(sec), sec["left"]["shoulder"], sec["right"]["shoulder"],
                         sec["left"]["edge"], sec["right"]["edge"], lambda i: False, index, None)
    tp = tapers_of(secs)[k]
    prev, cur = secs[tp["from"]], secs[tp["i"]]
    t = (s - tp["s0"]) / (tp["s1"] - tp["s0"])
    u = float(blend(t))
    mid = (tp["s0"] + tp["s1"]) / 2  # kinds switch here, compared in s as the mesher cuts
    late = s > mid if side == "before" else s >= mid
    pa = {l["id"]: l for l in prev["lanes"]}
    pb = {l["id"]: l for l in cur["lanes"]}
    lanes = []
    for lid in union_ids([l["id"] for l in prev["lanes"]], [l["id"] for l in cur["lanes"]]):
        a, b = pa.get(lid), pb.get(lid)
        src = b or a
        lanes.append({"id": lid, "w": (1 - u) * (a["w"] if a else 0.0) + u * (b["w"] if b else 0.0),
                      "kind": src["kind"], "line": src["line"], "only_prev": b is None, "only_cur": a is None})

    def thin(lane):
        return lane["only_prev"] if late else lane["only_cur"]

    frm = cur if late else prev
    return _assemble(
        lanes, (1 - u) * left_edge_offset(prev) + u * left_edge_offset(cur),
        (1 - u) * prev["left"]["shoulder"] + u * cur["left"]["shoulder"],
        (1 - u) * prev["right"]["shoulder"] + u * cur["right"]["shoulder"],
        frm["left"]["edge"], frm["right"]["edge"], lambda i: thin(lanes[i]) or thin(lanes[i + 1]),
        index, {"index": tp["i"], "from": tp["from"], "t": t, "u": u, "half": 1 if late else 0})


def _blend_terms(secs, s):
    """Per s: the section blended to, the section blended from (the same outside tapers), and u."""
    s = np.asarray(s, dtype=np.float64)
    k = section_index(secs, s)
    ti = taper_at(secs, s)
    tl = tapers_of(secs)
    if not tl:
        return k, k, np.ones(s.shape)
    ii = np.maximum(ti, 0)
    s0 = np.array([x["s0"] for x in tl])[ii]
    s1 = np.array([x["s1"] for x in tl])[ii]
    u = np.where(ti >= 0, blend((s - s0) / (s1 - s0)), 1.0)
    cur = np.where(ti >= 0, np.array([x["i"] for x in tl])[ii], k)
    prev = np.where(ti >= 0, np.array([x["from"] for x in tl])[ii], k)
    return cur, prev, u


def pavement_edges(secs, s):
    """Outer shoulder edges (left, right) at each s, vectorised. Matches edges_at(...)["left"/"right"]."""
    cur, prev, u = _blend_terms(secs, s)
    o = np.array([left_edge_offset(sec) for sec in secs])
    w = np.array([sum(l["w"] for l in sec["lanes"]) for sec in secs])
    sl = np.array([sec["left"]["shoulder"] for sec in secs])
    sr = np.array([sec["right"]["shoulder"] for sec in secs])
    lerp = lambda a: (1 - u) * a[prev] + u * a[cur]  # noqa: E731
    oo = lerp(o)
    return oo + lerp(sl), oo - lerp(w) - lerp(sr)


def lane_centre(secs, lane_id, s):
    """Centre offset of the lane with this id at each s (vectorised); nan where the road has no
    such lane, or where it has no width (the ends of a taper that opens or closes it)."""
    s = np.asarray(s, dtype=np.float64)
    cur, prev, u = _blend_terms(secs, s)
    out = np.full(s.shape, np.nan)
    # per section pair, the offset of the lane's left edge from lane 1's left edge, and its width
    for a_i, b_i in set(zip(prev.tolist(), cur.tolist())):
        m = (prev == a_i) & (cur == b_i)
        A, B = secs[a_i], secs[b_i]
        ids = [l["id"] for l in A["lanes"]] if a_i == b_i else union_ids([l["id"] for l in A["lanes"]], [l["id"] for l in B["lanes"]])
        if lane_id not in ids:
            continue
        wa = {l["id"]: l["w"] for l in A["lanes"]}
        wb = {l["id"]: l["w"] for l in B["lanes"]}
        k = ids.index(lane_id)
        uu = u[m]
        before = sum((1 - uu) * wa.get(x, 0.0) + uu * wb.get(x, 0.0) for x in ids[:k]) if k else 0.0
        width = (1 - uu) * wa.get(lane_id, 0.0) + uu * wb.get(lane_id, 0.0)
        o = (1 - uu) * left_edge_offset(A) + uu * left_edge_offset(B)
        out[m] = np.where(width > 1e-9, o - before - width / 2, np.nan)
    return out
