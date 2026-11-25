"""Hand corrections of corridor heights (scripts/lib/corridor_overrides.py, data/corridor_overrides.json)."""
import json
import math
from pathlib import Path

import pytest
from shapely.geometry import Polygon, box

from lib import corridor_overrides as co

ROOT = Path(__file__).resolve().parents[2]
LAT0, LON0 = 36.0, -115.0
M_LAT, M_LON = 111320.0, 111320.0 * math.cos(math.radians(LAT0))


def to_local(lat, lon):
    """A flat frame for the tests: metres east and north of (LAT0, LON0)."""
    return [(b - LON0) * M_LON for b in lon], [(a - LAT0) * M_LAT for a in lat]


def ll(x, y):
    return [LAT0 + y / M_LAT, LON0 + x / M_LON]


OUTLINE = box(0, 0, 200, 100)  # a 200 x 100 m resort outline, local metres


def load(entries):
    return co.load({"buildings": entries}, to_local)


def test_whole_outline_takes_the_height():
    [o] = load([{"osm": "w1", "height": 60, "source": "estimated"}])
    assert co.find([o], "w1", OUTLINE) is o
    assert co.find([o], "w2", OUTLINE) is None
    assert co.apply(o, "w1", OUTLINE, 12.0, 3, 0) == [("w1", OUTLINE, 60.0, 0)]


def test_point_matches_the_outline_it_falls_in_and_an_id_wins():
    a, b = load([{"point": ll(50, 50), "height": 30, "source": "s"}, {"osm": "w9", "height": 40, "source": "s"}])
    assert co.find([a, b], "w5", OUTLINE) is a
    assert co.find([a, b], "w5", box(500, 500, 600, 600)) is None
    assert co.find([a, b], "w9", OUTLINE) is b


def test_tower_polygon_splits_podium_and_tower():
    sq = [ll(150, 20), ll(190, 20), ll(190, 80), ll(150, 80)]
    [o] = load([{"osm": "w1", "height": 119, "source": "x", "tower": {"polygon": sq}, "podium": 14}])
    parts = co.apply(o, "w1", OUTLINE, 12.0, 3, 0)
    ids = [p[0] for p in parts]
    assert ids == ["w1", "w1:tower"]
    podium, tower = parts
    assert tower[2] == 119 and tower[3] == 0
    assert tower[1].area == pytest.approx(40 * 60, rel=1e-6)
    assert podium[2] == 14 and podium[3] == 0
    assert podium[1].area + tower[1].area == pytest.approx(OUTLINE.area, rel=1e-6)
    assert podium[1].intersection(tower[1]).area < 1e-6  # nothing is drawn twice


def test_tower_is_clipped_to_the_outline_and_podium_keeps_the_ladder_height():
    sq = [ll(180, 50), ll(260, 50), ll(260, 150), ll(180, 150)]  # half outside the outline
    [o] = load([{"osm": "w1", "height": 50, "source": "x", "tower": {"polygon": sq}}])
    podium, tower = co.apply(o, "w1", OUTLINE, 12.0, 3, 0)
    assert tower[1].area == pytest.approx(20 * 50, rel=1e-6)
    assert podium[2] == 12.0 and podium[3] == 3  # no 'podium': the ladder's height and rung


def test_tower_fraction_about_a_point():
    [o] = load([{"osm": "w1", "height": 45, "source": "x", "tower": {"fraction": 0.25, "at": ll(100, 50)}}])
    podium, tower = co.apply(o, "w1", OUTLINE, 10.0, 3, 0)
    assert tower[1].area == pytest.approx(0.25 * OUTLINE.area, rel=1e-6)
    assert tower[1].centroid.distance(OUTLINE.centroid) < 1e-6
    assert len(podium[1].interiors) == 1  # the podium rings the tower


def test_a_tower_that_cuts_the_outline_in_two_keeps_both_podium_pieces():
    band = [ll(90, -10), ll(110, -10), ll(110, 110), ll(90, 110)]
    [o] = load([{"osm": "w1", "height": 45, "source": "x", "tower": {"polygon": band}}])
    parts = co.apply(o, "w1", OUTLINE, 10.0, 3, 0)
    assert [p[0] for p in parts] == ["w1", "w1:2", "w1:tower"]
    assert sum(p[1].area for p in parts) == pytest.approx(OUTLINE.area, rel=1e-6)


def test_podium_never_rises_above_the_tower():
    sq = [ll(150, 20), ll(190, 20), ll(190, 80), ll(150, 80)]
    [o] = load([{"osm": "w1", "height": 20, "source": "x", "tower": {"polygon": sq}, "podium": 30}])
    podium, _ = co.apply(o, "w1", OUTLINE, 10.0, 3, 0)
    assert podium[2] == 20


def test_a_tower_missing_its_outline_is_an_error():
    far = [ll(500, 500), ll(520, 500), ll(520, 520), ll(500, 520)]
    [o] = load([{"osm": "w1", "height": 45, "source": "x", "tower": {"polygon": far}}])
    with pytest.raises(co.OverrideError):
        co.apply(o, "w1", OUTLINE, 10.0, 3, 0)


@pytest.mark.parametrize("entry", [
    {"height": 10, "source": "s"},  # neither id nor point
    {"osm": "w1", "point": [36, -115], "height": 10, "source": "s"},  # both
    {"osm": "w1", "height": -3, "source": "s"},
    {"osm": "w1", "height": 10},  # no source
    {"osm": "w1", "height": 10, "source": "s", "tower": {"fraction": 1.5}},
    {"osm": "w1", "height": 10, "source": "s", "tower": {}},
])
def test_bad_entries_are_refused(entry):
    with pytest.raises(co.OverrideError):
        load([entry])


def test_the_committed_file_loads_and_names_no_brand_outside_osm_notes():
    doc = json.loads((ROOT / "data" / "corridor_overrides.json").read_text())
    fixes = co.load(doc, to_local)
    assert len(fixes) >= 8
    for e in doc["buildings"]:
        assert e["source"]
        assert 0 < e["height"] < 200
        if "tower" in e and "polygon" in e["tower"]:
            assert Polygon([(b, a) for a, b in e["tower"]["polygon"]]).is_valid
