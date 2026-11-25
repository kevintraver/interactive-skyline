"""How the drawn road surfaces of each route lie over and against each other (scripts/lib/layers.py), on the built
data in public/data/lv: every road that passes under another passes under a deck with 4.9 m below its soffit, and no
two pavements lie along each other closer than 4.9 m vertically outside a gore (lead-outs and lead-ins included)."""
import json
from pathlib import Path

import pytest

from lib.layers import CLEAR_MIN, END, close_overlaps, deck_clearances, load_frames

ROOT = Path(__file__).resolve().parents[2]
ROUTES = [r["id"] for r in json.loads((ROOT / "public" / "data" / "lv" / "routes.json").read_text())["routes"]]


@pytest.fixture(scope="module", params=ROUTES)
def built(request):
    return request.param, *load_frames("lv", request.param)


def test_every_road_under_another_passes_under_a_deck_with_the_clearance(built):
    route, _doc, frames = built
    found = deck_clearances(frames)
    assert found, f"{route}: no road passes under another"
    bad = [f"{route}: {f['lower']} at s {f['at']['lower_s']} passes {f['clearance_m']} m under the soffit of "
           f"{f['upper']} at s {f['at']['upper_s']} (rule {CLEAR_MIN} m)" + ("" if f["on_deck"] else ", not on a deck")
           for f in found if not f["ok"]]
    assert not bad, "\n".join(bad)


def test_no_two_pavements_lie_along_each_other_outside_a_gore(built):
    route, doc, frames = built
    bad = [f"{route}: {f['a']} s {f['a_s'][0]}..{f['a_s'][1]} and {f['b']} s {f['b_s'][0]}..{f['b_s'][1]} overlap "
           f"{f['length_m']} m within {f['dz_min_m']} m (median {f['dz_median_m']} m) vertically, not within {END} m of "
           "either road's end"
           for f in close_overlaps(frames, doc.get("junctions", [])) if not f["ok"]]
    assert not bad, "\n".join(bad)
