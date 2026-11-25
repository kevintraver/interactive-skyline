"""The client name the flight scripts send to outside services (plan 03's privacy rule): a generic one, never a
person's name, an address, or this project's name or path. `apply()` sets it on lib.fetch's shared header dict, which
lib.fetch's own requests read; it runs on import when `requests` is installed, and every flight-pipeline function
that fetches calls it again first (the tests import the pipeline without `requests`)."""
CLIENT = "skyline-data/1.0"


def apply():
    from lib import fetch
    fetch.UA["User-Agent"] = CLIENT
    return fetch.UA


try:
    UA = apply()
except ImportError:          # no `requests`: nothing here can fetch anyway
    UA = {"User-Agent": CLIENT}
