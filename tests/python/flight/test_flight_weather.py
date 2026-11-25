"""The weather a recorded flight was flown in (plan 03, sections 6.4 and 4.2; F2.8's as-flown weather and F5.3's
input): METARs around the arrival, the GFS column by level, and what follows from them deterministically: the cloud
layers with observed bases and estimated tops, the visibility and the rain at the aircraft, whether it is in cloud,
the in-cloud intervals along the track, and the picker's weather badge."""
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from lib import flight_weather as fw

ROOT = Path(__file__).resolve().parents[3]
FLIGHTS = ROOT / "public" / "data" / "lv" / "flights"
SEL = ROOT / "data" / "flights" / "lv"
ELEV = 664.5
FT = 0.3048


def ep(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def row(valid, metar, **kw):
    """An IEM ASOS row as the bake caches it (strings, 'M' for missing)."""
    r = {"station": "LAS", "valid": valid, "tmpf": "M", "alti": "M", "drct": "M", "sknt": "M", "gust": "M",
         "vsby": "M", "skyc1": "M", "skyl1": "M", "skyc2": "M", "skyl2": "M", "skyc3": "M", "skyl3": "M",
         "wxcodes": "M", "metar": metar}
    r.update({k: str(v) for k, v in kw.items()})
    return r


# the lv-wx morning, as cached (data/flights/lv/weather/lv-wx.json)
WX_ROWS = [
    row("2026-01-01 17:56", "KLAS 011756Z 10003KT 2SM BR BKN004 OVC008 08/07 A3018 RMK AO2 SFC VIS 3 RAE23 SLP221 P0001 "
        "60004 T00780072 10078 20072 50006", tmpf="46.00", alti="30.18", drct="100.00", sknt="3.00", vsby="2.00",
        skyc1="BKN", skyl1="400.00", skyc2="OVC", skyl2="800.00", wxcodes="BR"),
    row("2026-01-01 18:38", "KLAS 011838Z 09004KT 4SM BR BKN005 OVC009 08/07 A3016 RMK AO2 T00830072", tmpf="47.00",
        alti="30.16", drct="90.00", sknt="4.00", vsby="4.00", skyc1="BKN", skyl1="500.00", skyc2="OVC", skyl2="900.00",
        wxcodes="BR"),
    row("2026-01-01 18:56", "KLAS 011856Z 10003KT 4SM BR OVC005 08/07 A3016 RMK AO2 SLP214 T00830072", tmpf="47.00",
        alti="30.16", drct="100.00", sknt="3.00", vsby="4.00", skyc1="OVC", skyl1="500.00", wxcodes="BR"),
    row("2026-01-01 19:56", "KLAS 011956Z 00000KT 7SM OVC005 08/07 A3012 RMK AO2 SLP201 T00830072", tmpf="47.00",
        alti="30.12", drct="0.00", sknt="0.00", vsby="7.00", skyc1="OVC", skyl1="500.00"),
    row("2026-01-01 20:56", "KLAS 012056Z 00000KT 7SM OVC006 09/08 A3010 RMK AO2 SLP192 T00890078 58026", tmpf="48.00",
        alti="30.10", drct="0.00", sknt="0.00", vsby="7.00", skyc1="OVC", skyl1="600.00"),
    row("2026-01-01 21:56", "KLAS 012156Z 06004KT 10SM OVC006 09/08 A3008 RMK AO2 SLP186 T00890078", tmpf="48.00",
        alti="30.08", drct="60.00", sknt="4.00", vsby="10.00", skyc1="OVC", skyl1="600.00"),
]

LEVELS = (950, 925, 900, 850, 800, 750, 700, 650, 600, 500, 400, 300, 250)


def column(hours, z, t, rh, cc, extra=None):
    """A synthetic Open-Meteo hourly response with pressure levels: z, t, rh, cc are dicts level -> value (the same
    every hour)."""
    h = {"time": hours}
    for lev in LEVELS:
        h[f"geopotential_height_{lev}hPa"] = [z[lev]] * len(hours)
        h[f"temperature_{lev}hPa"] = [t[lev]] * len(hours)
        h[f"relative_humidity_{lev}hPa"] = [rh[lev]] * len(hours)
        h[f"cloud_cover_{lev}hPa"] = [cc[lev]] * len(hours)
    for k, v in (extra or {}).items():
        h[k] = [v] * len(hours)
    return {"hourly": h}


Z = {950: 600, 925: 820, 900: 1045, 850: 1510, 800: 2005, 750: 2530, 700: 3090, 650: 3680, 600: 4310, 500: 5710,
     400: 7355, 300: 9355, 250: 10555}
T = {950: 8.7, 925: 7.0, 900: 5.5, 850: 4.7, 800: 5.5, 750: 3.8, 700: 0.7, 650: -2.8, 600: -6, 500: -15.4, 400: -27.5,
     300: -44, 250: -51.7}
RH = {950: 96, 925: 99, 900: 100, 850: 98, 800: 95, 750: 90, 700: 80, 650: 60, 600: 45, 500: 60, 400: 48, 300: 46,
      250: 20}
CC = {950: 45, 925: 76, 900: 100, 850: 75, 800: 60, 750: 40, 700: 20, 650: 0, 600: 0, 500: 0, 400: 0, 300: 0, 250: 0}
HOURS = ["2026-01-01T18:00", "2026-01-01T19:00", "2026-01-01T20:00", "2026-01-01T21:00"]
TD = ep("2026-01-01T19:45:24Z")
START = TD - 1799


# --- METAR parsing -------------------------------------------------------------------------------------------------

def test_a_report_is_parsed_from_the_row_and_its_text():
    r = fw.parse_report(WX_ROWS[0], ELEV)
    assert r["valid"] == "2026-01-01T17:56Z"
    assert r["epoch"] == ep("2026-01-01T17:56:00Z")
    # the T group's tenths win over the body's whole degrees
    assert r["tempC"] == pytest.approx(7.8) and r["dewPointC"] == pytest.approx(7.2)
    assert r["visibilityM"] == pytest.approx(2 * 1609.344, abs=1)
    assert r["layers"] == [{"cover": "BKN", "baseFtAgl": 400}, {"cover": "OVC", "baseFtAgl": 800}]
    assert r["wx"] == ["BR"]
    assert r["precipitation"] is None          # mist is not precipitation
    assert r["altimeterInHg"] == pytest.approx(30.18)
    assert r["windDir"] == 100 and r["windKt"] == 3 and r["gustKt"] is None


def test_the_body_temperature_is_used_without_a_t_group_and_m_means_minus():
    r = fw.parse_report(row("2026-02-16 13:56", "KLAS 161356Z 00000KT 10SM OVC230 11/M01 A2980 RMK AO2 SLP081",
                            tmpf="51.80", alti="29.80", vsby="10.00", skyc1="OVC", skyl1="23000.00"), ELEV)
    assert r["tempC"] == 11 and r["dewPointC"] == -1
    assert r["layers"] == [{"cover": "OVC", "baseFtAgl": 23000}]
    assert r["visibilityCensored"] is True


def test_precipitation_codes_give_kind_and_intensity():
    r = fw.parse_report(row("2026-01-01 16:56", "KLAS 011656Z 05005KT 4SM -RA BR OVC004 08/07 A3017", wxcodes="-RA BR",
                            vsby="4.00", alti="30.17"), ELEV)
    assert r["precipitation"] == {"kind": "rain", "intensity": "light", "code": "-RA"}
    r = fw.parse_report(row("2026-01-01 16:56", "KLAS 011656Z 05005KT 1SM +SHRA OVC004 08/07 A3017", wxcodes="+SHRA",
                            vsby="1.00", alti="30.17"), ELEV)
    assert r["precipitation"]["kind"] == "rain" and r["precipitation"]["intensity"] == "heavy"
    r = fw.parse_report(row("2026-01-01 16:56", "KLAS 011656Z 05005KT 3SM DZ OVC004 08/07 A3017", wxcodes="DZ",
                            vsby="3.00", alti="30.17"), ELEV)
    assert r["precipitation"]["kind"] == "drizzle" and r["precipitation"]["intensity"] == "moderate"
    # VCSH (showers in the vicinity) is not at the station
    r = fw.parse_report(row("2026-01-01 16:56", "KLAS 011656Z 05005KT 10SM VCSH FEW080 08/07 A3017", wxcodes="VCSH",
                            vsby="10.00", alti="30.17"), ELEV)
    assert r["precipitation"] is None


def test_the_window_is_the_hour_before_the_recording_to_the_hour_after_touchdown():
    reps = fw.reports_in_window([fw.parse_report(r, ELEV) for r in WX_ROWS], START, TD)
    assert [r["valid"] for r in reps] == ["2026-01-01T18:38Z", "2026-01-01T18:56Z", "2026-01-01T19:56Z"]


# --- the column ----------------------------------------------------------------------------------------------------

def test_the_column_is_interpolated_in_time_and_cut_at_the_station():
    col = fw.column_at(column(HOURS, Z, T, RH, CC), TD, ELEV, surface={"tempC": 8.3, "dewPointC": 7.2,
                                                                       "pressureHPa": 941.0})
    z = [r[0] for r in col]
    assert z[0] == ELEV and z == sorted(z)
    assert 600 not in z                          # 950 hPa is below the station
    first = col[0]
    assert first[1] == pytest.approx(941.0) and first[2] == pytest.approx(8.3)
    assert first[3] == pytest.approx(fw.rh_from(8.3, 7.2) * 100, abs=0.01)
    lev900 = next(r for r in col if r[0] == 1045)
    assert lev900[1:] == [900, 5.5, 100, 100]


# --- layers --------------------------------------------------------------------------------------------------------

def test_an_overcast_takes_its_base_from_the_report_and_its_top_from_the_model_cloud_cover():
    reps = fw.reports_in_window([fw.parse_report(r, ELEV) for r in WX_ROWS], START, TD)
    col = fw.column_at(column(HOURS, Z, T, RH, CC), TD, ELEV)
    layers = fw.layers_at(reps, TD, col, ELEV)
    assert len(layers) == 1
    L = layers[0]
    assert L["cover"] == "OVC" and L["fraction"] == 1.0 and L["genus"] == "st"
    assert L["baseM"] == pytest.approx(ELEV + 500 * FT, abs=0.1)
    assert L["base"] == "observed"
    # cloud cover by level drops through 50 % between 800 hPa (60 %, 2,005 m) and 750 hPa (40 %, 2,530 m)
    assert L["topM"] == pytest.approx(2005 + (60 - 50) / (60 - 40) * (2530 - 2005), abs=1)
    assert L["top"].startswith("estimated")


def test_without_model_cloud_at_the_base_the_top_comes_from_the_humidity_and_then_from_plan_01s_depths():
    reps = fw.reports_in_window([fw.parse_report(r, ELEV) for r in WX_ROWS], START, TD)
    dry_cc = {k: 0 for k in CC}
    col = fw.column_at(column(HOURS, Z, T, RH, dry_cc), TD, ELEV)
    L = fw.layers_at(reps, TD, col, ELEV)[0]
    # relative humidity falls through 90 % at 750 hPa
    assert L["topM"] == pytest.approx(2530, abs=1)
    assert "humidity" in L["top"]
    dry = {k: 40 for k in RH}
    col = fw.column_at(column(HOURS, Z, T, dry, dry_cc), TD, ELEV)
    L = fw.layers_at(reps, TD, col, ELEV)[0]
    assert L["topM"] == pytest.approx(L["baseM"] + 300, abs=0.1)   # plan 01's depth for stratus
    assert "depth" in L["top"]


def test_the_nearest_report_gives_the_layers_and_the_base_never_comes_from_the_model():
    reps = [fw.parse_report(r, ELEV) for r in WX_ROWS]
    col = fw.column_at(column(HOURS, Z, T, RH, CC), ep("2026-01-01T18:40:00Z"), ELEV)
    layers = fw.layers_at(reps, ep("2026-01-01T18:40:00Z"), col, ELEV)
    assert [l["cover"] for l in layers] == ["BKN", "OVC"]
    assert layers[0]["baseM"] == pytest.approx(ELEV + 500 * FT, abs=0.1)
    # the lower layer cannot reach into the one above it
    assert layers[0]["topM"] <= layers[1]["baseM"]


def test_high_cloud_takes_plan_01s_genus_and_depth():
    r = fw.parse_report(row("2026-03-10 06:56", "KLAS 100656Z 00000KT 10SM FEW250 17/03 A2991 RMK AO2", vsby="10.00",
                            alti="29.91", skyc1="FEW", skyl1="25000.00"), ELEV)
    col = fw.column_at(column(HOURS, Z, T, RH, {k: 0 for k in CC}), r["epoch"], ELEV)
    L = fw.layers_at([r], r["epoch"], col, ELEV)[0]
    assert L["genus"] == "ci" and L["fraction"] == pytest.approx(0.19)
    assert L["topM"] - L["baseM"] == pytest.approx(1000)


def test_no_layer_when_the_sky_is_clear():
    r = fw.parse_report(row("2026-03-10 08:56", "KLAS 100856Z 19003KT 10SM CLR 16/03 A2990 RMK AO2", vsby="10.00",
                            alti="29.90", skyc1="CLR", skyl1="M"), ELEV)
    col = fw.column_at(column(HOURS, Z, T, RH, CC), r["epoch"], ELEV)
    assert fw.layers_at([r], r["epoch"], col, ELEV) == []


# --- at the aircraft -----------------------------------------------------------------------------------------------

LAYERS = [{"cover": "OVC", "fraction": 1.0, "genus": "st", "baseM": 817.0, "topM": 2267.0},
          {"cover": "SCT", "fraction": 0.44, "genus": "ac", "baseM": 4000.0, "topM": 4500.0}]


def test_in_cloud_only_inside_a_broken_or_overcast_layer():
    assert fw.in_cloud(1500, LAYERS) is True
    assert fw.in_cloud(800, LAYERS) is False      # below the base
    assert fw.in_cloud(2300, LAYERS) is False     # above the top
    assert fw.in_cloud(4200, LAYERS) is False     # scattered: the aircraft is taken to pass between the clouds


def test_visibility_below_the_base_is_the_reports_in_cloud_an_estimate_above_clear():
    assert fw.visibility_at(700, LAYERS, 11265) == pytest.approx(11265)
    assert fw.visibility_at(1500, LAYERS, 11265) == fw.IN_CLOUD_VISIBILITY_M["st"]
    assert fw.visibility_at(3000, LAYERS, 11265) == fw.CLEAR_VISIBILITY_M


def test_rain_falls_only_where_the_record_has_it():
    none = {"rateMmH": 0.0, "kind": "none"}
    assert fw.rain_at(700, LAYERS, none) == 0
    light = {"rateMmH": 1.0, "kind": "rain"}
    assert fw.rain_at(700, LAYERS, light) == 1.0
    assert fw.rain_at(1500, LAYERS, light) == 1.0
    assert fw.rain_at(3000, LAYERS, light) == 0     # above the raining layer's top


def test_precipitation_over_the_flight_comes_only_from_reports_bracketing_it():
    reps = [fw.parse_report(r, ELEV) for r in WX_ROWS]
    p = fw.precipitation_over(reps, START, TD + 170)
    assert p["rateMmH"] == 0 and p["kind"] == "none"
    # the morning's rain (ended 17:23, RAE23) does not reach 19:15 to 19:48
    rain = [fw.parse_report(row("2026-01-01 19:10", "KLAS 011910Z 05005KT 4SM -RA BR OVC004 08/07 A3017",
                                wxcodes="-RA BR", vsby="4.00", alti="30.17"), ELEV)]
    p = fw.precipitation_over(sorted(reps + rain, key=lambda r: r["epoch"]), START, TD + 170)
    assert p["kind"] == "rain" and p["rateMmH"] == pytest.approx(1.0)


def test_in_cloud_intervals_along_a_track():
    t = np.arange(0, 100, 1.0)
    h = np.concatenate([np.linspace(3000, 700, 90), np.full(10, 700.0)])
    iv = fw.in_cloud_intervals(t, h, LAYERS)
    assert len(iv) == 1
    a, b = iv[0]
    assert h[int(a)] <= 2267 + 30 and h[int(b)] >= 817 - 30


# --- the badge -----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("layers,precip,wind,want", [
    ([], None, (0, None), "clear"),
    ([{"cover": "FEW", "fraction": 0.19}], None, (5, None), "clear"),
    ([{"cover": "SCT", "fraction": 0.44}], None, (5, None), "scattered"),
    ([{"cover": "FEW", "fraction": 0.19}, {"cover": "BKN", "fraction": 0.75}], None, (5, None), "overcast"),
    ([{"cover": "OVC", "fraction": 1.0}], {"kind": "rain", "rateMmH": 1.0}, (5, None), "rain"),
    ([{"cover": "FEW", "fraction": 0.19}], None, (10, 21), "wind"),
    ([{"cover": "FEW", "fraction": 0.19}], None, (16, None), "wind"),
    ([{"cover": "OVC", "fraction": 1.0}], None, (16, 25), "overcast"),
])
def test_the_badge_uses_section_4_2s_words(layers, precip, wind, want):
    assert fw.badge(layers, precip or {"kind": "none", "rateMmH": 0}, {"windKt": wind[0], "gustKt": wind[1]}) == want
    assert want in fw.BADGES


# --- the committed record ------------------------------------------------------------------------------------------

def _head(fid):
    return json.loads((FLIGHTS / f"{fid}.json").read_text())


def _ids():
    return [f["id"] for f in json.loads((SEL / "selection.json").read_text())["flights"]]


@pytest.mark.parametrize("fid", _ids())
def test_every_flight_carries_its_weather(fid):
    w = _head(fid)["weather"]
    assert w["format"] == fw.FORMAT
    assert len(w["reports"]) >= 2                          # not one report
    assert all(set(r) >= {"t", "valid", "metar", "layers", "visibilityM"} for r in w["reports"])
    assert w["aloft"] and all(len(r) == 5 for r in w["aloft"])
    assert [r[0] for r in w["aloft"]] == sorted(r[0] for r in w["aloft"])
    for L in w["layers"]:
        assert L["base"] == "observed" and L["top"].startswith("estimated")
        assert L["topM"] > L["baseM"]
    assert w["badge"] in fw.BADGES
    assert _head(fid)["badges"]["weather"] == w["badge"]
    # the served header stays small (section 9.2: about 150 KB a track)
    assert len((FLIGHTS / f"{fid}.json").read_bytes()) < 40_000


def test_lv_wx_descends_through_the_overcast_and_breaks_out_on_short_final():
    h = _head("lv-wx")
    w = h["weather"]
    assert w["badge"] == "overcast"
    low = w["layers"][0]
    assert low["cover"] == "OVC" and low["baseM"] == pytest.approx(ELEV + 500 * FT, abs=0.5)
    assert 1500 < low["topM"] < 3500
    assert w["precipitation"]["rateMmH"] == 0              # the morning's rain had ended (RAE23)
    assert w["surface"]["visibilityM"] > 9000              # 4 to 7 SM around the arrival, interpolated
    iv = w["inCloud"]
    assert len(iv) >= 1
    td = h["touchdownT"]
    last_out = iv[-1][1]
    # out of the base on short final: 30 s to 2 min before touchdown at 3 degrees and 140 kt
    assert 30 < td - last_out < 150
    # and in cloud for minutes before that
    assert sum(b - a for a, b in iv) > 180


@pytest.mark.parametrize("fid,want", [("lv-19-dusk", "wind"), ("lv-19-day", "overcast"), ("lv-19-night", "clear"),
                                      ("lv-26-day", "scattered"), ("lv-26-night", "overcast")])
def test_the_other_flights_badges_follow_their_metars(fid, want):
    w = _head(fid)["weather"]
    assert w["badge"] == want
    assert w["precipitation"]["rateMmH"] == 0
    assert all(L["baseM"] - ELEV > 3500 for L in w["layers"])   # only high cloud on these five


def test_nothing_identifying_in_the_weather_record():
    for fid in _ids():
        text = json.dumps(_head(fid)["weather"]).lower()
        # no client name, address or local path (the format's own name is the app's, as in skyline-flight/1)
        assert "skyline-data" not in text and "@" not in text and "/users/" not in text


def test_rain_that_began_and_ended_between_reports_is_read_from_the_remarks():
    reps = [fw.parse_report(r, ELEV) for r in WX_ROWS]
    # 19:56 says nothing falls now, but its remarks say rain fell from 19:25 to 19:40: inside the flight
    between = fw.parse_report(row("2026-01-01 19:56", "KLAS 011956Z 00000KT 7SM OVC005 08/07 A3012 RMK AO2 RAB25E40",
                                  vsby="7.00", alti="30.12", skyc1="OVC", skyl1="500.00"), ELEV)
    assert between["events"] == [(ep("2026-01-01T19:25:00Z"), "rain", True), (ep("2026-01-01T19:40:00Z"), "rain", False)]
    reps = [r for r in reps if r["valid"] != "2026-01-01T19:56Z"] + [between]
    p = fw.precipitation_over(sorted(reps, key=lambda r: r["epoch"]), START, TD + 170)
    assert p["kind"] == "rain" and p["rateMmH"] == pytest.approx(1.0)   # intensity unknown: light
    # and a flight after 19:40 stays dry
    assert fw.precipitation_over(sorted(reps, key=lambda r: r["epoch"]), ep("2026-01-01T19:41:00Z"),
                                 ep("2026-01-01T19:50:00Z"))["rateMmH"] == 0
