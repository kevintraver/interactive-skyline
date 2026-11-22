"""Writes the three-station TMAS fixture used by tests/data/test_traffic.py.

Run from the repository root: python3 tests/data/fixtures/traffic/make_fixture.py

Stations (TMAS ids; TRINA ids carry a leading zero):
  000001  rural, 2 lanes each way, counted two weeks in every season; one northbound day (Jan 13)
          has lane 2 missing and one southbound day (Feb 10) has lane 1 zero all day.
  000002  partial year: counted only in the winter and autumn weeks, 3 lanes each way.
  000003  urban, 3 lanes each way, every season, a weekday-commute pattern.
"""
import datetime as dt
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEEKS = [(1, 6), (2, 3), (4, 7), (5, 5), (7, 7), (8, 4), (10, 6), (11, 3)]  # (month, Monday)
SEASON = {1: 0, 2: 0, 4: 1, 5: 1, 7: 2, 8: 2, 10: 3, 11: 3}


def profile(kind, d, h, direction):
    w = d.weekday()
    if kind == "rural":
        day = [0.85, 0.8, 0.85, 0.95, 1.35, 1.1, 1.2][w] if direction == 1 else [0.9, 0.8, 0.8, 0.9, 1.0, 1.05, 1.45][w]
        peak = 15 if direction == 1 else 11
        shape = 0.15 + math.exp(-((h - peak) / 4.0) ** 2)
    else:
        day = [1.05, 1.05, 1.05, 1.05, 1.1, 0.85, 0.75][w]
        shape = 0.1 + 0.8 * math.exp(-((h - 7.5) / 1.5) ** 2) + math.exp(-((h - 17) / 2.0) ** 2) + 0.3 * math.exp(-((h - 12) / 3) ** 2)
    season = [0.9, 1.0, 1.1, 1.0][SEASON[d.month]]
    return day * shape * season


STATIONS = {
    "000001": {"kind": "rural", "lanes": 2, "base": 900, "shares": [0.62, 0.38], "lat": 35.0, "lon": -115.0},
    "000002": {"kind": "rural", "lanes": 3, "base": 1500, "shares": [0.3, 0.4, 0.3], "lat": 35.04, "lon": -115.0},
    "000003": {"kind": "urban", "lanes": 3, "base": 3000, "shares": [0.25, 0.4, 0.35], "lat": 35.08, "lon": -115.0},
}


def days_for(sid):
    out = []
    for m, mon in WEEKS:
        if sid == "000002" and SEASON[m] not in (0, 3):
            continue
        out += [dt.date(2025, m, mon) + dt.timedelta(days=k) for k in range(7)]
    return out


def main():
    vol, st = [], []
    for sid, s in STATIONS.items():
        for direction in (1, 5):
            for lane in range(1, s["lanes"] + 1):
                st.append(f"S|32|{sid}|{direction}|{lane}|2025|1|{s['lanes']}|{s['lat']}|{s['lon']}|fixture {sid}")
            days = days_for(sid) + ([dt.date(2025, 1, 13)] if sid == "000001" and direction == 1 else []) \
                + ([dt.date(2025, 2, 10)] if sid == "000001" and direction == 5 else [])
            for d in days:
                dow = (d.weekday() + 1) % 7 + 1  # TMAS: 1 = Sunday
                for lane in range(1, s["lanes"] + 1):
                    if sid == "000001" and direction == 1 and d == dt.date(2025, 1, 13) and lane == 2:
                        continue
                    counts = [round(s["base"] * s["shares"][lane - 1] * profile(s["kind"], d, h, direction)) for h in range(24)]
                    if sid == "000001" and direction == 5 and d == dt.date(2025, 2, 10) and lane == 1:
                        counts = [0] * 24
                    vol.append("|".join(["3", "32", "1", sid, str(direction), str(lane), "25", f"{d.month:02d}", f"{d.day:02d}",
                                         str(dow), ""] + [str(c) for c in counts]))
    (HERE / "volume.txt").write_text("\n".join(vol) + "\n")
    (HERE / "stations.txt").write_text("\n".join(st) + "\n")


if __name__ == "__main__":
    main()
