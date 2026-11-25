"""readsb trace_full parsing (plan 03, 8.2 test_trace_parse) and the archive's first filter."""
import gzip
import io
import json
import math

import numpy as np
import pytest

from lib import adsb


def _trace(synth, lv_frame, airport_end, **kw):
    tr = synth.approach(airport_end, final_m=6000, rollout_s=30)
    return synth.record(tr, lv_frame, **kw)


@pytest.fixture
def end19r(lv_airport):
    return lv_airport["ends"]["19R"]


def test_the_fourteen_element_layout_is_read(synthetic, lv_frame, end19r):
    raw = _trace(synthetic, lv_frame, end19r)
    p = adsb.points(raw)
    n = len(raw["trace"])
    assert len(p) == n
    first = raw["trace"][0]
    assert p.t[0] == pytest.approx(raw["timestamp"] + first[0])
    assert p.lat[0] == first[1] and p.lon[0] == first[2]
    assert p.alt_baro_ft[0] == first[3]
    assert p.gs_kt[0] == first[4] and p.track[0] == first[5]
    assert p.flags[0] == first[6] and p.vrate_fpm[0] == first[7]
    assert p.src[0] == "adsb_icao"
    assert p.alt_geom_ft[0] == first[10]
    assert math.isnan(p.ias_kt[0]) and math.isnan(p.roll[0])


def test_ground_altitudes_become_a_flag_and_no_number(synthetic, lv_frame, end19r):
    p = adsb.points(_trace(synthetic, lv_frame, end19r))
    assert p.ground.any() and (~p.ground).any()
    assert np.isnan(p.alt_baro_ft[p.ground]).all()
    # once on the ground it stays there in this trace: one transition
    assert np.count_nonzero(np.diff(p.ground.astype(int)) != 0) == 1


def test_files_with_and_without_a_state_object(synthetic, lv_frame, end19r):
    with_state = adsb.points(_trace(synthetic, lv_frame, end19r, state_every=4))
    without = adsb.points(_trace(synthetic, lv_frame, end19r, include_state=False))
    assert with_state.has_state.sum() > 0
    assert without.has_state.sum() == 0
    assert np.allclose(with_state.lat, without.lat)


def test_pre_2022_nine_element_points_are_read(synthetic, lv_frame, end19r):
    raw = _trace(synthetic, lv_frame, end19r)
    for pt in raw["trace"]:
        del pt[9:]
    p = adsb.points(raw)
    assert (p.src == "").all()
    assert np.isnan(p.alt_geom_ft).all()


def test_flags_are_decoded(synthetic, lv_frame, end19r):
    raw = _trace(synthetic, lv_frame, end19r)
    raw["trace"][3][6] = 1 | 8
    p = adsb.points(raw)
    assert p.stale[3] and p.alt_is_geom[3]
    assert not p.stale[4]
    assert p.new_leg[0]


def test_a_flight_split_across_two_utc_days_is_stitched(synthetic, lv_frame, end19r):
    raw = _trace(synthetic, lv_frame, end19r)
    whole = adsb.points(raw)
    cut = len(raw["trace"]) // 2
    t_cut = raw["timestamp"] + raw["trace"][cut][0]
    day1 = dict(raw, trace=raw["trace"][:cut + 1])          # the archive repeats the boundary point
    day2 = dict(raw, timestamp=t_cut, trace=[[pt[0] - raw["trace"][cut][0]] + pt[1:] for pt in raw["trace"][cut:]])
    stitched = adsb.stitch(adsb.points(day2), adsb.points(day1))
    assert len(stitched) == len(whole)
    assert np.allclose(stitched.t, whole.t)
    assert np.allclose(stitched.lat, whole.lat)


def test_peek_reads_the_type_without_decompressing_the_whole_file(synthetic, lv_frame, end19r):
    blob = synthetic.gz(_trace(synthetic, lv_frame, end19r, type_code="B38M", icao="abc123"))
    head = adsb.peek_header(blob)
    assert head["t"] == "B38M" and head["icao"] == "abc123"
    assert adsb.peek_header(gzip.compress(b'{"icao":"000001","timestamp":1,"trace":[]}'))["t"] is None


def test_the_first_filter_keeps_a_listed_type_near_the_airport(synthetic, lv_frame, end19r):
    ref = adsb.Near(lat=36.084, lon=-115.1537, radius_m=15000)
    near = synthetic.gz(_trace(synthetic, lv_frame, end19r))
    assert adsb.first_filter(near, {"B738"}, ref)
    assert not adsb.first_filter(near, {"A320"}, ref)
    far_ref = adsb.Near(lat=40.0, lon=-111.9, radius_m=15000)
    assert not adsb.first_filter(near, {"B738"}, far_ref)


def test_trace_members_are_streamed_from_a_tar_split_in_parts(synthetic, lv_frame, end19r):
    a = synthetic.gz(_trace(synthetic, lv_frame, end19r, icao="a00001"))
    b = synthetic.gz(_trace(synthetic, lv_frame, end19r, icao="a00002", type_code="A320"))
    tar = synthetic.tar_bytes({"./traces/01/trace_full_a00001.json": a, "./acas/x.json": b"{}",
                               "./traces/02/trace_full_a00002.json": b})
    cut = len(tar) // 3
    parts = [tar[:cut], tar[cut:]]
    stream = adsb.ChainedStream([lambda off, p=p: io.BytesIO(p[off:]) for p in parts], [len(p) for p in parts])
    got = list(adsb.iter_trace_members(stream))
    assert [name for name, _ in got] == ["a00001", "a00002"]
    assert got[0][1] == a
    assert stream.position == len(tar)


def test_a_dropped_connection_resumes_at_the_same_byte():
    data = bytes(range(256)) * 400
    calls = []

    class Flaky(io.BytesIO):
        def __init__(self, buf, fail_after):
            super().__init__(buf)
            self.fail_after, self.served = fail_after, 0

        def read(self, n=-1):
            if self.served >= self.fail_after:
                raise ConnectionError("reset")
            out = super().read(min(n, 1000) if n and n > 0 else 1000)
            self.served += len(out)
            return out

    def opener(off):
        calls.append(off)
        return Flaky(data[off:], 30000 if len(calls) == 1 else 10**9)

    s = adsb.ChainedStream([opener], [len(data)], retries=3, wait_s=0)
    got = b"".join(iter(lambda: s.read(4096), b""))
    assert got == data
    assert calls[0] == 0 and calls[1] > 0
