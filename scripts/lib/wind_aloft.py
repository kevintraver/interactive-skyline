"""Wind and temperature aloft for a flight's bake (plan 03, section 6.4): Open-Meteo's historical forecast API, GFS
pressure levels 925 to 150 hPa, one request per flight day, cached under data/raw/openmeteo/. The response becomes
the header's `atmosphere` rows through lib.attitude.rows_from_open_meteo.

  Source  https://historical-forecast-api.open-meteo.com/v1/forecast (Open-Meteo, CC BY 4.0; the GFS model data
          is NOAA's, public domain). Requests carry the generic client name of lib.flight_net.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from lib import flight_net  # noqa: F401  (the generic client name)
from lib.attitude import OPEN_METEO, open_meteo_params, rows_from_open_meteo
from lib.fetch import cached_get


def fetch_day(lat, lon, day, raw_dir: Path):
    """The day's hourly pressure-level response (dict) and the URL it came from."""
    flight_net.apply()
    url = OPEN_METEO + "?" + urlencode(open_meteo_params(lat, lon, day))
    cache = Path(raw_dir) / f"gfs-{round(lat, 3)}_{round(lon, 3)}-{day}.json"
    _, body = cached_get(url, cache)
    return json.loads(body), url


def profile(lat, lon, epoch, raw_dir: Path):
    """Atmosphere rows at an instant, and the URL; rows are [] when the archive has nothing for it."""
    day = datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%d")
    resp, url = fetch_day(lat, lon, day, raw_dir)
    if "hourly" not in resp:
        return [], url
    return rows_from_open_meteo(resp, epoch), url
