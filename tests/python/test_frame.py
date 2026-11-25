import json
from pathlib import Path

import numpy as np
import pytest
from pyproj import Transformer

from lib.frame import EARTH_R, create_frame, curve_drop, local_up

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "frame.json").read_text())
POINTS = FIXTURE["points"]
FRAME = create_frame({"origin": FIXTURE["origin"], "base": FIXTURE["base"]})
LAT = np.array([p["lat"] for p in POINTS])
LON = np.array([p["lon"] for p in POINTS])
X = np.array([p["x"] for p in POINTS])
Y = np.array([p["y"] for p in POINTS])
TOL = np.where(np.array([p["dist"] for p in POINTS]) <= 80_000, 0.001, 0.1)


def test_fixture_reaches_400_km_and_names_the_routes():
    assert len(POINTS) >= 24
    assert max(p["dist"] for p in POINTS) >= 399_000
    names = {p["name"] for p in POINTS}
    assert {"Primm", "Jean", "Apex", "Hoover Dam", "Mount Whitney"} <= names


def test_to_local_matches_pyproj():
    x, y = FRAME.to_local(LAT, LON)
    assert np.all(np.hypot(x - X, y - Y) < TOL)


def test_to_geodetic_matches_pyproj():
    lat, lon = FRAME.to_geodetic(X, Y)
    err = np.hypot((lat - LAT) * 111_320, (lon - LON) * 111_320 * np.cos(np.radians(LAT)))
    assert np.all(err < TOL)


def test_fixture_matches_the_proj_string_today():
    # guards the fixture itself: regenerate it if pyproj or the projection changes
    to_xy = Transformer.from_crs("EPSG:4326", FIXTURE["projection"], always_xy=True)
    x, y = to_xy.transform(LON, LAT)
    assert np.all(np.hypot(x - X, y - Y) < 1e-6)


def test_scalars_and_origin():
    x, y = FRAME.to_local(FIXTURE["origin"]["lat"], FIXTURE["origin"]["lon"])
    assert abs(float(x)) < 1e-9 and abs(float(y)) < 1e-9
    assert FRAME.base == 620
    assert FRAME.scene_y(1000, 3000, -4000) == 1000 - 620 - curve_drop(3000, -4000)


def test_local_up_leans_046_degrees_at_primm():
    p = next(q for q in POINTS if q["name"] == "Primm")
    up = local_up(p["x"], -p["y"])
    assert np.degrees(np.arccos(up[1])) == pytest.approx(0.46, abs=0.01)
    assert np.linalg.norm(up) == pytest.approx(1)


def test_curve_drop_is_main_js_expression():
    assert EARTH_R == 6371000 * (7 / 6)
    rng = np.random.default_rng(0)
    x, z = rng.uniform(-2e5, 2e5, (2, 1000))
    assert np.array_equal(curve_drop(x, z), (x * x + z * z) / (2 * EARTH_R))
