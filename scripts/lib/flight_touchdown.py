"""Independent evidence for a recorded flight's touchdown time (plan 03; the validation's open finding of 25
November). The bake takes the touchdown where the barometric vertical rate levels on the runway (adsb.refine_touchdown).
Two other channels of the same trace say when the wheels met the runway, independently of that rate:

  geometric height  The geometric altitude is reported in 25 ft (7.62 m) steps. A step down means the antenna crossed
                    the boundary between two steps (taken half way between their calibrated values). The last such
                    crossing below GEOMETRIC_MAX_CROSSING_M over the antenna's height on the runway, carried down by a
                    flare at FLARE_MEAN_SINK_MS, gives a touchdown time. Its uncertainty: half a step at that sink rate
                    (1.9 s), the half second between reports, and the receiver's latency (readsb time-stamps a position
                    when it is received; ADS-B's own latency is under about 0.6 s).
  braking onset     Along-runway distance from the raw positions alone, fitted with one constant acceleration before
                    a break and another after it; the break is the onset of sustained deceleration. Ground spoilers
                    and wheel brakes act within about a second of main-gear touchdown, reverse thrust and manual
                    braking later: the onset is a late bound, 0 to about 5 s after the touchdown.

A geometric vertical rate (`geom_rate`) would be a third; none of the flights selected records it.
"""
import numpy as np

STEP_M = 25 * 0.3048
GEOMETRIC_MAX_CROSSING_M = 12.0
FLARE_MEAN_SINK_MS = 2.0          # m/s over the last metres of a flare from 6 to 10 m in 3 to 5 s (estimate)


def geometric_touchdown(t, h_cal, ground, t_ref, window=(-25.0, 8.0)):
    """Touchdown time from the steps of calibrated geometric antenna heights `h_cal` (m) at times `t`, over the
    antenna's height on the runway `ground` (m, per point). Returns {t, crossingT, crossingHeightM, sigmaS} or None."""
    t = np.asarray(t, dtype=float)
    h = np.asarray(h_cal, dtype=float)
    g = np.asarray(ground, dtype=float)
    m = np.flatnonzero(np.isfinite(h) & (t > t_ref + window[0]) & (t < t_ref + window[1]))
    best = None
    for a, b in zip(m[:-1], m[1:]):
        if h[b] < h[a] - 1.0:                                # a step down
            hc = 0.5 * (h[a] + h[b]) - g[b]
            if 0 < hc <= GEOMETRIC_MAX_CROSSING_M:
                best = (0.5 * (t[a] + t[b]), hc, t[b] - t[a])
    if best is None:
        return None
    tc, hc, gap = best
    sigma = float(np.hypot(np.hypot(0.5 * STEP_M / FLARE_MEAN_SINK_MS, 0.5 * gap), 0.6))
    return {"t": float(tc + hc / FLARE_MEAN_SINK_MS), "crossingT": float(tc), "crossingHeightM": float(hc),
            "sigmaS": sigma}


def braking_onset(t, along, t_ref, window=(-25.0, 25.0), search=(-15.0, 15.0), step=0.1):
    """Onset of sustained deceleration in along-runway distance `along` (m) at times `t`: the break of a fit with a
    constant acceleration on each side. Returns {t, decelBeforeMs2, decelAfterMs2, rmsM, points} or None."""
    t = np.asarray(t, dtype=float)
    s = np.asarray(along, dtype=float)
    w = np.isfinite(s) & (t > t_ref + window[0]) & (t < t_ref + window[1])
    tw, sw = t[w] - t_ref, s[w]
    if len(tw) < 12:
        return None
    best = None
    for tc in np.arange(search[0], search[1] + 1e-9, step):
        before, after = np.minimum(tw - tc, 0), np.maximum(tw - tc, 0)
        A = np.stack([np.ones_like(tw), tw - tc, 0.5 * before**2, 0.5 * after**2], axis=1)
        coef = np.linalg.lstsq(A, sw, rcond=None)[0]
        r = float(np.sum((A @ coef - sw) ** 2))
        if best is None or r < best[0]:
            best = (r, tc, coef)
    r, tc, coef = best
    return {"t": float(t_ref + tc), "decelBeforeMs2": float(-coef[2]), "decelAfterMs2": float(-coef[3]),
            "rmsM": float(np.sqrt(r / len(tw))), "points": int(len(tw))}
