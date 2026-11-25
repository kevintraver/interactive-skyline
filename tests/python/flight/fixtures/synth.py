"""Synthetic ADS-B traces in readsb's trace_full layout, for the flight pipeline's tests (plan 03, F0.3).

A flight is first flown as a dense truth (10 Hz) in the app frame: metres east (x) and north (n) of the city
origin and metres above sea level (h) of the wheels. It is then "recorded" the way readsb writes a trace:
thinned to a point every few seconds, altitudes in 25 ft steps, geometric altitude above the ellipsoid
(sea level plus a datum offset), barometric altitude off by a temperature error, ground speed, track and
vertical rate from the truth, "ground" after touchdown, and a source per point.

Nothing here reads the network; the frame is the app's own (scripts/lib/frame.py).
"""
import gzip
import io
import json
import math
import tarfile

import numpy as np

FT = 0.3048
KT = 1852 / 3600
FPM = FT / 60


class Truth(dict):
    """Dense truth arrays: t (s from start), x, n, h (wheels, m above sea level), gs (m/s), trk (deg, grid),
    vs (m/s), ground (bool). Attribute access for convenience."""
    __getattr__ = dict.__getitem__


def fly(x, n, h, hdg, v, legs, dt=0.1):
    """Integrate a simple kinematic flight. Each leg: dict(dur, turn=deg/s, vs=m/s, acc=m/s2, ground=False,
    ramp=s). With `ramp`, the turn rate changes linearly from the previous leg's over that many seconds (an
    airliner rolls into a turn over several seconds; an instant change of turn rate is not flyable)."""
    out = {k: [] for k in ("t", "x", "n", "h", "gs", "trk", "vs", "ground")}
    t = 0.0
    rate = 0.0
    for leg in legs:
        steps = int(round(leg["dur"] / dt))
        start_rate, ramp = rate, leg.get("ramp", 0.0)
        for step in range(steps):
            f = min(1.0, (step * dt) / ramp) if ramp else 1.0
            rate = start_rate + (leg.get("turn", 0.0) - start_rate) * f
            for k, val in zip(out, (t, x, n, h, v, hdg % 360, leg.get("vs", 0.0), leg.get("ground", False))):
                out[k].append(val)
            hdg += rate * dt
            v = max(0.0, v + leg.get("acc", 0.0) * dt)
            r = math.radians(hdg)
            x += v * math.sin(r) * dt
            n += v * math.cos(r) * dt
            h += leg.get("vs", 0.0) * dt
            t += dt
    return Truth({k: np.array(val) for k, val in out.items()})


def approach(end, glide_deg=3.0, tch_m=15.0, final_m=16000.0, v_final=72.0, flare_from_m=8.0, td_sink=0.7,
             rollout_s=70.0, decel=1.8, taxi=10.0, lateral_m=0.0, dt=0.1, lead=None, surface=None):
    """A straight-in final to a runway end and its rollout, as dense truth.

    `end` is a runway end of airport.json (its `threshold` [x, y, elevation] and `gridHeading`, the landing
    direction in the app grid). The glide path passes `tch_m` above the threshold; from `flare_from_m` of wheel
    height the sink rate decays exponentially and reaches `td_sink` as the wheels touch (the touchdown point
    follows from that: about 450 m past the threshold with the defaults). `lateral_m` offsets the final to the
    right. `lead` optionally prepends legs flown before the final (see `fly`), ending where the final starts.
    The runway is level at the threshold's elevation unless `surface(x, n)` gives its elevation; then the flare
    and the rollout follow it."""
    thr = np.array(end["threshold"][:2], dtype=float)
    z_thr = float(end["threshold"][2])
    hdg = float(end["gridHeading"])
    u = np.array([math.sin(math.radians(hdg)), math.cos(math.radians(hdg))])
    right = np.array([u[1], -u[0]])
    g = math.tan(math.radians(glide_deg))
    sink0 = v_final * g
    k = (sink0 - td_sink) / flare_from_m
    y_inf = -td_sink / k
    t_flare = math.log((flare_from_m - y_inf) / (0 - y_inf)) / k
    s_fs = (tch_m - flare_from_m) / g
    rows, s, t = [], -final_m, 0.0
    while s < s_fs:
        rows.append((t, s, z_thr + tch_m - s * g, v_final, -sink0, False))
        s += v_final * dt
        t += dt
    t0 = t
    while t - t0 < t_flare:
        y = y_inf + (flare_from_m - y_inf) * math.exp(-k * (t - t0))
        rows.append((t, s, z_thr + max(y, 0.0), v_final, -k * (y - y_inf), False))
        s += v_final * dt
        t += dt
    td_t, td_s = t, s
    v, tg = v_final, 0.0
    while tg < rollout_s:
        rows.append((t, s, z_thr, v, 0.0, True))
        v = max(taxi, v - decel * dt)
        s += v * dt
        t += dt
        tg += dt
    a = np.array(rows)
    pos = thr[None, :] + a[:, 1:2] * u[None, :] + lateral_m * right[None, :]
    if surface is not None:
        past = a[:, 1] >= s_fs - 1e-6
        z = np.asarray(surface(pos[:, 0], pos[:, 1]), dtype=float)
        a[past, 2] = a[past, 2] - z_thr + z[past]
    tr = Truth(t=a[:, 0], x=pos[:, 0], n=pos[:, 1], h=a[:, 2], gs=a[:, 3], trk=np.full(len(a), hdg % 360),
               vs=a[:, 4], ground=a[:, 5].astype(bool))
    tr["touchdown_t"], tr["touchdown_s"], tr["tch"] = float(td_t), float(td_s), tch_m
    if lead:
        turned = sum(leg.get("turn", 0.0) * leg["dur"] for leg in lead)
        probe = fly(0.0, 0.0, 0.0, hdg - turned, v_final, lead, dt)
        r = math.radians(hdg)
        # the last step of the probe ends one dt short of the join; extend it by that step
        ex = probe.x[-1] + v_final * math.sin(r) * dt
        en = probe.n[-1] + v_final * math.cos(r) * dt
        dh = sum(leg.get("vs", 0.0) * leg["dur"] for leg in lead)
        pre = fly(tr.x[0] - ex, tr.n[0] - en, tr.h[0] - dh, hdg - turned, v_final, lead, dt)
        tr = concat(pre, tr)
    return tr


def concat(a, b):
    """Join two truths, the second's time following the first's."""
    shift = a.t[-1] + (a.t[1] - a.t[0]) if len(a.t) > 1 else 0.0
    out = Truth({k: np.concatenate([a[k], b[k] + (shift if k == "t" else 0)]) for k in
                 ("t", "x", "n", "h", "gs", "trk", "vs", "ground")})
    for k in ("touchdown_t",):
        if k in b:
            out[k] = b[k] + shift
        elif k in a:
            out[k] = a[k]
    for k in ("touchdown_s", "tch"):
        if k in b:
            out[k] = b[k]
    return out


def record(truth, frame, *, start_epoch=1760450400.0, every=7.0, ground_every=4.0, datum_m=28.0,
           baro_error_m=0.0, quant_ft=25.0, pos_noise_m=0.0, seed=1, icao="a1b2c3", type_code="B738",
           state_every=4, mlat_idx=(), spikes=(), source="adsb_icao", include_state=True, ground_geom=False,
           surface_below_kt=None,
           antenna_m=0.0):
    """Thin a truth into a readsb trace_full dict.

    datum_m: geometric altitude is h + antenna_m + datum_m (h is the wheels; at Las Vegas the ellipsoid is 28 m
    above the geoid, so an aircraft reporting height above the ellipsoid has datum_m = -28).
    baro_error_m: barometric altitude is h + antenna_m + baro_error_m, in standard pressure altitude.
    ground_geom: keep reporting geometric altitude on the ground (most aircraft stop: surface positions carry none).
    surface_below_kt: a transponder that reports the surface format only below this ground speed: on the runway
    above it, it keeps sending airborne positions (with fresh altitudes and a level vertical rate).
    mlat_idx: indices (in the thinned list) whose source is "mlat". spikes: {index: (dx, dn)} position errors."""
    rng = np.random.default_rng(seed)
    idx, last, was_ground = [], -1e9, None
    def reported_ground(i):
        g = bool(truth.ground[i])
        return g and (surface_below_kt is None or truth.gs[i] / KT < surface_below_kt)

    for i, t in enumerate(truth.t):
        gnd = reported_ground(i)
        step = ground_every if gnd else every
        if t - last >= step - 1e-9 or gnd != was_ground:
            idx.append(i)
            last = t
            was_ground = gnd
    lat, lon = frame.to_geodetic(truth.x[idx], truth.n[idx])
    # readsb reports true track; the truth is flown in the app grid. True north's bearing in the grid:
    xa, na = frame.to_local(lat + 1e-4, lon)
    north = np.degrees(np.arctan2(xa - truth.x[idx], na - truth.n[idx]))
    spikes = dict(spikes)
    pts = []
    for j, i in enumerate(idx):
        la, lo = float(lat[j]), float(lon[j])
        if pos_noise_m or j in spikes:
            dx, dn = spikes.get(j, (0.0, 0.0))
            dx += rng.normal(0, pos_noise_m) if pos_noise_m else 0
            dn += rng.normal(0, pos_noise_m) if pos_noise_m else 0
            la2, lo2 = frame.to_geodetic(truth.x[i] + dx, truth.n[i] + dn)
            la, lo = float(la2), float(lo2)
        gnd = reported_ground(i)
        q = lambda m: round(m / FT / quant_ft) * quant_ft  # noqa: E731
        alt = "ground" if gnd else q(truth.h[i] + antenna_m + baro_error_m)
        geom = None if gnd and not ground_geom else q(truth.h[i] + antenna_m + datum_m)
        state = None
        if include_state and state_every and j % state_every == 0:
            state = {"type": source, "flight": "TEST123 ", "alt_geom": geom, "gs": round(truth.gs[i] / KT, 1)}
        src = "mlat" if j in mlat_idx else source
        pts.append([round(float(truth.t[i]), 2), round(la, 6), round(lo, 6), alt, round(float(truth.gs[i]) / KT, 1),
                    round(float((truth.trk[i] - north[j]) % 360), 2), 0 if j else 2, None if gnd else int(round(truth.vs[i] / FPM / 64) * 64),
                    state, src, geom, None, None, None])
    return {"icao": icao, "r": "N000TS", "t": type_code, "dbFlags": 0, "desc": "BOEING 737-800",
            "timestamp": start_epoch, "trace": pts}


def gz(trace):
    """The bytes of an archive member: gzip-compressed JSON (no .gz suffix in the archive)."""
    return gzip.compress(json.dumps(trace, separators=(",", ":")).encode(), mtime=0)


def tar_bytes(members):
    """An uncompressed tar holding {name: bytes}, as the archive's day is (before it is split in parts)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()
