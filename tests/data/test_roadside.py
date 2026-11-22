"""The roadside pipeline: legends from OSM tags and their precedence, the deny-list, sign placement
by MUTCD rule (a fixture exit, a left exit, interchanges too close for both advance signs) and the
spacing solver. Fixture: tests/fixtures/roadside-exits.json."""
import json
from pathlib import Path

import pytest

from lib.roadside_compose import check_legend, exit_entry, legend_texts, record
from lib.roadside_legend import abbreviate, denied, exit_legend, expand, load_denylist, text_width
from lib.roadside_panels import guide_size
from lib.roadside_rules import (EXIT_DIR, GORE, MILE, ROOM, SPACING, exit_candidates, mile_candidates, miles_text,
                                route_candidates, solve, speed_candidates)

ROOT = Path(__file__).resolve().parents[2]
FIX = json.loads((ROOT / "tests" / "fixtures" / "roadside-exits.json").read_text())
DENY = FIX["denylist"]


def exits(deny=DENY):
    out = []
    for e in FIX["exits"]:
        leg = exit_legend(e["link"], e["node"], e["ramps"], deny)
        major = bool(leg) and any(s["net"] in ("I", "US") for s in leg["shields"])
        out.append({"s": e["link"]["s"], "side": e["link"]["side"], "osm": e["link"]["osm"], "legend": leg, "major": major})
    return out


def placed_for(osm, kind=None):
    cands, _ = exit_candidates(exits(), FIX["length"])
    placed, _ = solve(cands)
    return [c for c in placed if c.get("exit_osm") == osm and (kind is None or c["kind"] == kind)]


# ---- legends


def test_destination_and_ref_come_first_and_keep_their_order():
    leg = exit_legend(*[FIX["exits"][0][k] for k in ("link", "node", "ramps")], DENY)
    assert leg["lines"] == ["Sloan", "Bermuda Rd"]
    assert leg["shields"] == [{"net": "SR", "num": "146", "dir": "East"}]
    assert leg["exit"] == "25"
    assert leg["src"] == {"lines": "osm:destination", "shields": "osm:destination:ref", "exit": "osm:junction ref"}


def test_exit_number_falls_back_from_the_node_to_the_ramp_to_the_link():
    link = {"s": 0, "side": "right", "ref": "9", "label": "", "osm": "n9"}
    assert exit_legend(link, {"ref": "7"}, [{"destination": "A", "junction:ref": "8"}], [])["exit"] == "7"
    leg = exit_legend(link, {}, [{"destination": "A", "junction:ref": "8"}], [])
    assert (leg["exit"], leg["src"]["exit"]) == ("8", "osm:junction:ref")
    leg = exit_legend(link, {}, [{"destination": "A"}], [])
    assert (leg["exit"], leg["src"]["exit"]) == ("9", "osm:link ref")


def test_label_only_when_the_ramp_says_nothing():
    e = FIX["exits"][5]
    leg = exit_legend(e["link"], e["node"], e["ramps"], DENY)
    assert leg["lines"] == ["Charleston Blvd"]
    assert leg["src"]["lines"] == "osm:label"
    assert exit_legend({"s": 0, "side": "right", "ref": "", "label": "", "osm": "n0"}, {}, [{}], DENY) is None


def test_two_destinations_at_most_with_the_rest_reported():
    e = FIX["exits"][4]
    leg = exit_legend(e["link"], e["node"], e["ramps"], DENY)
    assert leg["lines"] == ["Sahara Ave", "Paradise Rd"]
    assert leg["truncated"] == ["Joe W Brown Drive"]


def test_abbreviations_are_mutcd_suffixes_and_expand_back():
    assert abbreviate("Southern Highlands Parkway") == "Southern Highlands Pkwy"
    assert abbreviate("Boulevard") == "Boulevard"  # a lone word is a name, not a suffix
    assert expand(abbreviate("Russell Road")) == "Russell Road"


def test_legend_check_accepts_what_the_tags_say_and_catches_a_change():
    e = FIX["exits"][0]
    ex = exits()[0]
    entry = exit_entry(ex)
    assert check_legend(entry, e["ramps"], e["node"], DENY) == []
    assert check_legend({**entry, "lines": ["Sloan", "Blue Diamond Rd"]}, e["ramps"], e["node"], DENY)
    assert check_legend({**entry, "number": "26"}, e["ramps"], e["node"], DENY)


# ---- the deny-list


def test_denied_matches_whole_words_and_phrases_only():
    assert denied("Caesars Palace", DENY) == ["Caesars Palace"]
    assert denied("Harrah’s", DENY) == ["Harrah's"]  # a curly apostrophe matches too
    assert denied("Flamingo Road", DENY) == []
    assert denied("T-Mobile Arena West", DENY) == ["T-Mobile Arena"]


def test_a_denied_destination_is_replaced_by_its_street_or_dropped():
    ex = exits()
    flamingo, spring = ex[2]["legend"], ex[3]["legend"]
    assert flamingo["lines"] == ["Flamingo Rd"]
    assert flamingo["dropped"] == [{"from": "Flamingo Las Vegas", "terms": ["Flamingo Las Vegas"]}]
    assert spring["lines"] == ["Spring Mountain Rd"]
    assert spring["replaced"][0]["to"] == "Spring Mountain Road"
    for e in ex:
        for line in e["legend"]["lines"] if e["legend"] else []:
            assert denied(line, DENY) == []


def test_the_repo_denylist_loads_and_spares_road_names():
    deny = load_denylist(ROOT / "data" / "sign_denylist.txt")
    assert len(deny) > 40 and all(not t.startswith("#") for t in deny)
    for ok in ("Tropicana Avenue", "Flamingo Road", "Sahara Avenue", "Frank Sinatra Drive", "Primm", "Casino Center Boulevard"):
        assert denied(ok, deny) == [], ok
    for bad in ("Tropicana Las Vegas", "Allegiant Stadium", "Mandalay Bay Road", "Caesars Palace"):
        assert denied(bad, deny), bad


def test_every_text_on_a_record_is_scanned():
    ex = exits()
    entries = [exit_entry(e) for e in ex]
    cands, _ = exit_candidates(ex, FIX["length"])
    placed, _ = solve(cands)
    index = {e["osm"]: i for i, e in enumerate(entries)}
    texts = [t for c in placed for t in legend_texts(record(c, index, entries, "I 15"), entries)]
    assert "Sloan" in texts and "EXIT 25" in texts and "1 MILE" in texts
    assert not [t for t in texts if denied(t, DENY)]


# ---- placement


def test_placement_distances_on_a_fixture_exit():
    signs = {c["kind"] + str(c.get("miles", "")): c for c in placed_for("n1")}
    g = 10000
    assert signs["advance1"]["s"] == pytest.approx(g - MILE, abs=0.1)
    assert signs["advance0.5"]["s"] == pytest.approx(g - MILE / 2, abs=0.1)
    assert signs["exit"]["s"] == pytest.approx(g + EXIT_DIR, abs=0.1)
    assert signs["gore"]["s"] == pytest.approx(g + GORE, abs=0.1)
    assert all(c["side"] == "right" for c in signs.values())


def test_a_left_exit_gets_its_signs_on_the_left_with_the_left_plaque():
    signs = placed_for("n2")
    assert {c["kind"] for c in signs} == {"advance", "exit", "gore"}
    assert all(c["side"] == "left" for c in signs)
    entry = exit_entry(exits()[1])
    assert entry["tab"]["left"] is True and entry["tab"]["text"] == "EXIT"
    # the left side does not count right-hand exits as the previous interchange: it has room
    assert len([c for c in signs if c["kind"] == "advance"]) == 2


def test_interchanges_too_close_for_both_advance_signs_get_a_sequence_sign():
    _, notes = exit_candidates(exits(), FIX["length"])
    n39 = next(n for n in notes if n["exit"] == "39")
    # exit 39 is 1000 m past exit 38: no room for either advance sign
    assert [o["advance"] for o in n39["omitted"] if "advance" in o] == [1, 0.5]
    assert all(o["room_m"] == pytest.approx(1000 - ROOM, abs=0.1) for o in n39["omitted"] if "advance" in o)
    seq = placed_for("n4", "sequence")
    assert len(seq) == 1
    assert 20000 + 100 <= seq[0]["s"] <= 21000 + EXIT_DIR - 100  # in the gap, past exit 38
    assert [r["exit"] for r in seq[0]["rows"]] == ["40", "39"]  # nearest at the bottom
    assert {c["kind"] for c in placed_for("n4")} == {"sequence", "exit", "gore"}
    # exit 40, 1300 m on, keeps its 1/2-mile sign but not its 1-mile one
    assert [c.get("miles") for c in placed_for("n5", "advance")] == [0.5]


def test_no_two_signs_on_one_side_within_the_spacing():
    ex = exits()
    speed = [{"s0": 0, "mph": 70}, {"s0": 20500, "mph": 65}]
    cands, _ = exit_candidates(ex, FIX["length"])
    cands += speed_candidates(speed, ex, FIX["length"]) + route_candidates(ex, FIX["length"], "north")
    cands += mile_candidates(FIX["length"])
    placed, dropped = solve(cands)
    for side in ("left", "right"):
        ss = sorted(c["s"] for c in placed if c["side"] == side)
        assert all(b - a >= SPACING for a, b in zip(ss, ss[1:]))
    assert len([c for c in placed if c["kind"] == "mile"]) == int(FIX["length"] // MILE) + 1
    for c in placed:
        assert c["lo"] - 1e-6 <= c["s"] <= c["hi"] + 1e-6


def test_miles_on_signs_round_to_quarters():
    assert [miles_text(m) for m in (50, 402, 805, 1207, 1609, 2414)] == ["¼", "¼", "½", "¾", "1", "1½"]


def test_panels_grow_with_their_legend_and_hold_it():
    small = guide_size({"lines": ["Sloan"], "action": "1 MILE"}, 16)
    big = guide_size({"lines": ["Southern Highlands Pkwy"], "action": "1 MILE"}, 16)
    assert big[0] > small[0] and big[1] == small[1]
    assert big[0] >= text_width("Southern Highlands Pkwy", 16) + 2 * 16
