"""The two carriageways side by side: where they run so close that their inside shoulders would
overlap, those shoulders are narrowed (the lanes never move). Called by build_roads.py between
planning both carriageways and finishing them, so that the tapers and the profile see the final
shoulders.
"""
import numpy as np

from .crosssection import left_edge_offset, normalise_sections

MEDIAN_GAP = 0.6  # m kept between the two carriageways' pavements where inside shoulders are narrowed


def narrow_inside_shoulders(pa, pb, window=300.0, spacing=4.0):
    """Where the two carriageways run so close that their inside (left) shoulders would overlap,
    narrow those shoulders, equally on both, to leave MEDIAN_GAP between the pavements. Lanes are
    never moved. Works per section, on the widest lanes within `window` m (tapers reach that far)
    so that every taper between sections stays clear too. Returns what it changed."""
    from scipy.spatial import cKDTree

    def lane_left(p):
        secs = normalise_sections(p["sections"])
        s = p["st"]["s"]
        o = np.zeros(len(s))
        for sec in secs:
            o[(s >= sec["s0"]) & (s <= sec["s1"])] = np.maximum(o[(s >= sec["s0"]) & (s <= sec["s1"])], left_edge_offset(sec))
        k = int(window / spacing)
        pad = np.r_[np.full(k, o[0]), o, np.full(k, o[-1])]
        return np.max(np.lib.stride_tricks.sliding_window_view(pad, 2 * k + 1), axis=1), secs

    la, sa = lane_left(pa)
    lb, sb = lane_left(pb)
    changed = []
    for p, l_own, l_other, q, secs in ((pa, la, lb, pb, sa), (pb, lb, la, pa, sb)):
        A, B = p["st"], q["st"]
        dist, j = cKDTree(np.column_stack([B["x"], B["y"]])).query(np.column_stack([A["x"], A["y"]]))
        nx, ny = -np.sin(A["heading"]), np.cos(A["heading"])
        sep = (B["x"][j] - A["x"]) * nx + (B["y"][j] - A["y"]) * ny
        room = np.where(dist < 200, (sep - l_own - l_other[j] - MEDIAN_GAP) / 2, np.inf)
        s = A["s"]
        for sec, nsec in zip(p["sections"], secs):
            m = (s >= sec["s0"] - window) & (s <= sec["s1"] + window)
            have = nsec["left"]["shoulder"]
            fit = float(np.floor(max(0.0, room[m].min()) / 0.05) * 0.05) if m.any() else have
            if fit < have - 1e-9:
                sec["left"] = {**(sec.get("left") or {}), "shoulder": round(fit, 2)}
                sec["provenance"]["widths"] = "rule; inside shoulder narrowed to clear the opposite carriageway"
                changed.append({"road": p["road_id"], "s0": sec["s0"], "s1": sec["s1"], "shoulder_m": round(fit, 2), "was_m": have})
    return changed
