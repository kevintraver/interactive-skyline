"""The app's coordinate frame, numpy-vectorised. Twin of src/world/frame.js: change both together.

Scene axes: x east, y up, z south. Map coordinates are (x east, y north) in metres from the city
origin. The projection is a transverse Mercator on WGS84 about the origin with k = 1, written out
here (Krueger series to n^6) rather than taken from pyproj, so the two implementations stay twins;
tests/fixtures/frame.json holds both to pyproj.
"""
from types import SimpleNamespace

import numpy as np

EARTH_R = 6371000 * (7 / 6)  # standard refraction, as in main.js


def curve_drop(x, z):
    """How far the ground has fallen below the tangent plane at the origin."""
    return (x * x + z * z) / (2 * EARTH_R)


def local_up(x, z):
    """True vertical at a map position, in scene axes: an array of shape (..., 3), unit length."""
    x, z = np.broadcast_arrays(np.asarray(x, dtype=np.float64), np.asarray(z, dtype=np.float64))
    v = np.stack([x, np.full_like(x, EARTH_R), z], axis=-1)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


# WGS84
_A = 6378137.0
_F = 1 / 298.257223563
_E = np.sqrt(_F * (2 - _F))
_N = _F / (2 - _F)
_N2, _N3, _N4, _N5, _N6 = _N**2, _N**3, _N**4, _N**5, _N**6
_RECT = (_A / (1 + _N)) * (1 + _N2 / 4 + _N4 / 64 + _N6 / 256)
_ALPHA = [
    _N / 2 - (2 / 3) * _N2 + (5 / 16) * _N3 + (41 / 180) * _N4 - (127 / 288) * _N5 + (7891 / 37800) * _N6,
    (13 / 48) * _N2 - (3 / 5) * _N3 + (557 / 1440) * _N4 + (281 / 630) * _N5 - (1983433 / 1935360) * _N6,
    (61 / 240) * _N3 - (103 / 140) * _N4 + (15061 / 26880) * _N5 + (167603 / 181440) * _N6,
    (49561 / 161280) * _N4 - (179 / 168) * _N5 + (6601661 / 7257600) * _N6,
    (34729 / 80640) * _N5 - (3418889 / 1995840) * _N6,
    (212378941 / 319334400) * _N6,
]
_BETA = [
    _N / 2 - (2 / 3) * _N2 + (37 / 96) * _N3 - (1 / 360) * _N4 - (81 / 512) * _N5 + (96199 / 604800) * _N6,
    (1 / 48) * _N2 + (1 / 15) * _N3 - (437 / 1440) * _N4 + (46 / 105) * _N5 - (1118711 / 3870720) * _N6,
    (17 / 480) * _N3 - (37 / 840) * _N4 - (209 / 4480) * _N5 + (5569 / 90720) * _N6,
    (4397 / 161280) * _N4 - (11 / 504) * _N5 - (830251 / 7257600) * _N6,
    (4583 / 161280) * _N5 - (108847 / 3991680) * _N6,
    (20648693 / 638668800) * _N6,
]


def _conf_tan(tau):
    """tan of the conformal latitude, from tan of the geodetic latitude."""
    s = np.sinh(_E * np.arctanh(_E * tau / np.hypot(1, tau)))
    return tau * np.hypot(1, s) - s * np.hypot(1, tau)


def _geo_tan(taup):
    """Geodetic latitude's tan from the conformal one's, by Newton's method (Karney 2011)."""
    tau = taup / (1 - _E * _E)
    for _ in range(6):
        tp = _conf_tan(tau)
        tau = tau + (taup - tp) / np.hypot(1, tp) * ((1 + (1 - _E * _E) * tau * tau) / ((1 - _E * _E) * np.hypot(1, tau)))
    return tau


def _forward(lat, dlon):
    taup = _conf_tan(np.tan(lat))
    xip = np.arctan2(taup, np.cos(dlon))
    etap = np.arcsinh(np.sin(dlon) / np.hypot(taup, np.cos(dlon)))
    xi, eta = xip, etap
    for j, a in enumerate(_ALPHA, 1):
        xi = xi + a * np.sin(2 * j * xip) * np.cosh(2 * j * etap)
        eta = eta + a * np.cos(2 * j * xip) * np.sinh(2 * j * etap)
    return xi, eta


def create_frame(city):
    """The frame of one city: `city` is a cities.json entry (or any dict with origin and base).

    Returns a namespace with base, origin, scene_y(h, x, y), to_local(lat, lon) -> (x, y) and
    to_geodetic(x, y) -> (lat, lon), all in degrees and metres and vectorised over arrays.
    """
    origin = {"lat": city["origin"]["lat"], "lon": city["origin"]["lon"]}
    base = city["base"]
    lon0 = np.radians(origin["lon"])
    xi0 = float(_forward(np.radians(origin["lat"]), 0.0)[0])

    def scene_y(h, x, y):
        return h - base - curve_drop(x, y)

    def to_local(lat, lon):
        dlon = np.radians(np.asarray(lon, dtype=np.float64)) - lon0
        dlon = np.arctan2(np.sin(dlon), np.cos(dlon))
        xi, eta = _forward(np.radians(np.asarray(lat, dtype=np.float64)), dlon)
        return _RECT * eta, _RECT * (xi - xi0)

    def to_geodetic(x, y):
        xi = np.asarray(y, dtype=np.float64) / _RECT + xi0
        eta = np.asarray(x, dtype=np.float64) / _RECT
        xip, etap = xi, eta
        for j, b in enumerate(_BETA, 1):
            xip = xip - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
            etap = etap - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
        s, c = np.sinh(etap), np.cos(xip)
        lat = np.arctan(_geo_tan(np.sin(xip) / np.hypot(s, c)))
        lon = lon0 + np.arctan2(s, c)
        return np.degrees(lat), np.degrees(lon)

    return SimpleNamespace(base=base, origin=origin, scene_y=scene_y, to_local=to_local, to_geodetic=to_geodetic)
