# T4.3 data half and the Moon map (T3.3): the committed textures, read back from disk.
import json
import math

import numpy as np
import pytest
from PIL import Image

import build_sky_textures as st
from conftest import ROOT

SKY = ROOT / "public/data/sky"
META = json.loads((SKY / "sky.json").read_text())
MW = META["milkyWay"]


def decoded_luma(name):
    texel = np.asarray(Image.open(SKY / name).convert("RGB"))
    return st.sqrt_decode(texel, MW["encoding"]["white"]) @ st.LUMA


@pytest.fixture(scope="module")
def mw2k():
    return decoded_luma("milkyway-2k.jpg")


def box_mean(img, ra, dec, half_deg=3.0):
    h, w = img.shape
    x, y = st.pixel_of(ra, dec, w, h)
    r = int(half_deg / 360 * w)
    xs = np.arange(int(x) - r, int(x) + r + 1) % w
    ys = np.clip(np.arange(int(y) - r, int(y) + r + 1), 0, h - 1)
    return float(img[np.ix_(ys, xs)].mean())


def test_pixel_mapping_puts_0h_in_the_middle_and_ra_increasing_to_the_left():
    assert st.pixel_of(0, 0, 4096, 2048) == (2048, 1024)
    x6, _ = st.pixel_of(90, 0, 4096, 2048)
    assert x6 == 1024  # 6h is a quarter of the way in from the left
    _, y = st.pixel_of(0, 90, 4096, 2048)
    assert y == 0
    ra, dec = st.radec_of_pixels(8, 4)
    x, y = st.pixel_of(ra, dec, 8, 4)
    assert np.allclose(x, np.arange(8) + 0.5) and np.allclose(y.T, np.arange(4) + 0.5)


def test_galactic_transform():
    l, b = st.galactic(st.GC_RA, st.GC_DEC)
    assert abs(b) < 0.01 and min(l, 360 - l) < 0.01
    _, b = st.galactic(st.NGP_RA, st.NGP_DEC)
    assert b > 89.99


def test_galactic_centre_is_bright_where_its_j2000_position_predicts(mw2k):
    gc = box_mean(mw2k, st.GC_RA, st.GC_DEC)
    mirrored = box_mean(mw2k, 360 - st.GC_RA, st.GC_DEC)  # where it would be if RA ran the other way
    anticentre = box_mean(mw2k, 86.405, 28.936)
    assert gc > 3 * mirrored
    assert gc > 3 * anticentre
    assert MW["galacticCentreUV"] == pytest.approx([(0.5 - st.GC_RA / 360) % 1, (90 - st.GC_DEC) / 180], abs=1e-6)


def test_large_magellanic_cloud_is_in_the_south(mw2k):
    lmc = box_mean(mw2k, 80.89, -69.76, 2)
    assert lmc > 3 * box_mean(mw2k, 360 - 80.89, -69.76, 2)  # east-west
    assert lmc > 3 * box_mean(mw2k, 80.89, 69.76, 2)  # north-south


def test_milky_way_follows_the_galactic_plane(mw2k):
    ra, dec = st.radec_of_pixels(*mw2k.shape[::-1])
    _, b = st.galactic(ra, dec)
    wt = np.cos(np.radians(dec))
    plane = (mw2k * wt)[np.abs(b) < 10].sum() / wt[np.abs(b) < 10].sum()
    poles = (mw2k * wt)[np.abs(b) > 60].sum() / wt[np.abs(b) > 60].sum()
    assert plane > 3 * poles


def test_catalogue_stars_are_masked_out():
    tex = decoded_luma("milkyway-4k.jpg")
    for ra, dec in [(101.287, -16.716), (279.234, 38.784), (95.988, -52.696)]:  # Sirius, Vega, Canopus
        x, y = (int(v) for v in st.pixel_of(ra, dec, 4096, 2048))
        local = np.median(tex[y - 40:y + 40, x - 40:x + 40])
        assert tex[y - 5:y + 6, x - 5:x + 6].max() < 4 * local


def test_sqrt_encoding_round_trips():
    lin = np.linspace(0, 1, 10001)
    enc = st.sqrt_encode(lin, 1.0)
    dec = st.sqrt_decode(enc, 1.0)
    # error never larger than half a code step of the square root
    assert np.all(np.abs(np.sqrt(dec) - np.sqrt(lin)) <= 0.5 / 255 + 1e-12)
    assert st.sqrt_decode(255, 2.0) == 2.0 and st.sqrt_decode(0, 2.0) == 0


def test_recorded_scale_reproduces_the_north_galactic_pole_anchor():
    cal = MW["calibration"]
    assert cal["textureS10"] + cal["catalogueS10"] == pytest.approx(st.NGP_S10, abs=0.02)
    assert cal["textureCdM2"] == pytest.approx(st.s10_to_cdm2(cal["textureS10"]), rel=1e-3)
    # 22 mag/arcsec2 is 205 S10 (Leinert et al. 1998)
    assert st.s10_to_cdm2(205) == pytest.approx(st.GARSTANG_CDM2 * 10 ** (-0.4 * 22), rel=0.01)
    # measured on the shipped files, JPEG and all
    for name in ("milkyway-4k.jpg", "milkyway-2k.jpg"):
        ngp = st.cap_mean(decoded_luma(name), st.NGP_RA, st.NGP_DEC, cal["capRadiusDeg"])
        assert MW["scaleCdM2"] * ngp == pytest.approx(cal["textureCdM2"], rel=0.05), name


@pytest.mark.parametrize("name,budget", [("milkyway-2k.jpg", 500_000), ("milkyway-4k.jpg", 2_000_000), ("moon-1k.jpg", 150_000)])
def test_files_fit_the_download_budget(name, budget):
    size = (SKY / name).stat().st_size
    assert size <= budget
    w, h = Image.open(SKY / name).size
    assert w == 2 * h


def moon_mean(img, lat, lon, half=2.5):
    h, w = img.shape
    x, y = int((lon + 180) / 360 * w), int((90 - lat) / 180 * h)
    r = int(half / 360 * w)
    return float(img[y - r:y + r + 1, x - r:x + r + 1].mean())


def test_moon_map_orientation():
    m = np.asarray(Image.open(SKY / "moon-1k.jpg").convert("L"), dtype=float)
    assert m.shape == (512, 1024)
    crisium = moon_mean(m, 17, 59)
    assert crisium < 0.8 * moon_mean(m, 17, 80)  # highlands east of it
    assert crisium < 0.8 * moon_mean(m, -17, 59)  # north-south flip would put highlands here
    tycho = moon_mean(m, -43.3, -11.4, 0.6)
    assert tycho > moon_mean(m, -43.3, 11.4, 0.6)  # east-west flip
    imbrium = moon_mean(m, 33, -16)
    assert imbrium < 0.8 * moon_mean(m, -33, -16)
