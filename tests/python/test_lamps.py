# T4.0 / plan 02 D5.3: lamp parsing, the type table, de-duplication, rule placement, cell sums.
import json

import numpy as np
import pytest

from lib import lamps as L
from conftest import ROOT


@pytest.mark.parametrize("text,watts", [
    ("100", 100), ("2X250", 500), ("2X801X100", 260), ("2X1501X400", 700), ("160/110", 160),
    ("72WLED", 72), ("IND 89 W", None), ("26L", None), ("", None), (None, None), ("43 W LED", 43),
])
def test_watts_of(text, watts):
    assert L.watts_of(text) == watts


@pytest.mark.parametrize("fixture,lamp,supp,expect", [
    ("160WLED", "LAMP2LED", "SLP", ("led_street", 160)),
    ("210 W LED", "LAMP2LED", "HIMAST", ("led_highmast", 210)),
    ("100WHPS", "100WHPS", "SLP", ("hps", 100)),
    ("IND 89 W", "IND 89 W", "SLP", ("induction", 89)),
    ("250WMHLD", "250WMHLD", "SP", ("metal_halide", 250)),
    ("126 LED", "LAMP2LED", "SLP", ("led_street", 126)),
    ("PRIVATE", "PRIVATE", "SLP", ("unknown", None)),
    (None, "LAMP2LED", "SLP", ("unknown", None)),
])
def test_county_type_table(fixture, lamp, supp, expect):
    assert L.county_type(fixture, lamp, supp) == expect


@pytest.mark.parametrize("args,expect", [
    (("HPS", "250"), ("hps", 250)), (("HPSCO", "2X150"), ("hps", 300)), (("LED", "80"), ("led_street", 80)),
    (("MHFL", "400"), ("metal_halide", 400)), (("FL", "1000"), ("metal_halide", 1000)),
    (("MVPAL", "175"), ("mercury_vapor", 175)), (("UNK", "100"), ("unknown", 100)), (("UP", "70"), ("unknown", 70)),
])
def test_city_of_las_vegas_type_table(args, expect):
    assert L.clv_type(*args) == expect


def test_other_type_tables():
    assert L.henderson_type("LED", 100) == ("led_street", 100)
    assert L.henderson_type("ANTHEM", 55) == ("led_street", 55)
    assert L.henderson_type("HPS", 250) == ("hps", 250)
    assert L.henderson_type("INDUCTION", 55) == ("induction", 55)
    assert L.boulder_type(" ", " ") == ("led_street", None)
    assert L.boulder_type("HPS", "100") == ("hps", 100)
    assert L.boulder_type("LED", "4") == ("led_street", None)
    assert L.osm_type({"lamp_type": "LED", "lamp_mount": "high_mast"}) == ("led_highmast", None)
    assert L.osm_type({"lamp_type": "high_pressure_sodium"})[0] == "hps"
    assert L.osm_type({})[0] == "unknown"


def test_lamp_types_file():
    ids = [t["id"] for t in L.TYPES["types"]]
    assert ids == list(range(len(ids)))
    assert all(t["class"] in L.CLASSES for t in L.TYPES["types"])
    assert all("status" in t for t in L.TYPES["types"])


def test_flux_from_type_and_wattage():
    # plan 02, 7.8: sodium 100 / 250 / 400 W -> about 9,500 / 27,500 / 50,000 lm; LED 90 lm/W
    assert L.lumens("hps", 100) == pytest.approx(9500, rel=1e-6)
    assert L.lumens("hps", 250) == pytest.approx(27500, rel=1e-6)
    assert L.lumens("hps", 400) == pytest.approx(50000, rel=1e-6)
    assert L.lumens("led_street", 105) == pytest.approx(9450)
    assert L.lumens("induction", 89) == pytest.approx(5963)
    assert L.lumens("led_street", None) == L.lumens("led_street", L.TYPE_BY_KEY["led_street"]["defaultWatts"])


def test_enclosed_county_fixtures():
    assert L.county_enclosed("UBL", "")
    assert L.county_enclosed("SLP", "L-2427 EB-S002 TYPE L1 DAY LUMINAIRE (SIGNIFY LUMEC TUNNELVIEW)")
    assert not L.county_enclosed("SLP", None)


def test_feet():
    assert L.feet("30FT") == pytest.approx(9.144)
    assert L.feet("NON_STANDARD") is None


def test_dedupe_across_sources_only():
    a = np.array([[0, 0], [100, 0], [100, 2]])  # two heads 2 m apart in one inventory: both kept
    b = np.array([[3, 0], [50, 0], [100, 4.9], [200, 0]])
    masks, drops = L.dedupe([("inv", a), ("osm", b)], 5.0)
    assert masks[0].tolist() == [True, True, True]
    assert masks[1].tolist() == [False, True, False, True]
    assert drops == {"inv": 0, "osm": 2}
    assert L.near_pairs_within(a, 5.0) == 1


def street_grid(n=5, block=200.0, length=1000.0, cls="local"):
    roads, k = [], 0
    for i in range(n):
        roads.append({"id": k, "xy": np.array([[0, i * block], [length, i * block]]), "cls": cls}); k += 1
        roads.append({"id": k, "xy": np.array([[i * block, 0], [i * block, length]]), "cls": cls}); k += 1
    return roads


def test_rule_on_a_fixture_street_grid():
    roads = street_grid()
    params = {"local": {"spacing": 40.0, "litFraction": 1.0, "offset": 7.0, "stagger": False}}
    xy, cls = L.place_rule(roads, [True] * len(roads), params, None, 25.0, "t")
    total_km = sum(np.hypot(*np.diff(r["xy"], axis=0).T).sum() for r in roads) / 1000
    # one lamp per 40 m of street, less the few merged where streets cross
    assert len(xy) == pytest.approx(total_km * 1000 / 40, rel=0.05)
    assert set(cls) == {"local"}
    assert L.median_nn(xy) == pytest.approx(40.0, rel=0.15)
    # repeatable
    xy2, _ = L.place_rule(roads, [True] * len(roads), params, None, 25.0, "t")
    assert np.array_equal(xy, xy2)


def test_rule_lit_fraction_lit_tags_and_avoidance():
    roads = street_grid(n=20, block=100.0, length=2000.0)
    params = {"local": {"spacing": 40.0, "litFraction": 0.5, "offset": 0.0, "stagger": False}}
    xy, _ = L.place_rule(roads, [True] * len(roads), params, None, 25.0, "t")
    full, _ = L.place_rule(roads, [True] * len(roads), {"local": {**params["local"], "litFraction": 1.0}}, None, 25.0, "t")
    assert 0.3 < len(xy) / len(full) < 0.7
    tagged = [dict(r, lit="no") for r in roads]
    assert len(L.place_rule(tagged, [True] * len(roads), params, None, 25.0, "t")[0]) == 0
    tagged = [dict(r, lit="yes") for r in roads]
    assert len(L.place_rule(tagged, [True] * len(roads), params, None, 25.0, "t")[0]) == len(full)
    # existing lamps along the first street suppress the rule there
    avoid = np.column_stack([np.arange(0, 2000, 10.0), np.zeros(200)])
    some, _ = L.place_rule(roads[:1], [True], {"local": {**params["local"], "litFraction": 1.0}}, avoid, 25.0, "t")
    assert len(some) == 0
    assert len(L.place_rule(roads, [False] * len(roads), params, None, 25.0, "t")[0]) == 0


def test_stagger_alternates_sides():
    p = L.points_along([[0, 0], [100, 0]], 20, 10, offset=5, stagger=True)
    assert p[:, 0].tolist() == [10, 30, 50, 70, 90]
    assert p[:, 1].tolist() == [-5, 5, -5, 5, -5]  # right of eastward travel is south


def test_urban_mask():
    grid = {"x0": 0, "y0": 0, "cell": 500, "nx": 10, "ny": 10}
    roads = street_grid(n=11, block=100.0, length=1000.0)  # a dense 1 km square in the corner
    pts, ridx, w = L.sample_roads(roads, 10.0)
    cls = np.array([roads[k]["cls"] for k in ridx])
    m = L.urban_mask(pts, w, cls, grid, 6.0)
    assert m[0, 0] and m[1, 1] and not m[9, 9]


def test_cell_sums_equal_the_lamps():
    rng = np.random.default_rng(1)
    grid = {"x0": -1000, "y0": -1000, "cell": 500, "nx": 4, "ny": 4}
    xy = rng.uniform(-1200, 1200, (500, 2))
    flux = rng.uniform(1000, 30000, 500)
    cls = rng.choice(L.CLASSES, 500)
    cells, outside = L.cell_sums(xy, flux, cls, grid)
    inside = (xy[:, 0] >= -1000) & (xy[:, 0] < 1000) & (xy[:, 1] >= -1000) & (xy[:, 1] < 1000)
    assert sum(c.sum() for c in cells.values()) == pytest.approx(flux[inside].sum(), rel=1e-12)
    assert outside == pytest.approx(flux[~inside].sum())
    for k in L.CLASSES:
        assert cells[k].sum() == pytest.approx(flux[inside & (cls == k)].sum())
    # row 0 is south, column 0 west
    one, _ = L.cell_sums(np.array([[-900.0, 900.0]]), np.array([5.0]), np.array(["led"]), grid)
    assert one["led"][3, 0] == 5.0


def test_lamp_record_layout():
    rec = L.encode_lamps(np.array([[1234.5678, -42.0]]), [9.14], [1], [L.FLAG_RULE | (3 << 1)], [12345.0], [float("nan")])
    assert L.LAMP_DTYPE.itemsize == 16
    assert rec["x_mm"][0] == 1234568 and rec["y_mm"][0] == -42000
    assert rec["mount_dm"][0] == 91 and rec["flux_10lm"][0] == 1234 and rec["aim_cdeg"][0] == L.AIM_UNKNOWN
    assert rec["flags"][0] & L.FLAG_RULE and rec["flags"][0] >> 1 == 3


# ---------------------------------------------------------------- the committed outputs
CITIES = [c for c in ("lv", "slc") if (ROOT / f"data/derived/{c}/lights_report.json").exists()]


@pytest.mark.parametrize("city", CITIES)
def test_committed_cells_equal_the_lamp_layer(city):
    meta = json.loads((ROOT / f"public/data/{city}/lamp-cells.json").read_text())
    planes = np.fromfile(ROOT / f"public/data/{city}/lamp-cells.bin", dtype="<f4").reshape(3, meta["ny"], meta["nx"])
    rec = np.fromfile(ROOT / f"data/derived/{city}/lamps.bin", dtype=L.LAMP_DTYPE)
    cls = np.array([L.TYPES["types"][t]["class"] for t in rec["type"]])
    grid = {"x0": meta["x0"], "y0": meta["y0"], "cell": meta["step"], "nx": meta["nx"], "ny": meta["ny"]}
    xy = np.column_stack([rec["x_mm"], rec["y_mm"]]) / 1000.0
    flux = rec["flux_10lm"].astype(float) * 10
    sky = (rec["flags"] & L.FLAG_ENCLOSED) == 0  # tunnel and under-bridge lamps are left out of the cells
    cells, _ = L.cell_sums(xy[sky], flux[sky], cls[sky], grid)
    assert meta["excluded"]["enclosedLamps"] == int((~sky).sum())
    for i, k in enumerate(meta["order"]):
        assert planes[i].sum(dtype=np.float64) == pytest.approx(cells[k].sum(), rel=1e-3)  # T4.0: within 0.1 %
        assert meta["totalsLm"][k] == pytest.approx(cells[k].sum(), rel=1e-3)
    report = json.loads((ROOT / f"data/derived/{city}/lights_report.json").read_text())
    assert report["lamps"] == len(rec)


def test_las_vegas_holdout_meets_the_acceptance():
    report = json.loads((ROOT / "data/derived/lv/lights_report.json").read_text())
    h = report["holdout"]
    assert abs(h["countRatio"] - 1) <= 0.20
    assert abs(h["spacingRatio"] - 1) <= 0.15
    for src in ("clark_county", "las_vegas", "henderson", "boulder_city"):
        for p in report["sources"][src]["provenance"]:
            assert p["url"].startswith("https://") and p["retrieved"]
