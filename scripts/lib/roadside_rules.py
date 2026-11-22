"""Where the signs go along a road, by rule (MUTCD chapters 2B, 2D, 2E and 2H): guide signs at
each exit, speed limits, route confirmation and mile markers, then a pass that keeps every two
signs on the same side at least SPACING apart by sliding each one within the window its rule
allows.

    from lib.roadside_rules import exit_candidates, speed_candidates, route_candidates, mile_candidates, solve
    cands = exit_candidates(exits, length) + ...
    placed, dropped = solve(cands)

An exit here is {"s", "side", "legend", "major", "osm"} with `legend` from roadside_legend.
Chainages are metres along the road; `s` of an exit is its OSM junction node, the painted gore.
"""
import bisect

MILE = 1609.344
SPACING = 60.0  # no two signs on one side closer than this (acceptance)
SOLVE_SPACING = 62.0  # what the solver keeps, so rounding never breaks the acceptance
ROOM = 250.0  # an advance sign stands at least this far past the previous interchange's gore
ENTRANCE = 800.0  # assumed distance from an exit gore to the end of its interchange's entrance ramp
EXIT_DIR = -150.0  # exit direction sign: where the deceleration lane begins
GORE = 30.0  # gore sign: just past the painted gore, in the physical gore
STEP = 5.0  # the solver's search step
SEQUENCE_REACH = 2.5 * MILE  # an interchange sequence sign names the exits within this distance

# solver order (lower first) and the window each kind may slide in, metres around its nominal s
PRIORITY = {"gore": 0, "exit": 1, "mile": 2, "advance": 3, "sequence": 4, "speed": 5, "route": 6}
WINDOW = {"gore": (-15, 60), "exit": (-80, 50), "mile": (-100, 100), "advance": (-120, 120),
          "sequence": (-200, 200), "speed": (-60, 200), "route": (-150, 250)}

FRACTIONS = {0: "", 1: "¼", 2: "½", 3: "¾"}


def miles_text(metres):
    """Distance on a sign: to the nearest quarter mile, at least a quarter. 1207 m -> '¾'."""
    q = max(1, round(metres / MILE * 4))
    whole, frac = divmod(q, 4)
    return (str(whole) if whole else "") + FRACTIONS[frac]


def action_text(miles):
    return {2: "2 MILES", 1: "1 MILE", 0.5: "½ MILE"}[miles]


def _cand(kind, s, side, **kw):
    lo, hi = WINDOW[kind]
    return {"kind": kind, "s_nom": float(s), "lo": float(s + lo), "hi": float(s + hi), "side": side,
            "prio": PRIORITY[kind], **kw}


def exit_candidates(exits, length):
    """Guide signs for every exit with a legend, and a note per exit on what the rule did.

    Per exit: advance signs at 2 miles (major interchanges only), 1 mile and 1/2 mile, each only
    where it stands at least ROOM past the previous interchange on the same side and after the
    road's start; an exit direction sign at the start of the exit; a gore sign. Where the 1-mile
    sign has no room (closely spaced interchanges, MUTCD 2E.40), an interchange sequence sign
    stands in the gap before the exit, naming it and the next two with their distances.
    """
    out, notes = [], []
    signed = [e for e in exits if e.get("legend")]
    for k, e in enumerate(signed):
        g, side = e["s"], e["side"]
        prev = [p["s"] for p in signed[:k] if p["side"] == side]
        start = (prev[-1] if prev else -1e9) + ROOM
        start = max(start, 0.0)
        base = {"exit_osm": e["osm"], "exit_ref": e["legend"]["exit"]}
        note = {"exit": e["legend"]["exit"] or e["osm"], "osm": e["osm"], "s": g, "side": side, "kinds": [], "omitted": []}
        for miles in ((2, 1, 0.5) if e.get("major") else (1, 0.5)):
            s = g - miles * MILE
            if s >= start:
                out.append(_cand("advance", s, side, miles=miles, **base))
                note["kinds"].append(f"advance {miles} mi")
            else:
                why = "before the route starts" if s < 0 else "closely spaced: no room after the previous interchange"
                note["omitted"].append({"advance": miles, "why": why, "room_m": round(g - start, 1)})
        lost_mile = any(o.get("advance") == 1 for o in note["omitted"]) and prev
        if lost_mile:
            # in the gap before this exit, past the previous interchange's entrance if there is room
            gap0, gap1 = prev[-1], g + EXIT_DIR
            s = gap0 + ENTRANCE if gap1 - gap0 > ENTRANCE + 2 * SOLVE_SPACING else (gap0 + gap1) / 2
            nxt = [x for x in signed[k:] if x["side"] == side and x["s"] - s < SEQUENCE_REACH][:3]
            rows = [{"exit": x["legend"]["exit"], "s_exit": x["s"], "dist": miles_text(x["s"] - s),
                     "text": x["legend"]["lines"][0] if x["legend"]["lines"] else
                     " ".join(f'{r["net"]} {r["num"]}' for r in x["legend"]["shields"])} for x in nxt]
            rows.reverse()  # MUTCD 2E.40: the nearest interchange at the bottom
            if len(rows) < 2:  # one row says no more than the 1/2-mile sign
                note["omitted"].append({"sequence": True, "why": "no second interchange within reach"})
                lost_mile = False
        if lost_mile:
            c = _cand("sequence", s, side, rows=rows, **base)
            c["lo"], c["hi"] = max(c["lo"], gap0 + 100), min(c["hi"], gap1 - 100)
            out.append(c)
            note["kinds"].append("interchange sequence")
        if g + EXIT_DIR >= 0:
            out.append(_cand("exit", g + EXIT_DIR, side, **base))
            note["kinds"].append("exit direction")
        else:
            note["omitted"].append({"exit": True, "why": "before the route starts"})
        out.append(_cand("gore", g + GORE, side, **base))
        note["kinds"].append("gore")
        notes.append(note)
    for c in out:
        c["lo"], c["hi"] = max(c["lo"], 0.0), min(c["hi"], length)
    return out, notes


def mph_at(speed, s):
    v = speed[0]["mph"] if speed else None
    for z in speed:
        if z["s0"] <= s:
            v = z["mph"]
    return v


def speed_candidates(speed, exits, length):
    """Speed limit signs at each change of zone and at the first sign position after each interchange."""
    out = []
    for z in speed:
        if z["s0"] > 0:
            out.append(_cand("speed", z["s0"], "right", mph=z["mph"], why="zone change"))
    for i, s in enumerate(_after_interchanges(exits, length, 200.0)):
        if all(abs(s - c["s_nom"]) > 500 for c in out):
            out.append(_cand("speed", s, "right", mph=mph_at(speed, s), why="after interchange"))
    for c in out:
        c["hi"] = min(c["hi"], length)
        c["lo"] = max(c["lo"], 0.0)
    return out


def route_candidates(exits, length, direction):
    """Route confirmation (cardinal direction and route number) past each interchange's entrance."""
    out = [_cand("route", s, "right", direction=direction) for s in _after_interchanges(exits, length, 0.0)]
    for c in out:
        c["hi"] = min(c["hi"], length)
    return out


def _after_interchanges(exits, length, extra):
    """Nominal positions past each right-hand interchange's entrance, where there is room before the next exit."""
    right = [e for e in exits if e.get("legend") and e["side"] == "right"]
    out = []
    for k, e in enumerate(right):
        s = e["s"] + ENTRANCE + extra
        nxt = right[k + 1]["s"] if k + 1 < len(right) else length + MILE
        if s < nxt - MILE / 2 - 150 and s < length - 50:  # before the next exit's 1/2-mile sign
            out.append(s)
    return out


def mile_candidates(length):
    """Mile markers every mile on the right; mile 0 is the road's start (the California line)."""
    return [_cand("mile", n * MILE, "right", mile=n) for n in range(int(length // MILE) + 1)]


def solve(cands, spacing=SOLVE_SPACING, step=STEP):
    """Place candidates in priority order, each at the free position nearest its nominal chainage
    inside its window. Returns (placed, dropped); placed records gain `s` and `shift`."""
    taken = {}
    placed, dropped = [], []
    for c in sorted(cands, key=lambda c: (c["prio"], c["s_nom"])):
        row = taken.setdefault(c.get("row", c["side"]), [])
        best = None
        n = int(max(c["s_nom"] - c["lo"], c["hi"] - c["s_nom"]) / step) + 1
        for i in range(n + 1):
            for s in ((c["s_nom"],) if i == 0 else (c["s_nom"] - i * step, c["s_nom"] + i * step)):
                if s < c["lo"] - 1e-6 or s > c["hi"] + 1e-6:
                    continue
                j = bisect.bisect_left(row, s)
                if (j == 0 or s - row[j - 1] >= spacing) and (j == len(row) or row[j] - s >= spacing):
                    best = s
                    break
            if best is not None:
                break
        if best is None:
            dropped.append({**c, "why": "no free position in its window"})
            continue
        bisect.insort(row, best)
        placed.append({**c, "s": round(best, 1), "shift": round(best - c["s_nom"], 1)})
    placed.sort(key=lambda c: (c["s"], c["side"]))
    return placed, dropped
