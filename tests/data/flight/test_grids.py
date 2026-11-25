"""The regional terrain grids of plan 03 (F6.1): region, approaches and valley, built by build_terrain.py and
build_imagery.py with the helpers in scripts/lib/grids.py. Unit tests on synthetic grids first, then checks on the
files in public/data/lv/."""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

from lib import grids  # noqa: E402

DATA = ROOT / "public" / "data" / "lv"
FIXTURES = ROOT / "tests" / "fixtures" / "flight"


# --- the delta-gzip encoding ---------------------------------------------------------------------

def test_delta_gzip_round_trips_heights_to_the_decimetre():
    rng = np.random.default_rng(3)
    ny, nx = 37, 53
    gx, gy = np.meshgrid(np.arange(nx), np.arange(ny))
    h = 1200 + 900 * np.sin(gx / 7) * np.cos(gy / 5) + rng.normal(0, 3, (ny, nx))
    h[0, 0], h[5, 7], h[-1, -1] = -86.0, 4421.3, -499.9  # Badwater, Whitney, near the floor
    blob = grids.encode_delta_gzip(h, scale=0.1, offset=-500)
    out = grids.decode_delta_gzip(blob, nx, ny, scale=0.1, offset=-500)
    assert out.shape == (ny, nx)
    assert np.abs(out - h).max() <= 0.05 + 1e-9
    assert blob[:2] == b"\x1f\x8b"  # a gzip member, which DecompressionStream('gzip') reads


def test_delta_gzip_body_is_the_left_up_difference_in_two_byte_planes():
    # a worked example: q = h * 10 with offset 0; the words are q - (left + up - upleft), wrapping mod 2^16, and the
    # body holds every word's low byte, then every word's high byte
    h = np.array([[1.0, 1.2, 1.5],
                  [1.1, 1.4, 1.2]])  # row 0 = south
    body = gzip.decompress(grids.encode_delta_gzip(h, scale=0.1, offset=0))
    # q = [[10, 12, 15], [11, 14, 12]]
    # row 0: 10, 12-10, 15-12; row 1: 11-10, 14-(11+12-10), 12-(14+15-12) = -5 = 0xFFFB
    assert list(body) == [10, 2, 3, 1, 1, 0xFB, 0, 0, 0, 0, 0, 0xFF]


def test_delta_gzip_round_trips_at_a_coarser_step():
    h = np.array([[612.4, 3632.0], [-86.0, 0.6]])
    out = grids.decode_delta_gzip(grids.encode_delta_gzip(h, scale=1.0, offset=-500), 2, 2, scale=1.0, offset=-500)
    assert np.abs(out - h).max() <= 0.5


def test_delta_gzip_refuses_heights_outside_its_range():
    with pytest.raises(ValueError):
        grids.encode_delta_gzip(np.array([[0.0, 7000.0]]), scale=0.1, offset=-500)


# --- the summit-preserving downsample --------------------------------------------------------------

def _fine_landscape(k=8, n=40):
    """Fine samples, k x k per post of an n x n grid: a tilted plane, a sharp peak, and a narrow gorge."""
    s = np.arange(n * k) + 0.5
    gx, gy = np.meshgrid(s, s)
    h = 800 + 2.0 * gx + 1.0 * gy
    peak = 1500 * np.exp(-(((gx - 100.5) ** 2 + (gy - 220.5) ** 2) / (2 * 3.0**2)))  # 3 samples wide
    gorge = -400 * np.exp(-(((gx - 252.5) / 2.0) ** 2)) * (gy > 40)  # a canyon 2 samples wide, north-south
    return h + peak + gorge, k


def test_downsample_keeps_a_summit_at_its_full_height():
    fine, k = _fine_landscape()
    out = grids.downsample_summits(fine, k)
    assert out.shape == (fine.shape[0] // k, fine.shape[1] // k)
    assert out.max() == pytest.approx(fine.max(), abs=1e-9)
    j, i = np.unravel_index(np.argmax(fine), fine.shape)
    assert out[j // k, i // k] == pytest.approx(fine.max(), abs=1e-9)


def test_downsample_does_not_fill_a_gorge_or_lift_the_plain():
    fine, k = _fine_landscape()
    out = grids.downsample_summits(fine, k)
    mean = fine.reshape(out.shape[0], k, out.shape[1], k).mean(axis=(1, 3))
    gorge = (slice(10, 40), 252 // k)
    assert np.abs(out[gorge] - mean[gorge]).max() < 1e-9  # the canyon floor keeps its mean
    plain = (slice(2, 12), slice(2, 8))
    assert np.abs(out[plain] - mean[plain]).max() < 1e-9  # a plane is its own mean


# --- stitching a grid's border to its parent -------------------------------------------------------

def _edge_points(g, per_step=4):
    """Points along the four edges of a grid entry, `per_step` to a post spacing."""
    x1, y1 = g["x0"] + (g["nx"] - 1) * g["step"], g["y0"] + (g["ny"] - 1) * g["step"]
    sx = np.linspace(g["x0"], x1, (g["nx"] - 1) * per_step + 1)
    sy = np.linspace(g["y0"], y1, (g["ny"] - 1) * per_step + 1)
    xs = np.concatenate([sx, sx, np.full_like(sy, g["x0"]), np.full_like(sy, x1)])
    ys = np.concatenate([np.full_like(sx, g["y0"]), np.full_like(sx, y1), sy, sy])
    return xs, ys


def test_a_stitched_grid_meets_its_parent_along_every_edge():
    rng = np.random.default_rng(7)
    pg = {"x0": -4096, "y0": -4096, "step": 1024, "nx": 9, "ny": 9}
    parent = grids.Surface(1000 + rng.normal(0, 400, (9, 9)), pg)
    cg = {"x0": -2048, "y0": -3072, "step": 256, "nx": 21, "ny": 25}  # edges on parent posts, step divides 1024
    own = 1000 + rng.normal(0, 400, (cg["ny"], cg["nx"]))
    h = grids.stitch_to_parent(own, cg, parent, band=8)
    # as stored: round-trip through the encoding
    child = grids.Surface(grids.decode_delta_gzip(grids.encode_delta_gzip(h), cg["nx"], cg["ny"]), cg)
    xs, ys = _edge_points(cg)
    assert np.abs(child.sample(xs, ys) - parent.sample(xs, ys)).max() < 0.5
    assert np.array_equal(h[8:-8, 8:-8], own[8:-8, 8:-8])  # nothing moves further in than the band


def test_stitching_refuses_a_grid_off_its_parents_posts():
    pg = {"x0": 0, "y0": 0, "step": 1024, "nx": 9, "ny": 9}
    parent = grids.Surface(np.zeros((9, 9)), pg)
    with pytest.raises(ValueError):
        grids.stitch_to_parent(np.zeros((5, 5)), {"x0": 100, "y0": 0, "step": 256, "nx": 5, "ny": 5}, parent)


def test_a_parent_conforms_to_a_fixed_child_off_its_posts():
    # far (80 m posts) cannot be rebuilt and does not sit on valley's 128 m posts: valley bends to it instead
    cg = {"x0": -4000, "y0": -3400, "step": 80, "nx": 76, "ny": 66}
    cx, cy = grids.post_xy(cg)
    child = grids.Surface(900 + 0.35 * cx - 0.2 * cy, cg)  # a steep slope, 35 % east and 20 % south
    pg = {"x0": -9984, "y0": -9984, "step": 128, "nx": 157, "ny": 157}
    px0, py0 = grids.post_xy(pg)
    own = 900 + 0.35 * px0 - 0.2 * py0 + 40  # the same land from a coarser source, 40 m off
    h = grids.conform_to_child(own, pg, child, band=8)
    xs, ys = _edge_points(cg)
    assert np.abs(grids.Surface(h, pg).sample(xs, ys) - child.sample(xs, ys)).max() < 0.05
    px, py = grids.post_xy(pg)
    away = (px < cg["x0"] - 9 * 128) | (px > child.x1 + 9 * 128) | (py < cg["y0"] - 9 * 128) | (py > child.y1 + 9 * 128)
    assert np.array_equal(h[away], own[away])


# --- colour: matching a coarser image to the finer one, and feathering the seam ----------------------

def _two_images(n=240):
    """A coarse image with a cast and a gradient, and a finer one covering its middle (NaN outside it)."""
    j, i = np.mgrid[0:n, 0:n].astype(np.float64)
    parent = np.stack([90 + 0.2 * i, 120 + 0.1 * j, 150 - 0.15 * i], axis=-1)
    inside = (i >= 80) & (i < 170) & (j >= 60) & (j < 190)
    child = np.stack([140 + 0.3 * i - 0.1 * j, 115 + 0.05 * j, 80 + 0.2 * j], axis=-1)
    child[~inside] = np.nan
    return parent, child, inside


def test_the_coarser_image_takes_the_finer_ones_mean_colour_over_their_overlap():
    parent, child, inside = _two_images()
    out = grids.match_colour(parent, child, inside, feather_px=30, blur_px=6)
    for c in range(3):
        assert out[inside, c].mean() == pytest.approx(child[inside, c].mean(), rel=0.03)


def test_no_colour_step_at_the_finer_images_edge():
    parent, child, inside = _two_images()
    out = grids.match_colour(parent, child, inside, feather_px=30, blur_px=6)
    # just outside the edge (the coarser image as drawn) against just inside it (the finer one), along all four sides
    pairs = [((slice(60, 190), 79), (slice(60, 190), 80)), ((slice(60, 190), 170), (slice(60, 190), 169)),
             ((59, slice(80, 170)), (60, slice(80, 170))), ((190, slice(80, 170)), (189, slice(80, 170)))]
    for o, k in pairs:
        assert np.abs(out[o] - child[k]).max() / 255 < 0.03
    far = np.zeros_like(inside)
    far[:20], far[-20:], far[:, :20], far[:, -20:] = True, True, True, True
    # away from the seam only the overall match remains, the same whatever the feather
    assert np.allclose(out[far], grids.match_colour(parent, child, inside, feather_px=2, blur_px=6)[far])


def test_the_sea_is_flat_at_sea_level_but_dry_basins_below_it_are_kept():
    h = np.full((30, 40), 200.0)
    h[:, :8] = np.linspace(-3000, -20, 8)  # the ocean floor shoaling to the coast
    h[10:15, 20:25] = -86.0  # Badwater: below sea level, but dry and walled in
    out = grids.flatten_sea(h)
    assert np.all(out[:, :8] == 0)
    assert np.all(out[10:15, 20:25] == -86.0)
    assert np.array_equal(out[:, 8:20], h[:, 8:20])


# --- the fixture for the browser's decoder ------------------------------------------------------------

def test_the_javascript_fixture_decodes_to_its_heights():
    spec = json.loads((FIXTURES / "grid-delta.json").read_text())
    blob = (FIXTURES / "grid-delta.bin.gz").read_bytes()
    body = gzip.decompress(blob)
    n = spec["nx"] * spec["ny"]
    words = np.frombuffer(body[:n], np.uint8).astype(np.int64) + 256 * np.frombuffer(body[n:], np.uint8).astype(np.int64)
    assert words.tolist() == spec["words"]
    h = grids.decode_delta_gzip(blob, spec["nx"], spec["ny"], spec["scale"], spec["offset"])
    assert np.allclose(h, np.array(spec["heights"]), atol=1e-9)


# --- the built files in public/data/lv ----------------------------------------------------------------

BUDGET_MB = {"region": 1.6, "approaches": 3.7, "valley": 3.2}  # plan 03, sections 7.9 and 9.2: heights and image
NESTING = [("approaches", "region"), ("valley", "approaches"), ("far", "valley")]  # (finer, coarser)
CHARLESTON = (36.27185, -115.69584, 3632.0)  # Charleston Peak: lat, lon, NAVD 88 height (11,916 ft)


@pytest.fixture(scope="module")
def meta():
    return json.loads((DATA / "terrain.json").read_text())


@pytest.fixture(scope="module")
def surfaces(meta):
    out = {}
    for name, g in meta["grids"].items():
        blob = (DATA / g["file"]).read_bytes()
        if g.get("encoding") == "delta-gzip":
            h = grids.decode_delta_gzip(blob, g["nx"], g["ny"], g["scale"], g["offset"])
        else:
            h = np.frombuffer(blob, "<u2").astype(np.float64).reshape(g["ny"], g["nx"]) * g["scale"]
        out[name] = grids.Surface(h, g)
    return out


def test_the_nested_grids_are_listed_with_their_encoding_image_and_priority(meta):
    for name, prio in (("region", 0), ("approaches", 1), ("valley", 2)):
        g = meta["grids"][name]
        assert g["encoding"] == "delta-gzip" and g["file"] == f"terrain-{name}.bin.gz"
        assert g["image"]["file"] == f"ground-{name}.webp" and g["image"]["format"] == "webp"
        assert g["priority"] == prio
    edge = meta["grids"]["region"]["edgeColor"]
    assert len(edge["srgb8"]) == 3 and all(0 <= v <= 255 for v in edge["srgb8"])


def test_valley_contains_the_drives_wide_grid(meta):
    v, w = meta["grids"]["valley"], meta["grids"]["wide"]
    ext = lambda g: (g["x0"], g["y0"], g["x0"] + (g["nx"] - 1) * g["step"], g["y0"] + (g["ny"] - 1) * g["step"])  # noqa: E731
    (vx0, vy0, vx1, vy1), (wx0, wy0, wx1, wy1) = ext(v), ext(w)
    assert vx0 <= wx0 and vy0 <= wy0 and vx1 >= wx1 and vy1 >= wy1
    assert vx0 <= -60000 and vx1 >= 70000 and vy0 <= -64000 and vy1 >= 50000


FAR_OFF_POSTS = ("far's edges are 78 and 72 km apart and its posts 80 m; valley's step must divide approaches' 512 m, so "
                 "the only step that puts far's edges on valley's posts is 16 m. far is not rebuilt (plan 03, F4.8), so valley "
                 "bends to it (conform_to_child) and the 128 m cells cannot follow far's 80 m relief along its edge")


@pytest.mark.parametrize("finer,coarser", [
    *NESTING[:2], pytest.param(*NESTING[2], marks=pytest.mark.xfail(strict=True, reason=FAR_OFF_POSTS))])
def test_neighbouring_grids_agree_along_their_shared_border(surfaces, meta, finer, coarser):
    xs, ys = _edge_points(meta["grids"][finer])
    d = np.abs(surfaces[finer].sample(xs, ys) - surfaces[coarser].sample(xs, ys))
    assert d.max() < 0.5, f"largest step {d.max():.2f} m at ({xs[d.argmax()]:.0f}, {ys[d.argmax()]:.0f})"


def test_valley_follows_far_along_its_edge_as_closely_as_its_posts_allow(surfaces, meta):
    # measured when built: median 0.18 m, 95th percentile 5.7 m, 99th 10.5 m, largest 26.2 m (in the mountains: the
    # cells straddling far's edge take valley's own slope across it, not far's)
    xs, ys = _edge_points(meta["grids"]["far"])
    d = np.abs(surfaces["far"].sample(xs, ys) - surfaces["valley"].sample(xs, ys))
    assert np.median(d) < 0.5 and np.percentile(d, 95) < 7 and np.percentile(d, 99) < 12 and d.max() < 30


def test_bending_valley_to_far_leaves_the_land_beyond_far_alone(surfaces, meta):
    # against approaches (built from the same tiles, never bent to far), valley's posts in the band it eases over beyond
    # far's edge must be no further off than the posts in the next band out, which nothing touched. A trench or ridge
    # dug by the bend shows here: continuing far's slope past its edge once put the band's largest difference at 391 m
    v, f, a = surfaces["valley"], surfaces["far"], surfaces["approaches"]
    px, py = grids.post_xy(meta["grids"]["valley"])
    d = np.maximum(np.maximum(f.x0 - px, px - f.x1).clip(0), np.maximum(f.y0 - py, py - f.y1).clip(0)) / v.step
    diff = np.abs(v.h - a.sample(px, py))
    band, beyond = diff[(d > 0) & (d <= 8)], diff[(d > 8) & (d <= 16)]
    assert np.percentile(band, 99) <= np.percentile(beyond, 99) * 1.1 and band.max() <= beyond.max() * 1.1


def test_charleston_peak_stands_at_its_surveyed_height_in_approaches(surfaces, lv_frame):
    lat, lon, height = CHARLESTON
    x, y = lv_frame.to_local(lat, lon)
    s = surfaces["approaches"]
    i, j = round((x - s.x0) / s.step), round((y - s.y0) / s.step)
    top = s.h[j - 2:j + 3, i - 2:i + 3].max()  # the posts within about 1 km
    assert abs(top - height) < 30, f"{top:.0f} m"


def _image(meta, name):
    from PIL import Image
    e = meta["grids"][name]
    f = e["image"]["file"] if isinstance(e.get("image"), dict) else f"ground-{name}.jpg"
    return np.asarray(Image.open(DATA / f).convert("RGB"), dtype=np.float64)


@pytest.mark.parametrize("finer,coarser", [("far", "valley"), ("valley", "approaches"), ("approaches", "region")])
def test_mean_colour_agrees_over_each_overlap(meta, finer, coarser):
    fg, cg = meta["grids"][finer], meta["grids"][coarser]
    mpp = cg["image"]["mpp"]
    img = _image(meta, coarser)
    H, W = img.shape[:2]
    cy1 = cg["y0"] + (cg["ny"] - 1) * cg["step"]
    gx = cg["x0"] + (np.arange(W) + 0.5) * mpp
    gy = cy1 - (np.arange(H) + 0.5) * mpp
    fx1, fy1 = fg["x0"] + (fg["nx"] - 1) * fg["step"], fg["y0"] + (fg["ny"] - 1) * fg["step"]
    inside = ((gy > fg["y0"]) & (gy < fy1))[:, None] & ((gx > fg["x0"]) & (gx < fx1))[None, :]
    want = _image(meta, finer).reshape(-1, 3).mean(axis=0)
    got = img[inside].mean(axis=0)
    assert np.all(np.abs(got - want) / want < 0.03), f"{got.round(1)} against {want.round(1)}"


@pytest.mark.parametrize("name", list(BUDGET_MB))
def test_sizes_within_budget(meta, name):
    g = meta["grids"][name]
    size = (DATA / g["file"]).stat().st_size + (DATA / g["image"]["file"]).stat().st_size
    assert size <= BUDGET_MB[name] * 1e6, f"{size / 1e6:.2f} MB"


# sha-256 of the grids and images that were in the repository before the nested grids (commit b657b71);
# building the nested grids must leave them as they are. A deliberate rebuild of one of them updates this list.
EXISTING = {
    "terrain-dam.bin": "2eeca055c8d84f436840a1198736e934220b59eefb2dc06e147ee132ed393261",
    "terrain-far.bin": "3009a217bd6a16caad3616d35e57dda454c2b5bca2ef63e10206fc4758e591ab",
    "terrain-near.bin": "076196d1e4a0d7bb21acfd41b641abe7cb993192e2755e405cc159f5f4ae27da",
    "terrain-wide.bin": "1e8a277d8b365fda582b08dc6a2bbf01b71075f809c92613ba2eed79c6d925c2",
    "ground-dam.jpg": "53c233e35e33de2f7c3624baf221beb5652dde61b633c7d422f55039070ad65c",
    "ground-far.jpg": "debe34d417622342022e22b04be3c382a89bf1b689cef0fda75b7cfdbd7a47da",
    "ground-near.jpg": "0b6b6e411fc0a1f7d69ac849554c7eb32778ec52506965a0e6b2756e6a4aa1d7",
    "ground-wide.jpg": "001adb55358bb0eb4ab0ecf691988eeb407c076cdaa4bad31cf46a7ff97e5a40",
}
EXISTING_ENTRIES = {
    "far": {"file": "terrain-far.bin", "nx": 976, "ny": 901, "x0": -48000, "y0": -34000, "step": 80, "scale": 0.1},
    "near": {"file": "terrain-near.bin", "nx": 685, "ny": 1051, "x0": -3600, "y0": -4400, "step": 12, "scale": 0.1},
    "wide": {"file": "terrain-wide.bin", "nx": 651, "ny": 701, "x0": -56000, "y0": -64000, "step": 160, "scale": 0.1},
}


@pytest.mark.parametrize("name", sorted(EXISTING))
def test_the_existing_grid_files_are_unchanged(name):
    import hashlib
    assert hashlib.sha256((DATA / name).read_bytes()).hexdigest() == EXISTING[name]


def test_the_existing_entries_of_terrain_json_are_unchanged(meta):
    for name, e in EXISTING_ENTRIES.items():
        assert meta["grids"][name] == e
    assert meta["patches"]["dam"]["file"] == "terrain-dam.bin" and meta["patches"]["dam"]["image"] == "ground-dam.jpg"


def test_despike_removes_single_bad_pixels_but_keeps_a_narrow_canyon():
    gx, gy = np.meshgrid(np.arange(60.0), np.arange(50.0))
    h = 1000 + 8 * gx + 3 * gy
    h[:, 30] -= 450  # a gorge one pixel wide, 450 m deep
    clean = h.copy()
    h[10, 10] += 3400  # Terrarium's garbage: one pixel thousands of metres off
    h[40, 45] -= 1000
    out = grids.despike(h, limit=500)
    assert np.array_equal(out[:, 30], clean[:, 30])
    assert abs(out[10, 10] - clean[10, 10]) < 30 and abs(out[40, 45] - clean[40, 45]) < 30
    keep = np.ones_like(h, bool)
    keep[10, 10] = keep[40, 45] = False
    assert np.array_equal(out[keep], clean[keep])


def test_bending_to_a_child_digs_no_trench_beyond_its_edge():
    # far's west edge in the Spring Mountains: far slopes down to its edge, the land beyond climbs again; continuing far's
    # slope past its edge dug a trench 400 m deep there (2,294 m against ground at 2,650 m)
    cg = {"x0": 0, "y0": 0, "step": 80, "nx": 51, "ny": 51}
    cx, cy = grids.post_xy(cg)
    child = grids.Surface(2400 + 0.47 * cx, cg)  # falls westward to 2,400 m at its edge x = 0
    pg = {"x0": -2560, "y0": -1280, "step": 128, "nx": 61, "ny": 41}
    px, py = grids.post_xy(pg)
    own = np.where(px < 0, 2500 - 0.6 * px, 2500 + 0.47 * px)  # beyond the edge the land rises westward
    h = grids.conform_to_child(own, pg, child, band=8)
    j = 20
    west = px[j] < 0
    edge_offset = 2400 - 2500  # child less parent at the edge
    assert np.all(h[j, west] >= own[j, west] + edge_offset - 1)  # never below the land shifted by the edge's offset
    assert np.all(h[j, west] <= own[j, west] + 1)
