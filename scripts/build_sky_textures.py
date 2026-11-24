# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "openexr", "requests"]
# ///
"""Usage: build_sky_textures.py

The faint sky behind the catalogue stars, and the Moon's face (plan 01, sections 6.2 and 7.7; T4.3, T3.3).

Faint sky: NASA SVS Deep Star Maps 2020 (item 4851). Its `milkyway` layer omits every Hipparcos and Tycho
star (brighter than about V 11.5); its `hiptyc` layer is those stars alone. The catalogue in stars.bin stops
at V 6.5, so the texture is the Milky Way layer plus the bright-star layer with the catalogue's stars masked
out: stars between 6.5 and 11.5 are neither lost nor drawn twice. Equirectangular, J2000, centred on 0h
right ascension, right ascension increasing to the left, north up. Encoded with a square-root curve and
scaled to cd/m2 so that integrated starlight near the north galactic pole, catalogue stars included, is
39 S10 (Leinert et al. 1998).

Moon: NASA SVS CGI Moon Kit (item 4720), the 2025 LROC colour map, centred on 0 degrees longitude, east to
the right, north up.

Output: public/data/sky/milkyway-2k.jpg, milkyway-4k.jpg, moon-1k.jpg, sky.json
"""
import gzip
import io
import json
import math
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "svs"
OUT = ROOT / "public" / "data" / "sky"
UA = {"User-Agent": "interactive-skyline-data/1.0"}
SVS_STARS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/"
SVS_MOON = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)  # linear sRGB / Rec. 709 luminance

# Leinert et al. 1998 (A&AS 127, 1), table 15 and section 7: integrated starlight near the north galactic pole
# is about 39 S10; one S10 is a 10th-magnitude solar-type star per square degree.
NGP_S10 = 39.0
NGP_RADIUS_DEG = 10.0
S10_MAG_ARCSEC2 = 10 + 2.5 * math.log10(3600.0**2)  # 27.78: 1 S10 in mag/arcsec2
GARSTANG_CDM2 = 10.8e4  # L = 10.8e4 x 10^(-0.4 mu) cd/m2 (plan 01, 7.7)

# galactic north pole and centre, J2000 (Hipparcos and Gaia documentation, ESA 1997 vol. 1, 1.5.3)
NGP_RA, NGP_DEC = 192.85948, 27.12825
GC_RA, GC_DEC = 266.40500, -28.93617
L_NCP = 122.93192  # galactic longitude of the north celestial pole

JPEG_QUALITY = {"milkyway-2k.jpg": 88, "milkyway-4k.jpg": 85, "moon-1k.jpg": 88}


def fetch(base, name):
    p = RAW / name
    if not p.exists():
        import requests
        RAW.mkdir(parents=True, exist_ok=True)
        print(f"downloading {base + name}")
        r = requests.get(base + name, headers=UA, timeout=600)
        r.raise_for_status()
        p.write_bytes(r.content)
        time.sleep(1)
    return p


# ---------------------------------------------------------------- geometry
def pixel_of(ra_deg, dec_deg, w, h):
    """Continuous pixel coordinates (x right, y down) of a J2000 direction on the equirectangular star map.

    The map is centred on 0h and right ascension increases to the left; pixel i spans [i, i + 1)."""
    x = (w / 2 - np.asarray(ra_deg) / 360.0 * w) % w
    y = (90.0 - np.asarray(dec_deg)) / 180.0 * h
    return x, y


def radec_of_pixels(w, h):
    """J2000 right ascension and declination (degrees) of every pixel centre, as (h, w) arrays."""
    x = np.arange(w) + 0.5
    y = np.arange(h) + 0.5
    ra = (180.0 - x / w * 360.0) % 360.0
    dec = 90.0 - y / h * 180.0
    return np.meshgrid(ra, dec)


def galactic(ra_deg, dec_deg):
    """J2000 equatorial to galactic longitude and latitude, degrees."""
    a, d = np.radians(ra_deg), np.radians(dec_deg)
    ap, dp = math.radians(NGP_RA), math.radians(NGP_DEC)
    sb = np.sin(d) * math.sin(dp) + np.cos(d) * math.cos(dp) * np.cos(a - ap)
    b = np.arcsin(np.clip(sb, -1, 1))
    y = np.cos(d) * np.sin(a - ap)
    x = np.sin(d) * math.cos(dp) - np.cos(d) * math.sin(dp) * np.cos(a - ap)
    l = (L_NCP - np.degrees(np.arctan2(y, x))) % 360
    return l, np.degrees(b)


def angular_distance(ra1, dec1, ra2, dec2):
    a1, d1, a2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
    c = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(a1 - a2)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


# ---------------------------------------------------------------- composition
def mask_radius_deg(vmag):
    """Angular radius masked around a catalogue star in the bright-star layer.

    Measured on the 4K layer: Sirius's image stays above 1 % of saturation out to about 0.5 degree; a 6th
    magnitude star covers one or two 0.088 degree pixels."""
    return np.clip(0.13 + 0.08 * (6.5 - np.asarray(vmag)), 0.13, 0.8)


def mask_stars(layer, stars):
    """Zero the bright-star layer around each (ra, dec, vmag) star. Returns the masked copy and the pixel count."""
    h, w = layer.shape[:2]
    out = layer.copy()
    keep = np.ones((h, w), dtype=bool)
    px_deg = 360.0 / w
    for ra, dec, v in stars:
        r = float(mask_radius_deg(v))
        cx, cy = pixel_of(ra, dec, w, h)
        ry = int(math.ceil(r / px_deg)) + 1
        y0, y1 = max(0, int(cy) - ry), min(h, int(cy) + ry + 1)
        cosd = max(math.cos(math.radians(min(89.9, abs(dec) + r))), 1e-3)
        rx = min(w // 2, int(math.ceil(r / px_deg / cosd)) + 1)
        xs = (np.arange(int(cx) - rx, int(cx) + rx + 1)) % w
        ys = np.arange(y0, y1)
        pra, pdec = (180.0 - (xs + 0.5) / w * 360.0) % 360.0, 90.0 - (ys + 0.5) / h * 180.0
        d = angular_distance(pra[None, :], pdec[:, None], ra, dec)
        sel = d <= r
        keep[np.ix_(ys, xs)] &= ~sel
    out[~keep] = 0
    return out, int((~keep).sum())


def downsample(a, f):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def sqrt_encode(linear, white):
    return np.round(np.sqrt(np.clip(linear / white, 0, 1)) * 255).astype(np.uint8)


def sqrt_decode(texel, white):
    return (np.asarray(texel, dtype=np.float64) / 255.0) ** 2 * white


def cap_mean(img, ra0, dec0, radius):
    """Solid-angle-weighted mean of an equirectangular image inside a cap."""
    h, w = img.shape[:2]
    ra, dec = radec_of_pixels(w, h)
    sel = angular_distance(ra, dec, ra0, dec0) <= radius
    wt = np.cos(np.radians(dec))[sel]
    return float((img[sel] * wt).sum() / wt.sum())


def catalogue_s10_in_cap(stars, ra0, dec0, radius):
    """Starlight of catalogue stars inside a cap, in S10 (10th-magnitude stars per square degree)."""
    ra, dec, v = (np.array(c) for c in zip(*stars))
    sel = angular_distance(ra, dec, ra0, dec0) <= radius
    area = 2 * math.pi * (1 - math.cos(math.radians(radius))) * (180 / math.pi) ** 2
    return float((10 ** (-0.4 * (v[sel] - 10))).sum() / area), int(sel.sum())


def s10_to_cdm2(s10):
    return GARSTANG_CDM2 * 10 ** (-0.4 * (S10_MAG_ARCSEC2 - 2.5 * math.log10(s10)))


def read_exr(path):
    import OpenEXR
    with OpenEXR.File(str(path)) as e:
        return e.channels()["RGB"].pixels.astype(np.float32)


def catalogue_stars():
    """(ra, dec, vmag) of every star in public/data/sky/stars.bin, decoded the way the app decodes it."""
    rec = np.frombuffer((OUT / "stars.bin").read_bytes(),
                        dtype=[("v", "<i2", 3), ("mag", "<i2"), ("rgb", "u1", 3), ("flags", "u1")])
    v = rec["v"].astype(np.float64)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    ra = np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 360
    dec = np.degrees(np.arcsin(v[:, 2]))
    return list(zip(ra, dec, rec["mag"] / 1000.0))


def save_jpeg(arr, name):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=JPEG_QUALITY[name], optimize=True, progressive=True, subsampling=0)
    (OUT / name).write_bytes(buf.getvalue())
    return len(buf.getvalue())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    mw_path = fetch(SVS_STARS, "milkyway_2020_4k.exr")
    ht_path = fetch(SVS_STARS, "hiptyc_2020_4k.exr")
    moon_path = fetch(SVS_MOON, "lroc_color_2k.jpg")
    stars = catalogue_stars()

    mw, ht = read_exr(mw_path), read_exr(ht_path)
    h, w = mw.shape[:2]
    ht_masked, masked_px = mask_stars(ht, stars)
    sky = mw + ht_masked
    print(f"masked {masked_px:,} pixels ({masked_px / (w * h):.2%}) of the bright-star layer around {len(stars)} stars")
    print(f"bright-star layer light kept: {ht_masked.sum() / ht.sum():.1%}")

    white = 1.0  # the source layers are clipped at 1; the sum rarely exceeds it
    clipped = float((sky.max(axis=2) > white).mean())
    luma = sky @ LUMA
    ngp_tex = cap_mean(luma, NGP_RA, NGP_DEC, NGP_RADIUS_DEG)
    cat_s10, cat_n = catalogue_s10_in_cap(stars, NGP_RA, NGP_DEC, NGP_RADIUS_DEG)
    target_s10 = NGP_S10 - cat_s10
    target_cdm2 = s10_to_cdm2(target_s10)
    scale = target_cdm2 / ngp_tex  # cd/m2 per unit of decoded luminance
    print(f"NGP cap ({NGP_RADIUS_DEG} deg): texture {ngp_tex:.5f}, catalogue {cat_n} stars = {cat_s10:.1f} S10; "
          f"texture target {target_s10:.1f} S10 = {target_cdm2 * 1e6:.1f} ucd/m2; scale {scale:.4e} cd/m2")

    sizes = {}
    for name, f in (("milkyway-4k.jpg", 1), ("milkyway-2k.jpg", 2)):
        img = sky if f == 1 else downsample(sky, f)
        sizes[name] = {"bytes": save_jpeg(sqrt_encode(img, white), name), "width": img.shape[1], "height": img.shape[0]}
        print(f"{name}: {img.shape[1]}x{img.shape[0]}, {sizes[name]['bytes']:,} bytes")

    moon = Image.open(moon_path).convert("RGB")
    src_size = moon.size
    moon = moon.resize((1024, 512), Image.LANCZOS)
    sizes["moon-1k.jpg"] = {"bytes": save_jpeg(np.asarray(moon), "moon-1k.jpg"), "width": 1024, "height": 512}
    print(f"moon-1k.jpg: from {src_size[0]}x{src_size[1]}, {sizes['moon-1k.jpg']['bytes']:,} bytes")

    gc_x, gc_y = pixel_of(GC_RA, GC_DEC, 1.0, 1.0)
    meta = {
        "milkyWay": {
            "files": {"2k": "milkyway-2k.jpg", "4k": "milkyway-4k.jpg"},
            "sizes": sizes,
            "projection": "equirectangular, J2000 equatorial; u = 0.5 - RA/360 (mod 1), so the centre column is RA 0h and RA increases to the left; v = (90 - Dec)/180 from the top row (north) down",
            "galacticCentreUV": [round(float(gc_x), 6), round(float(gc_y), 6)],
            "encoding": {"curve": "sqrt", "white": white,
                         "decode": "linear = (texel / 255)^2 * white, per channel, the texel read without any colour-space conversion",
                         "colorSpace": "linear sRGB primaries after decoding"},
            "scaleCdM2": scale,
            "scaleNote": "luminance in cd/m2 = scaleCdM2 * (0.2126 R + 0.7152 G + 0.0722 B) of the decoded linear value",
            "calibration": {
                "anchor": f"integrated starlight near the north galactic pole = {NGP_S10} S10 (Leinert et al. 1998, A&AS 127, 1)",
                "capRadiusDeg": NGP_RADIUS_DEG, "textureMeanLuma": ngp_tex,
                "catalogueStarsInCap": cat_n, "catalogueS10": round(cat_s10, 2), "textureS10": round(target_s10, 2),
                "textureCdM2": target_cdm2, "s10MagArcsec2": round(S10_MAG_ARCSEC2, 3),
                "luminanceFromMu": "L = 10.8e4 * 10^(-0.4 mu) cd/m2 (Garstang)",
            },
            "composition": {
                "layers": ["milkyway_2020_4k.exr (Milky Way background, every Hipparcos and Tycho star omitted)",
                           "hiptyc_2020_4k.exr (Hipparcos and Tycho stars) with the stars of stars.bin masked out"],
                "maskRadiusDeg": "0.13 + 0.08 * (6.5 - V), clipped to 0.13 .. 0.8",
                "maskedPixelsFraction": round(masked_px / (w * h), 5),
                "brightStarLightKept": round(float(ht_masked.sum() / ht.sum()), 4),
                "pixelsAboveWhite": clipped,
            },
            "source": {
                "product": "NASA SVS Deep Star Maps 2020 (item 4851)",
                "urls": [SVS_STARS + "milkyway_2020_4k.exr", SVS_STARS + "hiptyc_2020_4k.exr"],
                "page": "https://svs.gsfc.nasa.gov/4851/",
                "retrieved": date.fromtimestamp(mw_path.stat().st_mtime).isoformat(),
                "terms": "SVS: \"All of our content is in the public domain (unless otherwise noted)\" (https://svs.gsfc.nasa.gov/help/)",
                "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Constructed from Hipparcos-2, Tycho-2 and Gaia DR2.",
            },
        },
        "moon": {
            "file": "moon-1k.jpg", "width": 1024, "height": 512,
            "projection": "equirectangular selenographic; u = (longitude + 180)/360, east to the right, centre column 0 degrees; v = (90 - latitude)/180 from the top row (north) down",
            "colorSpace": "sRGB (as published)",
            "source": {
                "product": "NASA SVS CGI Moon Kit (item 4720), LROC colour map, 2025 version",
                "url": SVS_MOON + "lroc_color_2k.jpg", "page": "https://svs.gsfc.nasa.gov/4720/",
                "sourceSize": list(src_size),
                "retrieved": date.fromtimestamp(moon_path.stat().st_mtime).isoformat(),
                "terms": "SVS: \"All of our content is in the public domain (unless otherwise noted)\" (https://svs.gsfc.nasa.gov/help/)",
                "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio; LRO camera (LROC) and laser altimeter (LOLA) teams.",
            },
        },
    }
    (OUT / "sky.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
