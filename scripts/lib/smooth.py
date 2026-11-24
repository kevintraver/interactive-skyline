"""From thinned ADS-B points to a smooth 1 Hz track (plan 03, section 7.2, steps 3, 5 and 6).

- `observations`: the points in the app frame: position (x east, n north), raw geometric and barometric heights,
  and the aircraft's own velocity (ground speed and true track turned into the app grid; vertical rate).
- `gate` (step 3): drop points whose jump from their neighbours disagrees with the reported ground speed by more
  than 25% + 20 m/s, or implies more than 8,000 ft/min; repeat until stable.
- `smooth_track` (step 5): a fixed-interval Kalman smoother (Rauch-Tung-Striebel) per axis with a
  constant-acceleration model, fusing positions with the recorded velocity. Using the aircraft's own velocity is
  what makes sparse sampling enough.
- `flare` (step 6): the last seconds before the recorded air-to-ground transition, which the archive does not
  record: an exponential decay of the sink rate from 6 to 9 m of wheel height to 0.5 to 1 m/s at the transition.

Phase 2 (F2.3) grows this module: noise per source, the barometric cross-check, rollout reconstruction.
"""
from dataclasses import dataclass

import numpy as np

FT = 0.3048
KT = 1852 / 3600
FPM = FT / 60

SIGMA_POS_AIR = 8.0      # m
SIGMA_POS_GROUND = 3.0   # m
SIGMA_H = 6.0            # m
SIGMA_V = 1.0            # m/s, ground velocity
SIGMA_VZ = 0.5           # m/s
Q_HORIZONTAL = 1.0       # m^2/s^5, white-jerk spectral density
Q_VERTICAL = 0.05


@dataclass
class Obs:
    t: np.ndarray
    x: np.ndarray
    n: np.ndarray
    h: np.ndarray        # geometric altitude in metres as reported (ellipsoid or whatever the avionics use)
    hb: np.ndarray       # barometric (pressure) altitude in metres
    vx: np.ndarray
    vn: np.ndarray
    vz: np.ndarray
    ground: np.ndarray
    src: np.ndarray
    reported_ground: np.ndarray   # the surface flag as reported (ground may be widened to a refined touchdown)

    def take(self, mask):
        return Obs(**{k: getattr(self, k)[mask] for k in self.__dataclass_fields__})


def true_north_bearing(frame, lat, lon):
    """The bearing of true north in the app grid (degrees), at each point."""
    x0, n0 = frame.to_local(lat, lon)
    x1, n1 = frame.to_local(np.asarray(lat) + 1e-4, lon)
    return np.degrees(np.arctan2(x1 - x0, n1 - n0))


def observations(p, frame):
    x, n = frame.to_local(p.lat, p.lon)
    grid_trk = np.radians(p.track + true_north_bearing(frame, p.lat, p.lon))
    gs = p.gs_kt * KT
    return Obs(t=p.t.copy(), x=np.asarray(x), n=np.asarray(n), h=p.alt_geom_ft * FT, hb=p.alt_baro_ft * FT,
               vx=gs * np.sin(grid_trk), vn=gs * np.cos(grid_trk),
               vz=np.where(p.ground, 0.0, p.vrate_fpm * FPM), ground=p.ground.copy(), src=p.src.copy(),
               reported_ground=p.ground.copy())


def gate(ob, rel=0.25, abs_ms=20.0, max_fpm=8000.0, min_dt=0.5):
    """Boolean mask of the points to keep."""
    keep = np.ones(len(ob.t), dtype=bool)
    vmax = max_fpm * FPM
    gs = np.hypot(ob.vx, ob.vn)
    while True:
        idx = np.flatnonzero(keep)
        if len(idx) < 3:
            return keep
        t, x, n, h = ob.t[idx], ob.x[idx], ob.n[idx], ob.h[idx]
        dt = np.diff(t)
        d = np.hypot(np.diff(x), np.diff(n))
        ref = 0.5 * (gs[idx][1:] + gs[idx][:-1])
        ref = np.where(np.isfinite(ref), ref, d / np.maximum(dt, min_dt))
        slack = rel * ref + abs_ms + 15.0 / np.maximum(dt, min_dt)   # 15 m of position noise on short links
        bad_h_link = np.abs(np.diff(h)) / np.maximum(dt, min_dt) > vmax + 8.0 / np.maximum(dt, min_dt)
        bad_link = (np.abs(d / np.maximum(dt, min_dt) - ref) > slack) & (dt >= min_dt)
        bad_link |= bad_h_link & np.isfinite(np.diff(h))
        # a point is bad when both of its links are bad (the ends: their one link, if the neighbour is good)
        bad = np.zeros(len(idx), dtype=bool)
        bad[1:-1] = bad_link[:-1] & bad_link[1:]
        if bad_link[0] and not bad_link[1]:
            bad[0] = True
        if bad_link[-1] and not bad_link[-2]:
            bad[-1] = True
        if not bad.any():
            return keep
        # drop the worst offender first, then look again
        score = np.zeros(len(idx))
        dev = np.abs(d / np.maximum(dt, min_dt) - ref) / slack
        score[1:-1] = np.minimum(dev[:-1], dev[1:])
        score[0], score[-1] = dev[0], dev[-1]
        hd = np.abs(np.diff(h)) / np.maximum(dt, min_dt) / vmax
        hd = np.nan_to_num(hd)
        hs = np.zeros(len(idx))
        hs[1:-1] = np.minimum(hd[:-1], hd[1:])
        hs[0], hs[-1] = hd[0], hd[-1]
        score = np.where(bad, np.maximum(score, hs), -1)
        keep[idx[np.argmax(score)]] = False


def _transition(dt, q):
    F = np.array([[1.0, dt, 0.5 * dt * dt], [0.0, 1.0, dt], [0.0, 0.0, 1.0]])
    Q = q * np.array([[dt**5 / 20, dt**4 / 8, dt**3 / 6],
                      [dt**4 / 8, dt**3 / 3, dt**2 / 2],
                      [dt**3 / 6, dt**2 / 2, dt]])
    return F, Q


def rts(t_obs, pos, sp, vel, sv, t_out, q):
    """Smooth one axis. pos/vel may hold NaN (no observation). Returns (p, v, a) at t_out."""
    t_all = np.concatenate([t_obs, t_out])
    kind = np.concatenate([np.arange(len(t_obs)), -1 - np.arange(len(t_out))])
    order = np.lexsort((kind < 0, t_all))
    t_all, kind = t_all[order], kind[order]
    m = len(t_all)
    xs_p = np.zeros((m, 3))
    Ps_p = np.zeros((m, 3, 3))
    xs_f = np.zeros((m, 3))
    Ps_f = np.zeros((m, 3, 3))
    Fs = np.zeros((m, 3, 3))
    first = np.flatnonzero(np.isfinite(pos))
    p0 = pos[first[0]] if len(first) else 0.0
    v0 = vel[np.flatnonzero(np.isfinite(vel))[0]] if np.isfinite(vel).any() else 0.0
    x = np.array([p0, v0, 0.0])
    P = np.diag([1e4, 1e2, 10.0])
    t_prev = t_all[0]
    for k in range(m):
        F, Q = _transition(t_all[k] - t_prev, q)
        x = F @ x
        P = F @ P @ F.T + Q
        Fs[k] = F
        xs_p[k], Ps_p[k] = x, P
        j = kind[k]
        if j >= 0:
            rows, vals, var = [], [], []
            if np.isfinite(pos[j]):
                rows.append([1.0, 0.0, 0.0]); vals.append(pos[j]); var.append(sp[j] ** 2)
            if np.isfinite(vel[j]):
                rows.append([0.0, 1.0, 0.0]); vals.append(vel[j]); var.append(sv[j] ** 2)
            if rows:
                H = np.array(rows)
                S = H @ P @ H.T + np.diag(var)
                K = P @ H.T @ np.linalg.inv(S)
                x = x + K @ (np.array(vals) - H @ x)
                P = (np.eye(3) - K @ H) @ P
        xs_f[k], Ps_f[k] = x, P
        t_prev = t_all[k]
    xs = xs_f.copy()
    for k in range(m - 2, -1, -1):
        C = Ps_f[k] @ Fs[k + 1].T @ np.linalg.inv(Ps_p[k + 1])
        xs[k] = xs_f[k] + C @ (xs[k + 1] - xs_p[k + 1])
    out = np.empty((len(t_out), 3))
    sel = kind < 0
    out[-1 - kind[sel]] = xs[sel]
    return out[:, 0], out[:, 1], out[:, 2]


@dataclass
class Track:
    t: np.ndarray
    x: np.ndarray
    n: np.ndarray
    h: np.ndarray
    vx: np.ndarray
    vn: np.ndarray
    vz: np.ndarray
    ax: np.ndarray
    an: np.ndarray


def smooth_track(ob, t_out, h_obs=None, sigma_h=None, sigma_pos=None, q_h=Q_HORIZONTAL, q_v=Q_VERTICAL):
    """Smoothed position and velocity at `t_out` (epoch seconds). Heights from `h_obs` (default: ob.h)."""
    h_obs = ob.h if h_obs is None else h_obs
    sp = np.where(ob.ground, SIGMA_POS_GROUND, SIGMA_POS_AIR) if sigma_pos is None else sigma_pos
    sh = np.full(len(ob.t), SIGMA_H) if sigma_h is None else sigma_h
    sv = np.full(len(ob.t), SIGMA_V)
    svz = np.full(len(ob.t), SIGMA_VZ)
    x, vx, ax = rts(ob.t, ob.x, sp, ob.vx, sv, t_out, q_h)
    n, vn, an = rts(ob.t, ob.n, sp, ob.vn, sv, t_out, q_h)
    h, vz, _ = rts(ob.t, h_obs, sh, ob.vz, svz, t_out, q_v)
    return Track(t=np.asarray(t_out, dtype=float), x=x, n=n, h=h, vx=vx, vn=vn, vz=vz, ax=ax, an=an)


def flare_profile(y0, sink0, td_sink):
    """The exponential flare from wheel height y0 (m) and sink rate sink0 (m/s, positive down) to touchdown at
    sink rate td_sink: y(tau) = y_inf + (y0 - y_inf) exp(-k tau). Returns (k, y_inf, duration)."""
    k = (sink0 - td_sink) / y0
    y_inf = -td_sink / k
    return k, y_inf, float(np.log((y0 - y_inf) / (-y_inf)) / k)


def flare(t, y, t_td, heights=np.arange(6.0, 9.01, 0.5), sinks=np.arange(0.5, 1.001, 0.1), max_shift=15.0):
    """Replace the last seconds of a wheel-height series y(t) (m above the runway, 1 Hz or finer) by a flare that
    ends exactly at `t_td` with the wheels on the runway.

    The flare starts where the series crosses a height in `heights` and decays its sink rate to one of `sinks`;
    the pair whose flare ends closest to t_td is used. If none ends within 0.25 s, the series is shifted
    vertically (ramped in over the 90 s before the flare) until one does. Returns (y_new, info)."""
    y = np.asarray(y, dtype=float)
    t = np.asarray(t, dtype=float)
    vz = np.gradient(y, t)

    def best(yy):
        out = None
        for y0 in heights:
            above = np.flatnonzero((yy[:-1] >= y0) & (yy[1:] < y0) & (t[1:] <= t_td + 5))
            if not len(above):
                continue
            i = above[-1]
            f = (yy[i] - y0) / (yy[i] - yy[i + 1])
            tf = t[i] + f * (t[i + 1] - t[i])
            s0 = -(vz[i] + f * (vz[i + 1] - vz[i]))
            for ts in sinks:
                if s0 <= ts + 0.2:
                    continue
                k, yi, dur = flare_profile(y0, s0, ts)
                err = tf + dur - t_td
                if out is None or abs(err) < abs(out["err"]):
                    out = {"err": err, "y0": float(y0), "tdSink": float(ts), "tf": float(tf), "sink0": float(s0),
                           "k": k, "yInf": yi, "duration": dur}
        return out

    def shifted(dz, tf_guess):
        ramp = np.clip((t - (tf_guess - 90.0)) / 90.0, 0.0, 1.0)
        return y + dz * ramp

    b = best(y)
    shift = 0.0
    if b is None or abs(b["err"]) > 0.25:
        # the vertical shift that brings the flare's end onto t_td: scan, then bisect the first change of sign
        tf_guess = t_td - 6.0
        grid = np.arange(-max_shift, max_shift + 1e-9, 0.5)
        errs = []
        for dz in grid:
            bb = best(shifted(dz, tf_guess))
            errs.append(np.nan if bb is None else bb["err"])
        errs = np.array(errs)
        ok = np.isfinite(errs)
        if not ok.any():
            raise ValueError("no flare fits the recorded touchdown")
        cross = np.flatnonzero(ok[:-1] & ok[1:] & (np.sign(errs[:-1]) != np.sign(errs[1:])))
        if len(cross):
            lo, hi = grid[cross[0]], grid[cross[0] + 1]
            elo = errs[cross[0]]
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                bm = best(shifted(mid, tf_guess))
                if bm is None:
                    break
                if abs(bm["err"]) <= 0.05:
                    break
                if np.sign(bm["err"]) == np.sign(elo):
                    lo, elo = mid, bm["err"]
                else:
                    hi = mid
            shift = mid
        else:
            shift = float(grid[np.nanargmin(np.abs(errs))])
        y = shifted(shift, tf_guess)
        b = best(y)
    out = y.copy()
    tau = t - b["tf"]
    in_flare = (tau >= 0) & (t <= t_td)
    out[in_flare] = b["yInf"] + (b["y0"] - b["yInf"]) * np.exp(-b["k"] * tau[in_flare])
    out[t > t_td] = 0.0
    out = np.maximum(out, 0.0)
    b["shift"] = float(shift)
    return out, b


def flare_end(t, y, t_first, y0=7.5, td_sink=0.7, after=None):
    """When no air-to-ground transition was recorded: the time at which a flare from wheel height `y0`, begun where
    the series y(t) last crosses it (after `after`), reaches the runway at `td_sink`."""
    t = np.asarray(t, dtype=float)
    y = np.asarray(y, dtype=float)
    vz = np.gradient(y, t)
    ok = (y[:-1] >= y0) & (y[1:] < y0)
    if after is not None:
        ok &= t[1:] > after
    idx = np.flatnonzero(ok)
    if not len(idx):
        raise ValueError("the extrapolated final never comes down to the flare height")
    i = idx[0]
    f = (y[i] - y0) / (y[i] - y[i + 1])
    tf = t[i] + f * (t[i + 1] - t[i])
    s0 = -(vz[i] + f * (vz[i + 1] - vz[i]))
    _, _, dur = flare_profile(y0, max(s0, td_sink + 0.5), td_sink)
    return float(tf + dur)
