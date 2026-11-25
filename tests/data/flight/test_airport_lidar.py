"""Heights of airport buildings from the USGS 3DEP LiDAR survey (plan 03, F4.1), the way the city's buildings get
theirs (scripts/build_buildings.py): roof returns inside the footprint less the ground returns around it. Offline, on
synthetic rasters in the survey's own grid (EPSG:3857, row 0 south)."""
import numpy as np
import pytest
from shapely.geometry import Polygon

from lib import airport_lidar as lid


def _raster(frame, centre, half, roof, ground, cell_m=1.5, tower=None):
    """A raster around `centre` (map metres) with a square building of half-size `half` at `roof` m on `ground`."""
    mx, my = lid.to_mercator(frame, np.array([centre[0] - 200, centre[0] + 200]), np.array([centre[1] - 200, centre[1] + 200]))
    cell = cell_m * lid.mercator_scale(frame, centre[1])
    nx, ny = int((mx[1] - mx[0]) / cell), int((my[1] - my[0]) / cell)
    r = lid.Raster(np.full((ny, nx), ground, np.float32), np.full((ny, nx), ground, np.float32), float(mx[0]), float(my[0]), cell)
    cx, cy = r.centres()
    lx, ly = lid.to_local(frame, cx, cy)
    inside = (np.abs(lx - centre[0]) < half) & (np.abs(ly - centre[1]) < half)
    r.zmax[inside] = roof
    r.zgnd[inside] = np.nan  # no ground under a roof
    if tower:
        t = (np.abs(lx - centre[0] - half / 2) < tower[0]) & (np.abs(ly - centre[1]) < tower[0])
        r.zmax[t] = tower[1]
    return r


def test_mercator_round_trip(lv_frame):
    x, y = np.array([1000.0, 4000.0]), np.array([-3000.0, -4500.0])
    mx, my = lid.to_mercator(lv_frame, x, y)
    bx, by = lid.to_local(lv_frame, mx, my)
    assert np.allclose(bx, x, atol=0.01) and np.allclose(by, y, atol=0.01)


def test_a_flat_roof(lv_frame):
    r = _raster(lv_frame, (3000, -3500), 20, 640.0, 628.0)
    s = lid.sample(r, Polygon([(2980, -3520), (3020, -3520), (3020, -3480), (2980, -3480)]), lv_frame)
    h, hmax = lid.building_height(s, 1600)
    assert h == pytest.approx(12.0, abs=0.01) and hmax == pytest.approx(12.0, abs=0.01)


def test_a_big_footprint_takes_the_upper_roof_and_a_small_one_the_median(lv_frame):
    # a 60 m square at 10 m with a 15 m wide block at 30 m over a quarter of it: p90 finds the block
    r = _raster(lv_frame, (3000, -3500), 30, 610.0, 600.0, tower=(10, 630.0))
    poly = Polygon([(2970, -3530), (3030, -3530), (3030, -3470), (2970, -3470)])
    s = lid.sample(r, poly, lv_frame)
    assert lid.building_height(s, poly.area)[0] == pytest.approx(30.0, abs=0.01)
    assert lid.building_height(s, 500)[0] == pytest.approx(10.0, abs=0.01)
    assert lid.building_height(s, poly.area)[1] == pytest.approx(30.0, abs=0.01)


def test_outside_the_survey_there_is_no_height(lv_frame):
    r = _raster(lv_frame, (3000, -3500), 20, 640.0, 628.0)
    far = Polygon([(9000, 9000), (9010, 9000), (9010, 9010), (9000, 9010)])
    assert lid.sample(r, far, lv_frame) is None
    assert lid.building_height(None, 100) == (None, None)


def test_the_survey_ground_against_surveyed_points(lv_frame):
    r = _raster(lv_frame, (3000, -3500), 20, 640.0, 628.0)
    off = lid.datum_offset(r, lv_frame, np.array([[2900.0, -3600.0, 628.4], [3100.0, -3400.0, 628.6]]))
    assert off == pytest.approx(0.5, abs=0.01)


def test_boxes_to_fetch_cover_each_footprint_with_a_margin(lv_frame):
    boxes = lid.boxes_for([Polygon([(0, 0), (10, 0), (10, 10)]), Polygon([(100, 100), (110, 100), (110, 120)])],
                          lv_frame, pad=30)
    assert len(boxes) == 2
    mx, my = lid.to_mercator(lv_frame, np.array([-30.0, 40.0]), np.array([-30.0, 40.0]))
    x0, y0, x1, y1 = boxes[0]
    assert x0 <= mx[0] and y0 <= my[0] and x1 >= mx[1] and y1 >= my[1]
