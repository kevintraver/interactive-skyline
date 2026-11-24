"""Heights and the sun for the flight bake (plan 03, 6.4 and 7.2 step 4).

- `geoid_height`: NOAA GEOID18 through PROJ (grid us_noaa_g2018u0.tif from the PROJ CDN, https://cdn.proj.org,
  fetched on demand by pyproj's network access and cached in PROJ's user folder). GEOID18 gives -28.08 m at the
  airport (https://geodesy.noaa.gov/api/geoid/ght?lat=36.08&lon=-115.15). Falls back to None when the grid cannot
  be had; the runway calibration does not need it, it only names the datum.
- `baro_to_msl`: barometric (standard pressure) altitude to height above sea level with the altimeter setting and
  the station temperature: the ISA pressure at that pressure altitude, the altitude of that pressure above the
  altimeter setting in the ISA, then the thickness above the station scaled by the ratio of actual to standard
  temperature (the hypsometric correction with a standard lapse rate).
- `sun_elevation`: NOAA's solar position equations (https://gml.noaa.gov/grad/solcalc/calcdetails.html), good to
  a few hundredths of a degree, which is plenty to name day, dusk or night.
"""
import math

import numpy as np

FT = 0.3048
T0 = 288.15
P0 = 1013.25
L = 0.0065
G = 9.80665
R = 287.05287
EXP = G / (R * L)
GEOID_FALLBACK = {"LAS": -28.08}


def baro_to_msl(pressure_alt_ft, altimeter_inhg, temp_c, station_elev_m):
    """Height above sea level (m) of a reported pressure altitude (ft), vectorised."""
    pa = np.asarray(pressure_alt_ft, dtype=float) * FT
    p = P0 * (1 - L * pa / T0) ** EXP
    qnh = altimeter_inhg * 33.8638866667
    h_ind = T0 / L * (1 - (p / qnh) ** (1 / EXP))
    t_std = T0 - L * station_elev_m
    t_act = temp_c + 273.15
    return station_elev_m + (h_ind - station_elev_m) * (t_act / t_std)


def datum_from_offset(offset_m, geoid=-28.08, tol=10.0):
    """Name the reference of a geometric altitude from its calibrated offset (reported minus true height)."""
    if geoid is not None and abs(offset_m - geoid) < tol:
        return "ellipsoid"
    if abs(offset_m) < tol:
        return "sea level"
    return "unknown"


_GEOID_TF = None


def geoid_height(lat, lon):
    """GEOID18 height of the geoid above the ellipsoid (m), or None if the grid is not available."""
    global _GEOID_TF
    try:
        import pyproj
        from pyproj.transformer import Transformer
        pyproj.network.set_network_enabled(True)
        if _GEOID_TF is None:
            _GEOID_TF = Transformer.from_pipeline("+proj=vgridshift +grids=us_noaa_g2018u0.tif +multiplier=1")
        _, _, z = _GEOID_TF.transform(lon, lat, 0.0)
        # vgridshift with multiplier 1 adds the grid value to the height: z = 0 + N
        return float(z) if math.isfinite(z) and abs(z) < 200 else None
    except Exception:
        return None


def sun_elevation(epoch_s, lat, lon):
    """The sun's elevation (degrees, refraction ignored) at a UTC instant, from NOAA's equations."""
    jd = epoch_s / 86400.0 + 2440587.5
    jc = (jd - 2451545.0) / 36525.0
    gmls = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    m = math.radians(gmas)
    eqc = math.sin(m) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + math.sin(2 * m) * (
        0.019993 - 0.000101 * jc) + math.sin(3 * m) * 0.000289
    true_long = gmls + eqc
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    mean_obl = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    obl = mean_obl + 0.00256 * math.cos(math.radians(omega))
    decl = math.asin(math.sin(math.radians(obl)) * math.sin(math.radians(app_long)))
    y = math.tan(math.radians(obl / 2)) ** 2
    l0 = math.radians(gmls)
    eot = 4 * math.degrees(y * math.sin(2 * l0) - 2 * ecc * math.sin(m) + 4 * ecc * y * math.sin(m) * math.cos(2 * l0)
                           - 0.5 * y * y * math.sin(4 * l0) - 1.25 * ecc * ecc * math.sin(2 * m))
    minutes = (epoch_s % 86400) / 60.0
    tst = (minutes + eot + 4 * lon) % 1440
    ha = tst / 4 - 180 if tst / 4 >= 0 else tst / 4 + 180
    zen = math.acos(math.sin(math.radians(lat)) * math.sin(decl)
                    + math.cos(math.radians(lat)) * math.cos(decl) * math.cos(math.radians(ha)))
    return 90 - math.degrees(zen)


def light_of(sun_deg):
    """Section 6.2's light classes: day above 15 degrees, dusk between +2 and -6, night below -12."""
    if sun_deg > 15:
        return "day"
    if -6 <= sun_deg <= 2:
        return "dusk"
    if sun_deg < -12:
        return "night"
    return "between"


def isa_density_ratio(h_m, temp_offset_c=0.0):
    """rho/rho0 at a height in an ISA shifted by a temperature offset (troposphere and lower stratosphere)."""
    h = np.asarray(h_m, dtype=float)
    t_isa = np.where(h < 11000, T0 - L * h, 216.65)
    p = np.where(h < 11000, (1 - L * h / T0) ** EXP, 0.22336 * np.exp(-G * (h - 11000) / (R * 216.65)))
    return p * T0 / (t_isa + temp_offset_c)
