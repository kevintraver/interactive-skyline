"""The window-seat cabin (plan 03, F3.5 and F3.6): spec.py's cabin numbers, cabin.glb against them, and the app's copy.

- The window stations are the traced ones (research/dimensions.md): 46 on the right and 44 on the left, blanks at
  13.58 m (left) and 14.66 m (both), a window in each overwing exit at the exits' stations [B5].
- cabin.glb (models/aircraft/build_cabin.py): its window opening at the skin is the published one within 5 mm
  (F3.5's acceptance), centred at the spec's height; its bay fits the shortest pitch; its seat stands at the traced
  heights; it is inside 20,000 triangles and leaves the airframe its share of the 3.5 MB.
- src/flight/aircraft/dimensions.js carries exactly what spec.py says (models/aircraft/write_dimensions_js.py --check).
"""
import importlib.util
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
AIRCRAFT = ROOT / "models" / "aircraft"
PUBLIC = ROOT / "public" / "models" / "aircraft"
IN = 0.0254


@pytest.fixture(scope="module")
def spec():
    loader = importlib.util.spec_from_file_location("aircraft_spec_cabin", AIRCRAFT / "spec.py")
    module = importlib.util.module_from_spec(loader)
    sys.modules[loader.name] = module
    loader.loader.exec_module(module)
    return module


def read_glb(path):
    """(json, binary chunk) of a GLB."""
    data = path.read_bytes()
    n = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + n])
    off = 20 + n
    bn = struct.unpack_from("<I", data, off)[0]
    return doc, data[off + 8:off + 8 + bn]


def accessor(doc, binary, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    fmt = {5126: "f", 5123: "H", 5125: "I", 5121: "B"}[a["componentType"]]
    start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride") or size * struct.calcsize(fmt)
    out = []
    for i in range(a["count"]):
        out.append(struct.unpack_from(f"<{size}{fmt}", binary, start + i * stride))
    return out


@pytest.fixture(scope="module")
def glb():
    return read_glb(PUBLIC / "cabin.glb")


def node_points(doc, binary, name):
    node = next(n for n in doc["nodes"] if n.get("name") == name)
    pts = []
    for prim in doc["meshes"][node["mesh"]]["primitives"]:
        pts += accessor(doc, binary, prim["attributes"]["POSITION"])
    return pts


# ---------------------------------------------------------------------------------------------- the spec
def test_window_stations_are_the_traced_ones(spec):
    right, left = spec.WINDOWS["right"].value, spec.WINDOWS["left"].value
    assert len(right) == 46 and len(left) == 44
    assert spec.WINDOWS["blanks_right"].value == (14.656,)
    assert spec.WINDOWS["blanks_left"].value == (13.58, 14.656)
    for exit_station in spec.DOORS["overwing_exits"]["station"].value:
        assert min(abs(s - exit_station) for s in right) < 0.005
        assert min(abs(s - exit_station) for s in left) < 0.005
    for a, b in zip(right, right[1:]):
        p = (b - a) / IN
        assert 18.5 < p < 23.5 or 37 < p < 42.5, (a, b, p)   # a pitch, or two across a blank or the exits
    assert spec.WINDOWS["right"].source != spec.ESTIMATED and spec.WINDOWS["left"].source != spec.ESTIMATED


def test_cabin_section_is_published(spec):
    c = spec.CABIN
    assert c["trim_radius"].value * 2 == pytest.approx(3.54, abs=0.005)        # [B1] p. 2-30 trim to trim
    assert c["bin_lip_above_floor"].value == pytest.approx(1.58, abs=0.005)   # [B1] p. 2-30
    assert c["seat_width"].value == pytest.approx(17 * IN)
    assert c["triple_width"].value == pytest.approx(59 * IN)
    assert c["aisle"].value == pytest.approx(20 * IN)


# ---------------------------------------------------------------------------------------------- the model
def test_window_opening_at_the_skin_is_the_published_one(spec, glb):
    doc, binary = glb
    rs = spec.FUSELAGE["half_width"].value - 0.002
    axis = spec.FUSELAGE["top_z"].value - spec.FUSELAGE["half_width"].value
    skin = [p for p in node_points(doc, binary, "Bay") if abs(math.hypot(p[0], p[1] - axis) - rs) < 2e-4]
    assert len(skin) >= 40
    w, h = spec.WINDOWS["opening"].value
    zs = [p[2] for p in skin]
    angs = [math.atan2(p[1] - axis, p[0]) for p in skin]
    assert abs((max(zs) - min(zs)) - w) < 0.005
    assert abs(rs * (max(angs) - min(angs)) - h) < 0.005
    centre = axis + rs * math.sin((max(angs) + min(angs)) / 2)
    floor = spec.FUSELAGE["floor_z"].value
    assert abs(centre - floor - spec.WINDOWS["centre_above_floor"].value) < 0.005


def test_bay_fits_the_shortest_pitch(spec, glb):
    doc, binary = glb
    zs = [p[2] for p in node_points(doc, binary, "Bay")]
    half = spec.CABIN["panel_half_length"].value
    assert max(zs) == pytest.approx(half, abs=1e-4) and min(zs) == pytest.approx(-half, abs=1e-4)
    right = spec.WINDOWS["right"].value
    assert 2 * half <= min(b - a for a, b in zip(right, right[1:])) + 1e-9


def test_trim_and_seat_heights(spec, glb):
    doc, binary = glb
    axis = spec.FUSELAGE["top_z"].value - spec.FUSELAGE["half_width"].value
    floor = spec.FUSELAGE["floor_z"].value
    r = spec.CABIN["trim_radius"].value
    filler = node_points(doc, binary, "Filler")
    above = [p for p in filler if p[1] > floor + 0.31]
    assert all(abs(math.hypot(p[0], p[1] - axis) - r) < 1e-3 for p in above)   # the trim is the traced circle
    seat = node_points(doc, binary, "Seat")
    assert max(p[1] for p in seat) - floor == pytest.approx(spec.CABIN["back_top"].value, abs=0.01)
    arm = node_points(doc, binary, "Armrest")
    assert max(p[1] for p in arm) - floor == pytest.approx(spec.CABIN["armrest_top"].value, abs=0.005)


def test_budget_nodes_and_baked_attribute(spec, glb):
    doc, binary = glb
    names = {n.get("name") for n in doc["nodes"]}
    assert {"Bay", "Filler", "Shade", "PaneInner", "PaneMiddle", "PaneOuter", "Seat", "Armrest", "Bin"} <= names
    tris = 0
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            tris += doc["accessors"][prim["indices"]]["count"] // 3
            assert "_CABIN" in prim["attributes"], mesh["name"]
            vals = accessor(doc, binary, prim["attributes"]["_CABIN"])
            assert all(0.0 <= v <= 1.0 for row in vals for v in row)
    assert tris <= 20000                                      # section 6.5: the cabin segment
    size = (PUBLIC / "cabin.glb").stat().st_size + (PUBLIC / "cabin.json").stat().st_size
    assert size <= 3_500_000 - spec.BUDGET["glb_bytes"].value  # section 9.2: 3.5 MB for both, 2.5 MB the airframe's
    report = json.loads((AIRCRAFT / "cabin.report.json").read_text())
    assert report["errors"] == [] and report["tris"] == tris
    info = json.loads((PUBLIC / "cabin.json").read_text())
    assert info["triangles"] == tris
    assert info["shade"]["travel"] == pytest.approx(spec.CABIN["shade_travel"].value)
    assert math.hypot(*info["shade"]["axis"]) == pytest.approx(1.0, abs=1e-6)


# ---------------------------------------------------------------------------------------------- the app's copy
def test_dimensions_js_matches_spec():
    r = subprocess.run([sys.executable, str(AIRCRAFT / "write_dimensions_js.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_drift_is_caught(tmp_path, monkeypatch):
    """The check fails when the block differs from spec.py (a copy of the target with one number changed)."""
    loader = importlib.util.spec_from_file_location("write_dimensions_js_t", AIRCRAFT / "write_dimensions_js.py")
    mod = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(mod)
    src = mod.TARGET.read_text(encoding="utf-8")
    target = tmp_path / "dimensions.js"
    target.write_text(src.replace('"centreAboveFloor": 0.97', '"centreAboveFloor": 0.98'), encoding="utf-8")
    monkeypatch.setattr(mod, "TARGET", target)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    assert mod.main(["--check"]) == 1
    assert mod.main([]) == 0
    assert mod.main(["--check"]) == 0


# ---------------------------------------------------------------------------------------------- the cabin pass (25 Nov)
def test_bay_surround_is_smooth_and_moulded(spec, glb):
    """The window's surround (the bezel's cove, flat top and rolled lip, the reveal) is a ring of at least 64 samples,
    shaded smooth: no facets at the wide lens, a lip standing proud of the trim by the spec's relief."""
    doc, binary = glb
    axis = spec.FUSELAGE["top_z"].value - spec.FUSELAGE["half_width"].value
    r = spec.CABIN["trim_radius"].value
    relief = spec.CABIN["frame_relief"].value
    pts = node_points(doc, binary, "Bay")
    top = [p for p in pts if abs(math.hypot(p[0], p[1] - axis) - (r - relief)) < 2e-4]
    assert len(top) >= 2 * 64                       # the bezel's flat top: two rings of the surround's samples
    node = next(n for n in doc["nodes"] if n.get("name") == "Bay")
    for prim in doc["meshes"][node["mesh"]]["primitives"]:
        assert "NORMAL" in prim["attributes"]
    # smooth: on the bezel, corners at one position share one normal (no flat-shaded facets)
    bezel = next(p for p in doc["meshes"][node["mesh"]]["primitives"]
                 if doc["materials"][p["material"]]["name"] == "Bezel")
    pos = accessor(doc, binary, bezel["attributes"]["POSITION"])
    nor = accessor(doc, binary, bezel["attributes"]["NORMAL"])
    seen = {}
    for p, n in zip(pos, nor):
        seen.setdefault(tuple(round(c, 5) for c in p), set()).add(tuple(round(c, 2) for c in n))
    split = sum(1 for v in seen.values() if len(v) > 1)
    assert split <= 0.02 * len(seen)


def test_psu_and_seat_back_details(glb):
    """A passenger service unit for the rows (reading lights, gaspers, the signs' lit face with its no-smoking half
    marked in the baked attribute's a), and a seat back with its tray, latch and pocket."""
    doc, binary = glb
    names = {n.get("name") for n in doc["nodes"]}
    assert "Psu" in names
    mats = lambda node: {doc["materials"][p["material"]]["name"] for p in doc["meshes"][next(n for n in doc["nodes"] if n.get("name") == node)["mesh"]]["primitives"]}  # noqa: E731
    assert {"Psu", "Lens", "SignLit", "Grille"} <= mats("Psu")
    assert {"Fabric", "Shell", "Tray", "Grille"} <= mats("Seat")
    node = next(n for n in doc["nodes"] if n.get("name") == "Psu")
    lit = next(p for p in doc["meshes"][node["mesh"]]["primitives"] if doc["materials"][p["material"]]["name"] == "SignLit")
    halves = {round(v[3], 2) for v in accessor(doc, binary, lit["attributes"]["_CABIN"])}
    assert halves == {0.5, 1.0}


def test_shade_slides_round_its_track(spec):
    """cabin.json gives the shade's track as a circle about the fuselage axis (the app turns it, not slides it
    straight, so it never comes out in front of the trim), just behind the trim."""
    info = json.loads((PUBLIC / "cabin.json").read_text())
    r = spec.CABIN["trim_radius"].value
    assert r < info["shade"]["radius"] < r + 0.01
    assert "psu" in info and info["psu"]["to"] > info["psu"]["from"]
