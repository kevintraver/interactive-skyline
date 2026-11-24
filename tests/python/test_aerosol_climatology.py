# T5.4: the monthly aerosol climatology (plan 01, section 6.1, finding 2), its arithmetic on synthetic hours, and the
# committed files against the AERONET seasonal means the plan quotes. Nothing here touches the network.
import datetime as dt
import json

import pytest

import build_aerosol_climatology as bac
from conftest import ROOT

# Frenchman Flat, 104 km north-west of Las Vegas, 2006-2015, 500 nm (section 6.1): DJF, MAM, JJA, SON
AERONET_LV = {"DJF": 0.04, "MAM": 0.08, "JJA": 0.09, "SON": 0.06}


def hour(y, m, d, h, aod, dust=1.0):
    t = int(dt.datetime(y, m, d, h, tzinfo=dt.timezone.utc).timestamp())
    return {"t": t, "aod": aod, "dust": dust, "pm10": 10.0, "pm25": 5.0}


def test_monthly_statistics_and_seasons():
    hours = [hour(2023, m, 1, h, 0.05 + 0.01 * m + (0.1 if h == 0 else 0)) for m in range(1, 13) for h in range(10)]
    hours.append(hour(2023, 7, 2, 0, None))  # a gap: skipped
    c = bac.climatology(hours)
    jul = c["months"][6]
    assert jul["month"] == 7 and jul["hours"] == 10
    assert jul["aod550Median"] == pytest.approx(0.12)
    assert jul["aod550Mean"] == pytest.approx(0.13)
    assert jul["aod550P90"] == pytest.approx(0.12 + 0.01, abs=0.011)
    assert c["seasons"]["JJA"] == pytest.approx(0.05 + 0.07 + 0.01, abs=0.002)


def test_a_month_without_data_is_an_error():
    with pytest.raises(SystemExit):
        bac.climatology([hour(2023, 1, 1, 0, 0.1)])


def test_last_complete_month():
    assert bac.last_complete_month_end(dt.date(2026, 11, 22)) == dt.date(2026, 10, 31)
    assert bac.last_complete_month_end(dt.date(2026, 1, 3)) == dt.date(2025, 12, 31)


@pytest.mark.parametrize("city", ["lv", "slc"])
def test_committed_file_shape(city):
    d = json.loads((ROOT / f"public/data/{city}/aerosol.json").read_text())
    assert [m["month"] for m in d["months"]] == list(range(1, 13))
    assert d["period"][0] == "2022-08-04"
    assert "Copernicus Atmosphere Monitoring Service" in d["attribution"]
    for m in d["months"]:
        assert m["hours"] > 2000  # at least three years of every month
        assert 0.02 < m["aod550Median"] <= m["aod550P90"] < 0.6
        assert m["aod550Mean"] > 0


def test_las_vegas_against_aeronet():
    """CAMS runs a little high against the ground photometer (section 6.1 quotes 0.07, 0.11, 0.10, 0.07 against
    0.04, 0.08, 0.09, 0.06): each season within 0.04 of AERONET, the same seasonal shape, and the plan's own figures."""
    s = json.loads((ROOT / "public/data/lv/aerosol.json").read_text())["seasons"]
    for k, v in AERONET_LV.items():
        assert abs(s[k] - v) <= 0.04, (k, s[k], v)
    assert s["JJA"] > s["DJF"] and s["MAM"] > s["SON"]
    assert s == pytest.approx({"DJF": 0.07, "MAM": 0.11, "JJA": 0.10, "SON": 0.07}, abs=0.006)
