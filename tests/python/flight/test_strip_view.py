"""Which side of the aircraft the Strip is on, and how it is seen (plan 03 section 6.2's `stripSide` badge): from the
geometry of the last three minutes before touchdown, the share of the Strip's towers within view of each side's
windows, and what the badges say for runway 19 and runway 26."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from lib import flight_view as V

ROOT = Path(__file__).resolve().parents[3]
FLIGHTS = ROOT / "public" / "data" / "lv" / "flights"


def _straight(heading, start, n=200, speed=75.0, h=900.0):
    hd = math.radians(heading)
    t = np.arange(n, dtype=float)
    x = start[0] + speed * t * math.sin(hd)
    y = start[1] + speed * t * math.cos(hd)
    return {"x": x, "n": y, "h": np.full(n, h), "hdg": np.full(n, heading), "pitch": np.zeros(n), "roll": np.zeros(n)}


def test_a_point_abeam_on_the_right_is_seen_from_the_right_windows():
    ch = _straight(0.0, (0.0, -7000.0))
    pts = np.array([[3000.0, 0.0, 700.0]])          # east of a northbound track: on the right
    v = V.strip_view(ch, pts, td=199)
    assert v["rightShare"] > 0.5 and v["leftShare"] == 0
    assert v["stripSide"] == "right"


def test_mirrored_it_is_on_the_left():
    ch = _straight(0.0, (0.0, -7000.0))
    v = V.strip_view(ch, np.array([[-3000.0, 0.0, 700.0]]), td=199)
    assert v["stripSide"] == "left" and v["leftShare"] > 0.5 and v["rightShare"] == 0


def test_a_point_dead_ahead_is_ahead_not_on_a_side():
    ch = _straight(0.0, (0.0, -40000.0))
    v = V.strip_view(ch, np.array([[0.0, 0.0, 700.0]]), td=199)
    assert v["aheadShare"] > 0.9 and v["stripView"] == "ahead"


def test_bank_tilts_the_view():
    # banked right 30 degrees, the right windows look down: a point far below on the right is easier to see
    ch = _straight(0.0, (0.0, -7000.0), h=3000.0)
    pts = np.array([[700.0, 0.0, 700.0]])             # steeply below and to the right
    level = V.strip_view(ch, pts, td=199)
    ch["roll"] = np.full(200, 30.0)
    banked = V.strip_view(ch, pts, td=199)
    assert banked["rightShare"] > level["rightShare"]


def test_the_strip_file_holds_the_resort_corridor():
    pts = V.load_strip(ROOT / "data" / "flights" / "lv" / "strip.json")
    assert 20 <= len(pts) <= 120
    # from Mandalay Bay to the Strat, along Las Vegas Boulevard
    assert pts[:, 1].min() < -2400 and pts[:, 1].max() > 3500
    assert np.all(np.abs(pts[:, 0] - np.interp(pts[:, 1], [-2600, 0, 3700], [-200, 0, 1550])) < 900)


@pytest.mark.parametrize("fid", ["lv-19-day", "lv-19-night", "lv-26-day", "lv-26-night", "lv-wx", "lv-19-dusk"])
def test_the_served_badges_follow_the_geometry(fid):
    path = FLIGHTS / f"{fid}.json"
    if not path.exists():
        pytest.skip("not baked")
    head = json.loads(path.read_text())
    data = np.frombuffer((FLIGHTS / f"{fid}.bin").read_bytes(), dtype="<f4").reshape(len(head["channels"]), -1)
    ch = dict(zip(head["channels"], data.astype(float)))
    pts = V.load_strip(ROOT / "data" / "flights" / "lv" / "strip.json")
    v = V.strip_view(ch, pts, td=int(head["touchdownT"]))
    assert head["badges"]["stripSide"] == v["stripSide"]
    assert head["badges"]["stripView"] == v["stripView"]
    assert head["badges"]["stripView"] in V.STRIP_VIEWS
    # what the geometry says on these runways: nothing from the left; on 19 the Strip passes along the right in the
    # last minute; on 26 it stays ahead and to the right
    assert v["leftShare"] < 0.05 and v["stripSide"] == "right"
    expect = "passes-right" if head["runway"].startswith("19") else "ahead-right"
    assert v["stripView"] == expect
