# T4.4 data half: build_nightlights.py against small synthetic VNP46A4 tiles written with the product's layout
# (HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/..., fill value -999.9, quality 0 good / 1 poor / 2 gap-filled /
# 255 fill). Real tiles are 2400 x 2400; these are 600 x 600, which the script handles the same way.
import json

import h5py
import numpy as np
import pytest

import build_nightlights as bn
from conftest import ROOT

N = 600  # cells per 10 degree tile here
STRIP = (36.1147, -115.1728)
DOWNTOWN = (36.1707, -115.1430)


def cell(lat, lon, h=6, v=5):
    deg = 10 / N
    return int((90 - 10 * v - lat) / deg), int((lon - (-180 + 10 * h)) / deg)


def write_tile(path, near, off, allang, qnear=None):
    with h5py.File(path, "w") as f:
        g = f.create_group("HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields")
        for name, a, q in ((bn.LAYERS[0], near, qnear), (bn.LAYERS[1], off, None), (bn.LAYERS[2], allang, None)):
            d = g.create_dataset(name, data=a.astype(np.float32))
            d.attrs["_FillValue"] = np.float32(bn.FILL)
            d.attrs["units"] = "nW_cm-2_sr-1"
            qq = np.where(np.isclose(a, bn.FILL), 255, 0) if q is None else q
            g.create_dataset(name + "_Quality", data=qq.astype(np.uint8))
            g.create_dataset(name + "_Num", data=np.full(a.shape, 30, np.uint16))
            g.create_dataset(name + "_Std", data=np.zeros(a.shape, np.float32))


def scene(year_gain=1.0):
    near = np.zeros((N, N))
    r, c = cell(*STRIP)
    near[r - 1:r + 2, c - 1:c + 2] = 800 * year_gain  # about 3 x 3 km of very bright Strip
    r2, c2 = cell(*DOWNTOWN)
    near[r2, c2] = 200 * year_gain
    near[:5, :5] = bn.FILL  # a filled corner far away
    return near


@pytest.fixture(scope="module")
def tiles(tmp_path_factory):
    d = tmp_path_factory.mktemp("vnp46a4")
    for year, gain in ((2023, 1.0), (2024, 1.1), (2025, 5.0)):  # 2025 an outlier the median must ignore
        near = scene(gain)
        off = np.where(np.isclose(near, bn.FILL), bn.FILL, near * 2.0)
        allang = np.where(np.isclose(near, bn.FILL), bn.FILL, near * 1.0)
        q = np.where(np.isclose(near, bn.FILL), 255, 0).astype(np.uint8)
        write_tile(d / f"VNP46A4.A{year}001.h06v05.002.2026076173759.h5", near, off, allang, q)
    # a tile whose near-nadir is poor at the Strip: the all-angle value must be used there
    near = scene()
    r, c = cell(*STRIP)
    q = np.zeros((N, N), np.uint8)
    q[r, c] = 1
    allang = near.copy()
    allang[r, c] = 333.0
    write_tile(d / "fallback.h5", near, near, allang, q)
    return d


def test_tiles_for_each_city():
    assert bn.tile_of(36.11, -115.17) == (6, 5)
    assert bn.tile_of(40.77, -111.89) == (6, 4)
    assert bn.tiles_for(32.3, -119.8, 39.9, -110.5) == [(6, 5)]  # Las Vegas, +/- 420 km
    assert sorted(bn.tiles_for(37.0, -116.9, 44.6, -106.9)) == [(6, 4), (6, 5), (7, 4), (7, 5)]  # Salt Lake City


def test_find_tile_by_year_and_name(tiles):
    assert bn.find_tile(2024, 6, 5, [tiles]).name.startswith("VNP46A4.A2024001.h06v05.002.")
    assert bn.find_tile(2022, 6, 5, [tiles]) is None


def test_read_tile_fill_and_fallback(tiles):
    r, r40, fb = bn.read_tile(tiles / "fallback.h5")
    rr, cc = cell(*STRIP)
    assert r[rr, cc] == pytest.approx(333.0)  # near-nadir poor -> all-angle
    assert r[rr, cc + 1] == pytest.approx(800.0)
    assert fb >= 1
    r, r40, _ = bn.read_tile(next(tiles.glob("*A2023001*")))
    assert np.isnan(r[0, 0]) and np.isnan(r40[0, 0])  # filled stays missing


def test_encoding_round_trip():
    r = np.array([0, 0.5, 1.0, 12.3, 456.7, 6553.5, 50000.0])
    back = bn.decode_radiance(bn.encode_radiance(r))
    assert np.all(np.abs(np.sqrt(back) - np.sqrt(r)) <= 0.5 / 256 + 1e-12)
    assert bn.encode_radiance(np.array([1e9]))[0] == 65535
    q = bn.encode_ratio(np.array([100.0, 100.0, 0.1, 10.0]), np.array([200.0, 1000.0, 5.0, 0.0]))
    assert q.tolist() == [128, 255, 64, 0]  # ratio 2, clipped at 4 (255 = 3.98), neutral below the floor, 0


@pytest.fixture(scope="module")
def built(tiles, tmp_path_factory):
    cities = json.loads((ROOT / "data/cities.json").read_text())
    cities["lv"]["nightlights"]["region"] = {"x0": -60000, "y0": -60000, "x1": 60000, "y1": 60000, "cell": 2000}
    p = tmp_path_factory.mktemp("cfg") / "cities.json"
    p.write_text(json.dumps(cities))
    return bn.build("lv", [tiles], years=[2023, 2024, 2025], write=False, cities_path=p)


def test_build_orients_the_grid_and_takes_the_median(built):
    result, planes, meta = built
    g = result["grids"]["metro"]
    r = planes["metro"][0]
    assert r.shape == (g["ny"], g["nx"]) == (230, 220)
    rows, cols = np.nonzero(r > 400)
    wt = r[rows, cols]
    x = g["x0"] + ((cols + 0.5) * wt).sum() / wt.sum() * g["step"]
    y = g["y0"] + ((rows + 0.5) * wt).sum() / wt.sum() * g["step"]
    # the Strip is at the origin (the synthetic block is centred on its source cell, within 1 km of it); row 0 is south
    assert abs(x) < 1200 and abs(y) < 1200
    assert r.max() == pytest.approx(880, rel=0.02)  # median of 800, 880, 4000
    # downtown, 2.7 km east and 6.2 km north of the origin, is lit; its mirror to the south is not
    c, rr = int((2681 - g["x0"]) // 500), int((6214 - g["y0"]) // 500)
    rs = int((-6214 - g["y0"]) // 500)
    assert r[rr - 3:rr + 4, c - 3:c + 4].max() > 50
    assert r[rs - 1:rs + 2, c - 1:c + 2].max() == 0
    assert r[5, 5] == 0  # open desert at the south-west corner


def test_build_keeps_the_total_and_writes_the_ratio(built):
    result, planes, meta = built
    r, r40 = planes["metro"]
    # area-weighted resampling keeps the integral of radiance (source cells are 1 arc minute here)
    lat = np.radians(STRIP[0])
    src_cell_m2 = (10 / N * 111320 * np.cos(lat)) * (10 / N * 110950)
    src_total = (9 * 880 + 220) * src_cell_m2  # Strip block and downtown, medians
    assert (r.sum() * 500 * 500) == pytest.approx(src_total, rel=0.05)
    lit = r > 1
    assert np.allclose(r40[lit] / r[lit], 2.0, rtol=1e-6)
    assert np.all(bn.encode_ratio(r, r40)[lit] == 128)
    assert meta["years"] == [2023, 2024, 2025] and meta["tiles"] == ["h06v05"]
    assert meta["source"]["doi"] == "10.5067/VIIRS/VNP46A4.002"
    assert meta["calibration"]["G"] == 0.15


def test_the_token_is_only_read_where_a_tile_is_downloaded():
    src = (ROOT / "scripts/build_nightlights.py").read_text()
    assert src.count('os.environ.get("EARTHDATA_TOKEN")') == 1
    assert "print(token" not in src and "write(token" not in src
