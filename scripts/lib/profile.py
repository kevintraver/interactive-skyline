"""The height profile of a road that rides on top of the coarse terrain.

The terrain is not modified, so the pavement must be above it everywhere under its width. At
each station the envelope is the highest ground under the pavement and a margin either side,
corrected for crossfall and lifted by a clearance; the profile is then the lowest one that
stays on or above that envelope while keeping to a grade limit and a vertical-curve limit
(smoothing "from above"). It is solved as a linear programme: minimise the total lift subject
to z >= envelope, |dz/ds| <= grade and |d2z/ds2| <= 1/R, so it is never below the envelope at
any station by construction.
"""
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import diags, vstack


def envelope(st, left, right, ground, clearance=0.3, margin=2.0, across=1.0, along=(-2.0, 0.0, 2.0)):
    """Highest required reference-line height at each station.

    st: dict of station arrays x, y, heading, crossfall (rise per metre to the left).
    left, right: arrays of the pavement's outer edges at each station, metres from the
        reference line, positive to the left (left > 0 > right usually).
    ground: function (x, y) -> metres above sea level (vectorised).
    Samples every `across` metres from left + margin to right - margin (edges included), at
    each offset in `along` metres along the tangent, and asks that the pavement plane through
    the reference line with the station's crossfall clears every sample by `clearance`.
    """
    x, y, hd, cf = st["x"], st["y"], st["heading"], st["crossfall"]
    tx, ty = np.cos(hd), np.sin(hd)
    nx, ny = -ty, tx  # left normal
    lo, hi = right - margin, left + margin
    width = hi - lo
    k = int(np.ceil(width.max() / across)) + 1
    frac = np.linspace(0, 1, k)
    d = lo[:, None] + width[:, None] * frac[None, :]  # (n, k), offsets left-positive
    need = np.full(len(x), -np.inf)
    for a in along:
        px = x[:, None] + a * tx[:, None] + d * nx[:, None]
        py = y[:, None] + a * ty[:, None] + d * ny[:, None]
        g = ground(px, py)
        need = np.maximum(need, (g - cf[:, None] * d).max(axis=1))
    return need + clearance


def smooth_from_above(env, spacing, grade=0.06, radius=3000.0):
    """The lowest profile z >= env with |grade| <= `grade` and vertical curves no tighter than
    `radius` metres (a scalar or one value per station). Returns z (same length as env)."""
    env = np.asarray(env, dtype=np.float64)
    n = len(env)
    radius = np.broadcast_to(np.asarray(radius, dtype=np.float64), (n,))
    # one difference row per station pair, one second difference per interior station
    d1 = diags([-np.ones(n - 1), np.ones(n - 1)], [0, 1], shape=(n - 1, n))
    d2 = diags([np.ones(n - 2), -2 * np.ones(n - 2), np.ones(n - 2)], [0, 1, 2], shape=(n - 2, n))
    g = grade * spacing
    c = spacing**2 / radius[1:-1]
    a_ub = vstack([d1, -d1, d2, -d2]).tocsr()
    b_ub = np.concatenate([np.full(n - 1, g), np.full(n - 1, g), c, c])
    base = env.min()
    res = linprog(np.ones(n), A_ub=a_ub, b_ub=b_ub, bounds=list(zip(env - base, [None] * n)), method="highs")
    if res.status != 0:
        raise RuntimeError(f"profile LP failed: {res.message}")
    z = res.x + base
    # the solver works to a tolerance; never hand back a station below its envelope
    return np.maximum(z, env)


def smooth_between(lower, upper, spacing, grade=0.06, radius=3000.0):
    """As smooth_from_above, with an upper bound too: the lowest profile with lower <= z <= upper
    (upper may be +inf; equal bounds pin a station), |grade| <= `grade` and vertical curves no
    tighter than `radius`. Returns z, or None when no profile meets every bound."""
    lower = np.asarray(lower, dtype=np.float64)
    upper = np.asarray(upper, dtype=np.float64)
    n = len(lower)
    radius = np.broadcast_to(np.asarray(radius, dtype=np.float64), (n,))
    d1 = diags([-np.ones(n - 1), np.ones(n - 1)], [0, 1], shape=(n - 1, n))
    d2 = diags([np.ones(n - 2), -2 * np.ones(n - 2), np.ones(n - 2)], [0, 1, 2], shape=(n - 2, n))
    g = grade * spacing
    c = spacing**2 / radius[1:-1]
    a_ub = vstack([d1, -d1, d2, -d2]).tocsr()
    b_ub = np.concatenate([np.full(n - 1, g), np.full(n - 1, g), c, c])
    base = lower.min()
    hi = [None if not np.isfinite(u) else u - base for u in upper]
    res = linprog(np.ones(n), A_ub=a_ub, b_ub=b_ub, bounds=list(zip(lower - base, hi)), method="highs")
    if res.status != 0:
        return None
    return np.clip(res.x + base, lower, upper)
