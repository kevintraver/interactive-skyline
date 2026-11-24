"""Everything the drive draws meets the ground it draws (scripts/lib/groundcheck.py), on all three routes' built data:
drawn ground never above any road's pavement or shoulders; every embankment, open road end, pier, abutment, sign
post, overhead column, delineator, wall, billboard, lamp pole and roadside building within its tolerance of the drawn
ground (or of the road or embankment it stands on). The ground is the drawn one (lib.heights drawn_at), and the
roadside things stand where the runtime stands them: on that same ground (src/world/terrain/drawn.js, whose agreement
with the meshes and with this twin tests/unit/terrain/drawn.test.js holds)."""
import json
from pathlib import Path

import numpy as np
import pytest

from lib.groundcheck import TOL, check_route, check_water
from lib.heights import load_heights
from lib.ground import drawn_surface

ROOT = Path(__file__).resolve().parents[2]
ROUTES = [r["id"] for r in json.loads((ROOT / "public" / "data" / "lv" / "routes.json").read_text())["routes"]]

KINDS = ["pavement_main", "pavement_ramp", "pavement_crossing", "embankment_main", "embankment_ramp",
         "embankment_crossing", "end_ramp", "end_crossing", "pier_foot", "pier_buried", "abutment_toe", "sign_post",
         "sign_buried", "sign_column", "delineator_hang", "delineator_buried", "wall_base", "billboard_hang",
         "billboard_buried", "pole_hang", "building_hang"]
# Items still over tolerance, each kind with why (tests/data/ground_known.json): no more of them, none worse, and none
# other. It is empty: each item is fixed at its cause rather than recorded here.
KNOWN = json.loads((Path(__file__).with_name("ground_known.json")).read_text())


@pytest.fixture(scope="module")
def hs():
    return load_heights("lv")


@pytest.fixture(scope="module")
def reports(hs):
    return {r: check_route("lv", r, hs.drawn_at) for r in ROUTES}


def _key(w):
    return tuple(w.get(k) for k in ("road", "s", "x", "y", "side"))


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("kind", KINDS)
def test_everything_meets_the_drawn_ground(reports, route, kind):
    k = reports[route]["kinds"].get(kind)
    if k is None:
        pytest.skip(f"{route} has no {kind}")
    known = KNOWN.get(route, {}).get(kind)
    if not known:
        assert k["wrong"] == 0, f"{route} {kind}: {k['wrong']} over {k['tol_m']} m, worst {k['worst'][:3]}"
        return
    assert known["why"]
    assert k["wrong"] <= known["count"] and k["max_m"] <= known["max_m"] + 0.01, f"{route} {kind}: {k['wrong']}, {k['max_m']} m"
    allowed = {_key(w) for w in known["items"]}
    assert all(_key(w) in allowed for w in k["worst"]), f"{route} {kind}: {[w for w in k['worst'] if _key(w) not in allowed]}"


def test_no_exception_is_recorded():
    # an item over tolerance is fixed where it is made (brought to the ground, cut back, given its structure, or left
    # out with the reason in the build's report), not excused here
    assert KNOWN == {}


def test_the_drawn_ground_is_the_meshes_triangles(hs):
    # two triangles per cell split along (i+1, j)-(i, j+1): at the posts the grid's own heights, at a cell's middle
    # the mean of the diagonal's two posts (not the bilinear mean of all four)
    w = hs.grid("wide")
    i, j = 200, 120
    x, y = w.x0 + (i + 0.5) * w.step, w.y0 + (j + 0.5) * w.step
    top = drawn_surface(hs)
    assert hs.drawn_at(x, y) == top(x, y)
    assert hs.drawn_at(x, y) == pytest.approx((w.at(i + 1, j) + w.at(i, j + 1)) / 2, abs=1e-9)
    assert hs.drawn_at(w.x0 + i * w.step, w.y0 + j * w.step) == pytest.approx(w.at(i, j), abs=1e-9)


def test_water_meets_its_shores(hs):
    for body in check_water("lv", hs.drawn_at):
        assert body["edge_above_ground_p95_m"] <= 0.5, body


def test_nothing_in_the_pipeline_stands_on_the_bilinear_query():
    # the road build, the roadside, billboards and lamps take the drawn ground (lib.heights ground_of / drawn_at)
    scripts = ROOT / "scripts"
    allowed = {"lib/heights.py", "lib/ground.py", "lib/roadchecks.py", "lib/groundcheck.py", "check_ground.py"}
    bad = []
    for f in [*scripts.glob("*.py"), *scripts.glob("lib/*.py")]:
        rel = str(f.relative_to(scripts))
        if rel in allowed:
            continue
        for n, line in enumerate(f.read_text().splitlines(), 1):
            if ".height_at(" in line and "report" not in line and "lift" not in line:
                bad.append(f"{rel}:{n}")
    assert not bad, bad
