"""Which runway an arrival used, and whether it is one approach (plan 03, F2.1; 8.2 test_runway_classify)."""
import numpy as np
import pytest

from lib import adsb


@pytest.mark.parametrize("end_id", ["1L", "1R", "19L", "19R", "8L", "8R", "26L", "26R"])
def test_each_las_runway_end_is_identified_from_a_final(synthetic, lv_frame, lv_airport, end_id):
    truth = synthetic.approach(lv_airport["ends"][end_id], final_m=8000, rollout_s=40)
    p = adsb.points(synthetic.record(truth, lv_frame, every=3))
    landings = adsb.find_landings(p, lv_airport, lv_frame)
    assert len(landings) == 1
    assert landings[0]["runway"] == end_id
    assert landings[0]["goAround"] is False


def test_a_final_offset_towards_the_parallel_is_not_confused(synthetic, lv_frame, lv_airport):
    # 19R and 19L are 286 m apart: a final 60 m right of 19R's centre line is still 19R
    truth = synthetic.approach(lv_airport["ends"]["19R"], final_m=8000, rollout_s=40, lateral_m=60.0)
    p = adsb.points(synthetic.record(truth, lv_frame, every=3))
    assert adsb.find_landings(p, lv_airport, lv_frame)[0]["runway"] == "19R"
    truth = synthetic.approach(lv_airport["ends"]["26L"], final_m=8000, rollout_s=40, lateral_m=-70.0)
    p = adsb.points(synthetic.record(truth, lv_frame, every=3))
    assert adsb.find_landings(p, lv_airport, lv_frame)[0]["runway"] == "26L"


def test_a_go_around_is_flagged(synthetic, lv_frame, lv_airport):
    end = lv_airport["ends"]["26L"]
    first = synthetic.approach(end, final_m=8000, rollout_s=0)
    # cut the first approach at 100 m above the runway and climb away straight ahead, circle, land
    z_thr = end["threshold"][2]
    low = np.flatnonzero(first.h - z_thr < 100)[0]
    ga = synthetic.Truth({k: first[k][:low] for k in ("t", "x", "n", "h", "gs", "trk", "vs", "ground")})
    climb = synthetic.fly(ga.x[-1], ga.n[-1], ga.h[-1], end["gridHeading"], 72.0,
                          [{"dur": 90, "vs": 8.0}, {"dur": 60, "turn": 3.0, "ramp": 5}, {"dur": 120, "ramp": 5},
                           {"dur": 60, "turn": 3.0, "ramp": 5}, {"dur": 60, "ramp": 5}])
    second = synthetic.approach(end, final_m=8000, rollout_s=40)
    whole = synthetic.concat(synthetic.concat(ga, climb), second)
    p = adsb.points(synthetic.record(whole, lv_frame, every=3))
    landings = adsb.find_landings(p, lv_airport, lv_frame)
    assert len(landings) == 1
    assert landings[0]["runway"] == "26L"
    assert landings[0]["goAround"] is True


def test_a_departure_is_not_an_arrival(synthetic, lv_frame, lv_airport):
    end = lv_airport["ends"]["19R"]
    truth = synthetic.approach(end, final_m=8000, rollout_s=40)
    rev = synthetic.Truth({k: truth[k][::-1].copy() for k in ("x", "n", "h", "gs", "ground")})
    rev["t"] = truth.t.copy()
    rev["trk"] = (truth.trk + 180) % 360
    rev["vs"] = -truth.vs[::-1]
    p = adsb.points(synthetic.record(rev, lv_frame, every=3))
    assert adsb.find_landings(p, lv_airport, lv_frame) == []


def test_an_arrival_whose_surface_positions_were_not_received_is_still_listed(synthetic, lv_frame, lv_airport):
    # coverage at Las Vegas typically ends 20 to 60 s before touchdown, often with no surface position at all
    end = lv_airport["ends"]["19L"]
    truth = synthetic.approach(end, final_m=12000, rollout_s=40)
    raw = synthetic.record(truth, lv_frame, every=3)
    t_td = truth["touchdown_t"]
    raw["trace"] = [pt for pt in raw["trace"] if pt[0] < t_td - 40]
    p = adsb.points(raw)
    landings = adsb.find_landings(p, lv_airport, lv_frame)
    assert len(landings) == 1
    got = landings[0]
    assert got["runway"] == "19L" and got["surface"] is False and got["goAround"] is False
    assert abs(got["t"] - (raw["timestamp"] + t_td)) < 10


def test_a_landing_with_surface_positions_says_so(synthetic, lv_frame, lv_airport):
    truth = synthetic.approach(lv_airport["ends"]["26L"], final_m=8000, rollout_s=40)
    p = adsb.points(synthetic.record(truth, lv_frame, every=3))
    assert adsb.find_landings(p, lv_airport, lv_frame)[0]["surface"] is True
