"""Configuration, lights and chapters (plan 03, F2.5; section 7.2 steps 10 and 11, section 7.3): flaps selected by
speed or gate and never above a placard, slats with them, gear with flaps 15 and before the landing flap, the speed
brake only where the descent needs it, ground spoilers and reversers after touchdown, the lights of section 7.8 and a
chapter list with no gaps."""
import numpy as np
import pytest

from lib import config_schedule as C

KT = 1852 / 3600
FT = 0.3048
FIELD = 664.0
L = C.LIGHT


def _approach(n=1400, td=1200, slow_late=False, ias_hold_kt=None):
    """A synthetic arrival on 1 Hz: 8,000 ft and 250 kt 1,200 s out, decelerating to 147 kt on a 3-degree final;
    to_go falls with the ground speed; touchdown at `td`, rollout to taxi speed."""
    t = np.arange(float(n))
    air = t < td
    # indicated airspeed: 280 kt, down to 250 by 10,000 ft, to 210 at 25 km, 180 at 15 km, 147 from 7 km
    to_go_guess = np.maximum(td - t, 0) * 100.0
    knots = np.interp(-to_go_guess, [-120000, -60000, -25000, -15000, -7000, 0], [280, 250, 210, 180, 147, 147])
    if slow_late:
        knots = np.interp(-to_go_guess, [-120000, -12000, -9000, -6000, 0], [250, 230, 185, 150, 147])
    if ias_hold_kt is not None:
        knots = np.where(to_go_guess > 30000, ias_hold_kt, knots)
    gs_air = knots * KT * 1.05
    rollout = np.maximum(75 - 2.0 * (t - td), 8.0)
    gs = np.where(air, gs_air, rollout)
    s = np.concatenate([[0.0], np.cumsum(gs[:-1])])
    to_go = s[int(td) - 6] - s                       # threshold 6 s before touchdown
    above = np.where(air, np.clip(np.maximum(to_go, 0) * np.tan(np.radians(3.0)) + 15, 0, None), 0.0)
    above = np.minimum(above, 15000 * FT - FIELD + np.zeros(n))
    h = FIELD + above
    on_final = air & (to_go < 14000) & (to_go > -500)
    ias = np.where(air, knots, gs / KT)
    vs = np.gradient(h, t)
    return dict(t=t, air=air, td=float(td), ias_kt=ias, h=h, above_field=above, to_go=to_go, on_final=on_final,
                gs=gs, tas=gs, vs=vs, sun=np.full(n, 20.0), weight=60000.0)


def _sched(**kw):
    a = _approach(**{k: kw.pop(k) for k in list(kw) if k in ("n", "td", "slow_late", "ias_hold_kt")})
    a.update(kw)
    return a, C.schedule(**a)


def test_flaps_are_monotonic_on_the_approach_and_end_at_the_landing_flap():
    a, s = _sched()
    f = s["flap"][a["air"]]
    assert np.all(np.diff(f) >= -1e-9)
    assert f[-1] == pytest.approx(30.0)
    assert [x["flap"] for x in s["selections"]] == [1, 5, 15, 30]


def test_flaps_never_exceed_the_placard():
    for kw in ({}, {"slow_late": True}, {"ias_hold_kt": 260}):
        a, s = _sched(**kw)
        assert C.placard_exceedances(s["flap"], a["ias_kt"], a["air"]) == [], kw


def test_a_fast_approach_holds_the_flaps_until_the_speed_allows():
    a, s = _sched(slow_late=True)
    sel = {x["flap"]: x["t"] for x in s["selections"]}
    for flap, limit in ((15, 200), (30, 175)):
        i = int(sel[flap])
        assert a["ias_kt"][i:int(a["td"])].max() <= limit


def test_gates_flaps_1_by_22_km_landing_flap_by_300_m():
    a, s = _sched()
    sel = {x["flap"]: x["t"] for x in s["selections"]}
    assert a["to_go"][int(sel[1])] >= 22000 - 1
    assert a["above_field"][int(sel[30])] >= 300 - 1


def test_gear_with_flaps_15_before_the_landing_flap_and_by_9_km():
    a, s = _sched()
    sel = {x["flap"]: x["t"] for x in s["selections"]}
    tg = s["gearDownT"]
    assert tg == pytest.approx(sel[15], abs=1)
    assert tg < sel[30]
    assert a["to_go"][int(tg)] >= 9000 - 1
    assert s["gear"][int(a["td"])] == pytest.approx(1.0)
    assert a["ias_kt"][int(tg):int(a["td"])].max() <= C.GEAR_LIMIT_KT


def test_slats_follow_the_flap_lever():
    a, s = _sched()
    f, sl = s["flap"], s["slat"]
    assert np.all(sl[f == 0] == 0)
    assert np.allclose(sl[(f >= 1) & (f <= 5)], 1.0)
    assert np.allclose(sl[f >= 10], 2.0)


def test_spoilers_and_reversers_after_touchdown_only():
    a, s = _sched()
    t, td = a["t"], a["td"]
    gsp, rev = s["groundSpoiler"], s["reverser"]
    assert np.all(gsp[t <= td] == 0) and np.all(rev[t < td + 2] == 0)
    assert gsp[int(td) + 1] >= 0.5 and gsp[int(td) + 2] == pytest.approx(1.0)
    assert rev[int(td) + 4] == pytest.approx(1.0)
    taxi = (t > td) & (a["gs"] < C.TAXI_MS)
    assert np.all(rev[taxi][3:] == 0) and np.all(gsp[taxi][3:] == 0)


def test_lights_landing_by_10000_ft_strobes_until_vacating_taxi_after():
    a, s = _sched()
    lights = s["lights"].astype(int)
    t = a["t"]
    assert np.all(lights & (L["nav"] | L["beacon"]) == (L["nav"] | L["beacon"]))
    below = a["air"] & (a["h"] < 10000 * FT)
    assert np.all(lights[below] & L["landing"])
    above = a["h"] > 10000 * FT + 50
    assert not np.any(lights[above] & L["landing"])
    tv = s["vacateT"]
    assert np.all(lights[t < tv] & L["strobe"]) and not np.any(lights[t > tv] & L["strobe"])
    assert np.all(lights[t > tv + 1] & L["taxi"])
    assert np.all(lights[t >= s["gearDownT"]] & L["turnoff"])
    assert not np.any(lights & (L["logo"] | L["wing"]))          # by day


def test_wing_and_logo_lights_and_a_dimmed_cabin_at_night():
    a, s = _sched(sun=np.full(1400, -20.0))
    lights = s["lights"].astype(int)
    below = a["air"] & (a["h"] < 10000 * FT)
    assert np.all(lights[below] & L["wing"]) and np.all(lights[below] & L["logo"])
    assert np.all(s["cabinLight"][below] < 1.0)
    day = _sched()[1]
    assert np.all(day["cabinLight"] == 1.0)


def test_the_speed_brake_shows_only_where_the_descent_is_steeper_than_idle():
    n = 900
    t = np.arange(float(n))
    ias = np.full(n, 280.0)
    tas = ias * KT * 1.4
    vs = np.full(n, -2200 * FT / 60)
    vs[300:500] = -4000 * FT / 60                 # 180 % of the idle rate at 280 kt for 200 s
    h = 9000 + np.concatenate([[0], np.cumsum(vs[:-1])])
    out = C.speed_brake(t, ias_kt=ias, tas=tas, vs=vs, above_field=h - FIELD, flap=np.zeros(n), gear=np.zeros(n),
                        air=np.ones(n, bool))
    assert out[350:450].min() > 0.3
    assert out[:250].max() == 0 and out[560:].max() == 0
    # with flaps out the extra drag explains it: nothing shown
    out2 = C.speed_brake(t, ias_kt=ias, tas=tas, vs=vs, above_field=h - FIELD, flap=np.full(n, 5.0),
                         gear=np.zeros(n), air=np.ones(n, bool))
    assert out2.max() == 0


def test_chapters_cover_the_flight_without_gaps():
    events = [{"t": 0, "s": 0, "id": "cruise", "label": "Cruise"}, {"t": 300, "s": 1, "id": "tod", "label": "Top"},
              {"t": 900, "s": 2, "id": "10000", "label": "10"}, {"t": 1200, "s": 3, "id": "touchdown", "label": "T"},
              {"t": 1399, "s": 4, "id": "end", "label": "End"}]
    ch = C.chapters(events, duration=1399)
    assert ch[0]["from"] == 0 and ch[-1]["to"] == 1399
    for a, b in zip(ch, ch[1:]):
        assert a["to"] == b["from"]
    assert all(c["to"] > c["from"] for c in ch)
    assert [c["id"] for c in ch] == ["cruise", "tod", "10000", "touchdown"]


def test_every_configuration_channel_has_a_provenance_tag():
    a, s = _sched()
    for ch in ("flap", "slat", "gear", "speedbrake", "groundSpoiler", "reverser", "lights", "cabinLight"):
        assert s["provenance"][ch] in ("recorded", "derived", "inferred")
        assert s["notes"][ch]


def test_no_flaps_above_20000_ft_even_when_slow():
    a = _approach()
    a["h"] = np.where(a["t"] < 400, 22000 * FT, a["h"])
    a["ias_kt"] = np.where(a["t"] < 400, 200.0, a["ias_kt"])
    s = C.schedule(**a)
    assert np.all(s["flap"][a["h"] > 20000 * FT] == 0)
