"""Independent evidence for the touchdown time (plan 03, the validation's open finding of 25 November): the geometric
height's last 25 ft step before the runway, carried down by a flare, and the onset of braking in the raw positions.
Each is tested on synthetic data with a known touchdown; the committed QA files carry the result per flight."""
import json
from pathlib import Path

import numpy as np
import pytest

from lib import flight_touchdown as TD

ROOT = Path(__file__).resolve().parents[3]
FT = 0.3048


def _landing(td=0.0, ground_antenna=640.0, sink=4.0, flare_from=8.0, flare_s=3.5, every=0.5, jitter=0.0, seed=1):
    """Antenna height of a landing (steady descent, a flare from `flare_from` m over `flare_s` s onto the runway at
    `td`, then level) reported in 25 ft steps every `every` s."""
    rng = np.random.default_rng(seed)
    t = np.arange(-40.0, 20.0, every) + rng.normal(0, jitter, int(60 / every))
    t.sort()
    tf = td - flare_s
    above = np.where(t < tf, flare_from + sink * (tf - t),
                     np.where(t < td, flare_from * np.clip((td - t) / flare_s, 0, None) ** 1.6, 0.0))
    true = ground_antenna + above
    reported_ft = np.round(true / FT / 25) * 25
    return t, reported_ft, true


def test_the_geometric_estimate_finds_a_known_touchdown_within_a_second():
    for td, flare_from in ((0.0, 8.0), (2.0, 9.0), (-1.5, 7.0)):
        t, alt_ft, _ = _landing(td=td, flare_from=flare_from)
        est = TD.geometric_touchdown(t, alt_ft * FT, ground=np.full(len(t), 640.0), t_ref=0.0)
        assert est is not None
        assert est["t"] == pytest.approx(td, abs=1.0), (td, est)
        assert 0 < est["crossingHeightM"] <= TD.GEOMETRIC_MAX_CROSSING_M


def test_the_braking_onset_is_found_in_positions_alone():
    rng = np.random.default_rng(3)
    t = np.sort(rng.uniform(-25, 25, 90))
    tc, v0, a = 2.5, 72.0, 2.2
    s = v0 * t - 0.5 * a * np.maximum(t - tc, 0) ** 2 + rng.normal(0, 4.0, len(t))
    est = TD.braking_onset(t, s, t_ref=0.0)
    assert est["t"] == pytest.approx(tc, abs=0.7)
    assert est["decelAfterMs2"] == pytest.approx(a, abs=0.3)
    assert abs(est["decelBeforeMs2"]) < 0.3


def test_every_qa_file_states_how_the_touchdown_time_was_found():
    sel = json.loads((ROOT / "data" / "flights" / "lv" / "selection.json").read_text())["flights"]
    for f in sel:
        qa = json.loads((ROOT / "data" / "flights" / "lv" / "qa" / f"{f['id']}.json").read_text())
        tt = qa["touchdownTime"]
        assert tt["method"] and tt["sigmaS"] > 0
        alt = tt["alternatives"]
        assert set(alt) >= {"geometricHeight", "brakingOnset", "surfaceFlag", "geometricRate"}
        # braking begins at or after the wheels touch: the onset is never more than the uncertainty before it
        if alt["brakingOnset"] is not None:
            assert alt["brakingOnset"]["offsetS"] >= -2 * tt["sigmaS"], f["id"]
        # the served header's QA summary says the same
        head = json.loads((ROOT / "public" / "data" / "lv" / "flights" / f"{f['id']}.json").read_text())
        assert head["qa"]["touchdownTime"] == tt
