import gzip
import json

import numpy as np

import build_stars as bs
from conftest import ROOT

# four rows of the catalogue as published: HR 92 (Tycho's nova, no position), Polaris, Betelgeuse, Sirius
ROWS = (ROOT / "tests/fixtures/bsc5-sample.dat").read_text(encoding="latin-1").splitlines()


def test_parse_reads_j2000_position_and_photometry():
    stars, dropped = bs.parse(ROWS)
    assert len(stars) == 3
    assert dropped == [92]
    s = stars[2]
    assert s["hr"] == 2491 and s["v"] == -1.46 and s["bv"] == 0.0
    assert abs(s["ra"] - (6 + 45 / 60 + 8.9 / 3600) * 15) < 1e-9
    assert abs(s["dec"] - -(16 + 42 / 60 + 58 / 3600)) < 1e-9
    assert s["mult"]


def test_ballesteros_temperature():
    assert abs(bs.ballesteros_kelvin(0.0) - 10115) < 20  # an A0 star
    assert abs(bs.ballesteros_kelvin(0.65) - 5800) < 100  # the Sun
    assert bs.ballesteros_kelvin(1.85) < 3800  # Betelgeuse


def test_black_body_colour_runs_from_red_to_blue():
    red, sun, blue = bs.kelvin_rgb(3000), bs.kelvin_rgb(5800), bs.kelvin_rgb(20000)
    assert red[0] == 1 and red[2] < 0.4
    assert blue[2] == 1 and blue[0] < 0.8
    assert np.allclose(sun, 1, atol=0.2)  # near white (slightly warm against D65)


def test_encode_layout_and_rounding():
    stars, _ = bs.parse(ROWS[3:])
    rec = np.frombuffer(bs.encode(stars), dtype=[("v", "<i2", 3), ("mag", "<i2"), ("rgb", "u1", 3), ("flags", "u1")])
    assert rec.itemsize == bs.RECORD == 12
    assert rec["mag"][0] == -1460
    v = rec["v"][0] / 32767
    assert abs(np.linalg.norm(v) - 1) < 1e-4
    assert rec["flags"][0] & bs.FLAGS["multiple"]


def test_committed_output_matches_its_sidecar():
    meta = json.loads((ROOT / "public/data/sky/stars.json").read_text())
    blob = (ROOT / "public/data/sky/stars.bin").read_bytes()
    assert len(blob) == meta["count"] * meta["recordBytes"]
    assert meta["count"] + meta["dropped"]["count"] == meta["source"]["records"] == 9110
