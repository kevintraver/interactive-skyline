"""Configuration, lights and chapters for a baked flight (plan 03, F2.5: section 7.2 steps 10 and 11, section 7.3).

ADS-B carries none of these, so every channel here is inferred, deterministically and conservatively: it dresses the
recorded motion and never invents a manoeuvre.

Flaps. The sequence is 1, 5, 15, then the landing flap (30 unless told otherwise). Each setting is selected when the
indicated airspeed has decayed to within 10 kt of the manoeuvring speed of the current one, or at its gate if that
comes first (flaps 1 by 22 km from the threshold, flaps 5 before joining final, flaps 15 with the gear, the landing
flap by 300 m above the runway); and never while the speed, then or at any later moment of the approach, is above the
new setting's placard. So the flaps only go out on the approach and never stand above a placard. The surfaces travel
at a fixed rate (40 s from up to 40, an estimate). Slats: extend with flaps 1 to 5, full extend beyond 5.

Gear: down with flaps 15 (when established on final below 760 m above the runway, and in any case by 9 km), never
above its 270 kt limit, and always before the landing flap.

Speed brake in the descent: only where the descent is steeper than idle thrust explains, by more than 25 per cent of
the clean idle rate in energy terms (descent plus deceleration), clean and above 600 m; low confidence.

On the ground: ground spoilers 0.5 s after touchdown, reverser sleeves from 2 s after, idle as the ground speed passes
60 kt and stowed at taxi speed; the flaps come up after vacating.

Lights (section 7.8), as a bit field: position lights and beacon throughout, strobes until the runway is vacated,
landing lights below 10,000 ft until vacating, turn-off lights from gear down, the taxi light after vacating, wing and
logo lights at night below 10,000 ft. Cabin light dimmed from 10,000 ft when the sun is more than 6 degrees down.
"""
import numpy as np

KT = 1852 / 3600
FT = 0.3048

LIGHT = {"nav": 1, "beacon": 2, "strobe": 4, "landing": 8, "taxi": 16, "turnoff": 32, "logo": 64, "wing": 128}
# Placard speeds (kt) by lever position, spec.py FLAPS["limit_speed_kt"] [B3] and section 7.3
FLAP_LIMIT_KT = {0: 999, 1: 250, 2: 250, 5: 250, 10: 210, 15: 200, 25: 190, 30: 175, 40: 162}
FLAP_MAX_ALT_M = 20000 * FT
GEAR_LIMIT_KT = 270.0
# Manoeuvring speed: the flaps-40 reference speed plus this (kt), section 7.3 (spec.py PERFORMANCE)
MANOEUVRE_ADD_KT = {0: 70, 1: 50, 2: 40, 5: 30, 10: 30, 15: 20, 25: 10}
SEQUENCE = (1, 5, 15)
FLAP_RATE = 1.0               # lever units per second: 40 s from up to 40 (estimate)
GEAR_RATE = 0.1               # 10 s to extend (estimate)
TAXI_MS = 15.0                # about 30 kt
PLACARD_MARGIN_KT = 1.0
MIN_GAP_S = 8.0               # between two selections (the lever is moved one detent at a time)
SPOILER_DELAY_S = 0.5
REVERSER_DELAY_S = 2.0
REVERSE_IDLE_KT = 60.0
GATE = {"flap1_to_go": 22000.0, "flap5_before_final_s": 30.0, "flap5_to_go": 16000.0, "gear_above_m": 760.0,
        "gear_to_go": 9000.0, "landing_above_m": 300.0}
IDLE_FPM = ((250.0, 1700.0), (280.0, 2200.0))     # clean idle descent rates, section 7.3 (spec.py PERFORMANCE)
SPEEDBRAKE_FPM = ((250.0, 2300.0), (280.0, 3100.0))
SPEEDBRAKE_OVER = 1.25
SPEEDBRAKE_MIN_S = 20


def _vref(weight, flap):
    from lib.attitude import vref_kt
    return vref_kt(weight, flap)


def manoeuvre_kt(setting, weight, landing_flap):
    if setting >= 30:
        return _vref(weight, setting) + 5.0
    return _vref(weight, 40) + MANOEUVRE_ADD_KT[setting]


def _detent(f):
    return max(k for k in FLAP_LIMIT_KT if k <= f + 0.01)


def placard_exceedances(flap, ias_kt, air):
    """Sample indices where a surface stands beyond a detent whose placard the indicated airspeed exceeds."""
    return [i for i in range(len(flap)) if air[i] and flap[i] > 0.5
            and ias_kt[i] > FLAP_LIMIT_KT[_detent(flap[i])] + PLACARD_MARGIN_KT]


def _travel(cmd, rate, dt=1.0):
    out = np.array(cmd, dtype=float)
    for i in range(1, len(out)):
        out[i] = out[i - 1] + np.clip(out[i] - out[i - 1], -rate * dt, rate * dt)
    return out


def _first(mask, start=0):
    idx = np.flatnonzero(mask[start:])
    return int(idx[0] + start) if len(idx) else None


def _moving_average(y, n):
    k = np.ones(n) / n
    pad = n // 2
    return np.convolve(np.pad(y, (pad, n - 1 - pad), mode="edge"), k, mode="valid")


def speed_brake(t, *, ias_kt, tas, vs, above_field, flap, gear, air):
    """The speed brake's position (0..1 of the flight detent) where the descent, in energy terms, is steeper than
    idle explains by more than SPEEDBRAKE_OVER, clean, above 600 m, for at least SPEEDBRAKE_MIN_S."""
    n = len(t)
    if n < 3:
        return np.zeros(n)
    dv = np.gradient(np.asarray(tas, dtype=float), t)
    energy_rate = np.asarray(vs, dtype=float) + np.asarray(tas, dtype=float) * dv / 9.80665   # m/s, up positive
    energy_rate = _moving_average(energy_rate, 31)
    ias_c = np.clip(ias_kt, IDLE_FPM[0][0], IDLE_FPM[1][0])
    idle = np.interp(ias_c, [r[0] for r in IDLE_FPM], [r[1] for r in IDLE_FPM]) * FT / 60
    sb = np.interp(ias_c, [r[0] for r in SPEEDBRAKE_FPM], [r[1] for r in SPEEDBRAKE_FPM]) * FT / 60
    ratio = -energy_rate / idle
    eligible = air & (np.asarray(flap) < 0.5) & (np.asarray(gear) < 0.5) & (np.asarray(above_field) > 600)
    on = eligible & (ratio > SPEEDBRAKE_OVER)
    # runs shorter than the minimum are dropped
    out_on = np.zeros(n, bool)
    i = 0
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            if j - i >= SPEEDBRAKE_MIN_S:
                out_on[i:j] = True
            i = j
        else:
            i += 1
    cmd = np.where(out_on, np.clip((ratio - 1.0) / np.maximum(sb / idle - 1.0, 0.1), 0, 1), 0.0)
    return _travel(cmd, 0.5)


def schedule(*, t, air, td, ias_kt, h, above_field, to_go, on_final, gs, tas, vs, sun, weight, landing_flap=30,
             vacate_gs=TAXI_MS):
    """Every configuration channel on the samples `t` (1 Hz), with the selections made, gear and vacate times,
    provenance and notes. `to_go` is metres along the path to the landing threshold, `on_final` a bool per sample
    (established on the final approach course), `above_field` metres of wheel height above the landing threshold."""
    t = np.asarray(t, dtype=float)
    n = len(t)
    air = np.asarray(air, bool)
    ias_kt = np.asarray(ias_kt, dtype=float)
    k_td = int(np.searchsorted(t, td))
    k_td = min(k_td, n)
    # the highest speed from each moment to touchdown: a setting is allowed only once the rest of the approach
    # stays under its placard
    ias_air = np.where(air, ias_kt, -np.inf)
    suffix = np.maximum.accumulate(ias_air[:k_td][::-1])[::-1] if k_td else np.array([])
    suffix = np.concatenate([suffix, np.full(n - k_td, -np.inf)])
    # and only once the aircraft is below 20,000 ft for good
    below_alt = np.maximum.accumulate(np.where(air, h, -np.inf)[::-1])[::-1] <= FLAP_MAX_ALT_M

    on_final = np.asarray(on_final, bool) & air
    # joining final: the start of the last unbroken run of on_final before touchdown
    j_final = None
    if on_final[:k_td].any():
        j = int(np.flatnonzero(on_final[:k_td])[-1])
        while j > 0 and on_final[j - 1]:
            j -= 1
        j_final = j

    selections = []
    current, t_prev = 0, -np.inf
    i_gear = None
    for setting in SEQUENCE + (landing_flap,):
        start = _first(t >= t_prev + MIN_GAP_S) or 0
        speed_i = _first(air & (ias_kt <= manoeuvre_kt(current, weight, landing_flap) + 10.0), start)
        if setting == 1:
            gate_i, why = _first(air & (to_go <= GATE["flap1_to_go"]), start), "22 km gate"
        elif setting == 5:
            gate_i = (max(_first(t >= t[j_final] - GATE["flap5_before_final_s"]) or 0, start) if j_final is not None
                      else _first(air & (to_go <= GATE["flap5_to_go"]), start))
            why = "before joining final"
        elif setting == 15:
            gate_i = _first(air & ((on_final & (above_field < GATE["gear_above_m"])) | (to_go <= GATE["gear_to_go"])),
                            start)
            why = "with the gear"
        else:
            gate_i = _first(air & (above_field <= GATE["landing_above_m"]), start)
            why = "300 m gate"
            if i_gear is not None:
                start = max(start, (_first(t >= t[i_gear] + MIN_GAP_S) or start))
        cands = [(i, r) for i, r in ((speed_i, "speed"), (gate_i, why)) if i is not None]
        if not cands:
            continue
        i_sel, reason = min(cands)
        i_sel = max(i_sel, start)
        allowed = _first(air & (suffix <= FLAP_LIMIT_KT[setting] - PLACARD_MARGIN_KT) & below_alt)
        if setting == 15:
            g_ok = _first(air & (suffix <= GEAR_LIMIT_KT - PLACARD_MARGIN_KT))
            allowed = None if allowed is None or g_ok is None else max(allowed, g_ok)
        if allowed is None:
            continue
        if allowed > i_sel:
            i_sel, reason = allowed, "placard"
        if i_sel >= k_td:
            continue
        selections.append({"flap": setting, "t": float(t[i_sel]), "why": reason})
        if setting == 15:
            i_gear = i_sel
        current, t_prev = setting, float(t[i_sel])

    flap_cmd = np.zeros(n)
    for sel in selections:
        flap_cmd = np.where(t >= sel["t"], sel["flap"], flap_cmd)
    landing = selections[-1]["flap"] if selections else 0
    after = t >= td
    slow = after & (np.asarray(gs) < vacate_gs)
    i_vac = _first(slow)
    t_vac = float(t[i_vac]) if i_vac is not None else float(t[-1]) + 1.0
    flap_cmd = np.where(after, landing, flap_cmd)
    flap_cmd = np.where(t >= t_vac + 20, 0.0, flap_cmd)
    flap = _travel(flap_cmd, FLAP_RATE)
    slat = np.clip(flap / 1.0, 0, 1) + np.clip((flap - 5) / 5.0, 0, 1)

    if i_gear is None:
        # no flaps 15 selected (a fast approach that never slowed): the gear at its own gate
        i_gear = _first(air & ((on_final & (above_field < GATE["gear_above_m"])) | (to_go <= GATE["gear_to_go"])))
        i_gear = k_td - 1 if i_gear is None else i_gear
    t_gear = float(t[i_gear])
    gear_cmd = (t >= t_gear).astype(float)
    gear = _travel(gear_cmd, GEAR_RATE)

    gsp_cmd = (t >= td + SPOILER_DELAY_S) & (t < t_vac)
    ground_spoiler = _travel(gsp_cmd.astype(float), 1.0)
    rev_cmd = (t >= td + REVERSER_DELAY_S) & (t < t_vac)
    reverser = _travel(rev_cmd.astype(float), 0.5)
    sbrake = speed_brake(t, ias_kt=ias_kt, tas=tas, vs=vs, above_field=above_field, flap=flap, gear=gear, air=air)

    below10k = np.maximum.accumulate((np.asarray(h) < 10000 * FT) & air) > 0
    sun = np.asarray(sun, dtype=float)
    lights = np.full(n, LIGHT["nav"] | LIGHT["beacon"], dtype=np.int64)
    lights |= np.where(t < t_vac, LIGHT["strobe"], 0)
    lights |= np.where((below10k & air) | (after & (t < t_vac)), LIGHT["landing"], 0)
    lights |= np.where(t >= t_gear, LIGHT["turnoff"], 0)
    lights |= np.where(t >= t_vac, LIGHT["taxi"], 0)
    lights |= np.where(below10k & (sun < 0), LIGHT["logo"] | LIGHT["wing"], 0)
    cabin = np.where(below10k & (sun < -6) & (t < t_vac), 0.3, 1.0)

    i_rev_idle = _first(after & (np.asarray(gs) < REVERSE_IDLE_KT * KT))
    provenance = {k: "inferred" for k in ("flap", "slat", "gear", "speedbrake", "groundSpoiler", "reverser", "lights",
                                          "cabinLight")}
    notes = {
        "flap": "selected 1, 5, 15, %d by speed (within 10 kt of the current setting's manoeuvring speed for %.0f t) "
                "or gate (1 by 22 km, 5 before joining final, 15 with the gear, landing flap by 300 m), never while "
                "the rest of the approach exceeds the new setting's placard; travel 1 lever unit/s (estimate)"
                % (landing_flap, weight / 1000),
        "slat": "extend with flaps 1 to 5, full extend beyond 5 (spec.py SLATS schedule)",
        "gear": "down with flaps 15, never above 270 kt, before the landing flap; 10 s travel (estimate)",
        "speedbrake": "low confidence: only where the descent, in energy terms, is more than 25% steeper than clean "
                      "idle explains, clean and above 600 m; 0 on the ground (the ground spoilers carry it there)",
        "groundSpoiler": "0.5 s after touchdown until taxi speed",
        "reverser": "sleeves from 2 s after touchdown until taxi speed (idle reverse from 60 kt)",
        "lights": "section 7.8: position and beacon throughout, strobes until vacating, landing below 10,000 ft until "
                  "vacating, turn-off from gear down, taxi after vacating, wing and logo at night below 10,000 ft",
        "cabinLight": "dimmed to 0.3 from 10,000 ft when the sun is more than 6 deg below the horizon",
    }
    return {"flap": flap, "slat": slat, "gear": gear, "speedbrake": sbrake, "groundSpoiler": ground_spoiler,
            "reverser": reverser, "lights": lights, "cabinLight": cabin, "selections": selections,
            "gearDownT": t_gear, "vacateT": t_vac, "joinFinalT": None if j_final is None else float(t[j_final]),
            "reverseIdleT": None if i_rev_idle is None else float(t[i_rev_idle]),
            "landingFlap": landing, "provenance": provenance, "notes": notes}


def chapters(events, duration):
    """Chapters from the events: each runs from its event to the next, the last to the end; no gaps, no overlaps.
    Events at the same second collapse into the later one; the closing `end` event is not a chapter of its own."""
    evs = sorted((e for e in events if e["id"] != "end"), key=lambda e: e["t"])
    out = []
    for e in evs:
        if out and e["t"] <= out[-1]["from"]:
            out[-1] = {"id": e["id"], "label": e["label"], "from": out[-1]["from"]}
            continue
        out.append({"id": e["id"], "label": e["label"], "from": e["t"]})
    if not out or out[0]["from"] > 0:
        out.insert(0, {"id": "start", "label": "Start", "from": 0})
    for a, b in zip(out, out[1:]):
        a["to"] = b["from"]
    out[-1]["to"] = duration
    return [c for c in out if c["to"] > c["from"]]
