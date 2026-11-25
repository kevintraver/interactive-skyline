"""The airframe's dimensions (plan 03, F3.1): models/aircraft/spec.py.

The rule under test: no number in the spec without a source line or an ESTIMATED tag. Every number the module
exposes sits inside a `Dim`, and every `Dim` names a source from the spec's own SOURCES table (with a note that
quotes or explains what was used) or is tagged ESTIMATED (with a note giving the basis). Then the three figures
the airframe is checked against (length, span, tail height) must be the manufacturer's published ones.
"""
import importlib.util
import math
import numbers
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC_PATH = ROOT / "models" / "aircraft" / "spec.py"


@pytest.fixture(scope="module")
def spec():
    loader = importlib.util.spec_from_file_location("aircraft_spec", SPEC_PATH)
    module = importlib.util.module_from_spec(loader)
    sys.modules[loader.name] = module  # dataclasses look their module up while the class is defined
    loader.loader.exec_module(module)
    return module


def public_data(spec):
    """(name, value) for every module-level name in capitals: the spec's data, not its helpers."""
    return [(name, getattr(spec, name)) for name in dir(spec) if name.isupper() and not name.startswith("_")]


def walk(value, path):
    """Yield (path, Dim or bare number) for everything below `value`; Dims are leaves."""
    from_dim = getattr(value, "_is_dim", False)
    if from_dim:
        yield path, value
    elif isinstance(value, bool):
        return
    elif isinstance(value, numbers.Number):
        yield path, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from walk(v, f"{path}.{k}")
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            yield from walk(v, f"{path}[{i}]")


def numbers_in(value):
    if isinstance(value, bool):
        return []
    if isinstance(value, numbers.Number):
        return [value]
    if isinstance(value, dict):
        return [n for v in value.values() for n in numbers_in(v)]
    if isinstance(value, (list, tuple)):
        return [n for v in value for n in numbers_in(v)]
    return []


def test_every_number_sits_in_a_dim(spec):
    bare = [path for name, value in public_data(spec) if name != "SOURCES"
            for path, leaf in walk(value, name) if not getattr(leaf, "_is_dim", False)]
    assert bare == [], f"numbers without a source line or ESTIMATED tag: {bare[:20]}"


def test_every_dim_has_a_known_source_or_is_estimated(spec):
    known = set(spec.SOURCES)
    dims = [(path, d) for name, value in public_data(spec) if name != "SOURCES"
            for path, d in walk(value, name)]
    assert len(dims) > 100, "the spec should cover the whole airframe"
    for path, d in dims:
        assert numbers_in(d.value), f"{path}: a Dim must hold a number or a table of numbers"
        assert d.note and len(d.note.strip()) >= 12, f"{path}: needs a note that quotes or explains its source"
        if d.source == spec.ESTIMATED:
            continue
        keys = re.findall(r"B\d+|CFR", d.source)
        assert keys, f"{path}: source {d.source!r} names no reference and is not ESTIMATED"
        assert set(keys) <= known, f"{path}: source {d.source!r} names a reference not in SOURCES"


def test_sources_are_described(spec):
    for key, text in spec.SOURCES.items():
        assert re.fullmatch(r"B\d+|CFR", key)
        assert "http" in text, f"{key} needs its URL"


@pytest.mark.parametrize("name,published", [
    ("LENGTH_OVERALL", 39.47),     # [B1] p. 2-14: 129 FT 6 IN (39.47 M)
    ("SPAN_WINGLETS", 35.79),      # [B1] p. 2-14: 117 FT 5 IN (35.79 M)
    ("TAIL_HEIGHT", 12.55),        # [B1] p. 2-14: 41 FT 2 IN (12.55 M)
])
def test_headline_figures_are_the_published_ones(spec, name, published):
    d = getattr(spec, name)
    assert d.source.startswith("B1")
    assert math.isclose(d.value, published, abs_tol=1e-9)


def test_the_wing_planform_reproduces_the_published_stations(spec):
    """The traced planform agrees with the figures printed on the same drawings."""
    root = spec.wing_le(spec.FUSELAGE["half_width"].value)
    assert abs(root - 15.0) < 0.15                                  # [B1] scaled: LE at the body about 15.0 m
    assert abs(spec.wing_te(spec.FUSELAGE["half_width"].value) - 21.4) < 0.15
    bare_tip = spec.SPAN_BARE.value / 2
    assert abs(spec.wing_le(bare_tip) - 23.47) < 0.1                # [B1] p. 2-13: tip LE 23.47 m
    chord_mac = spec.WING["mac"].value
    assert 3.5 < chord_mac < 4.5


def test_stations_follow_the_doors(spec):
    st = spec.STATIONS
    assert st["main_gear"].value == pytest.approx(spec.GEAR["nose_station"].value + spec.GEAR["wheelbase"].value)
    assert spec.body_station_to_x(975) == pytest.approx(spec.DOORS["aft_entry_left"]["station"].value, abs=0.02)
    assert spec.body_station_to_x(328) == pytest.approx(spec.DOORS["fwd_entry_left"]["station"].value, abs=0.05)


def test_windows(spec):
    left, right = spec.WINDOWS["left"].value, spec.WINDOWS["right"].value
    assert len(left) == 44 and len(right) == 46                     # the counts of section 7.4
    assert all(b > a for a, b in zip(left, left[1:]))
    blanks = spec.WINDOWS["blanks_left"].value
    assert any(abs(b - 13.6) < 0.3 for b in blanks) and any(abs(b - 14.7) < 0.3 for b in blanks)
    w, h = spec.WINDOWS["opening"].value
    assert w == pytest.approx(10.5 * 0.0254) and h == pytest.approx(14.375 * 0.0254)


def test_flap_detents(spec):
    detents = spec.FLAPS["detents"].value
    assert [d for d, *_ in detents] == [0, 1, 2, 5, 10, 15, 25, 30, 40]
    # surface angles grow with the lever, travel never shrinks
    assert all(b[1] + b[3] >= a[1] + a[3] for a, b in zip(detents, detents[1:]))
    assert all(b[2] >= a[2] for a, b in zip(detents, detents[1:]))
    assert len(spec.SPOILERS["panels"].value) == 6
    assert len(spec.SLATS["panels"].value) == 4 and len(spec.KRUEGERS["panels"].value) == 2


def test_lights(spec):
    names = set(spec.LIGHTS)
    assert {"nav_left", "nav_right", "nav_aft_left", "nav_aft_right", "beacon_top", "beacon_bottom", "strobe_left",
            "strobe_right", "strobe_tail", "landing_left", "landing_right", "taxi", "logo_left", "logo_right",
            "wing_left", "wing_right", "turnoff_left", "turnoff_right"} <= names
    for name, d in spec.LIGHTS.items():
        assert d.value["channel"] in spec.LIGHT_CHANNELS, name
