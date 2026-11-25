"""The building height ladder's tag rules, shared by build_buildings.py (the core) and
build_corridor.py (the buildings beyond it). Moved here unchanged from build_buildings.py.

    num("12 ft")        # 3.6576: a height tag in metres, or None
    stitch(ways)        # closed rings from way fragments
    LEVEL_M, GUESS_M    # metres per `building:levels`, and the core's guess for an unknown height
"""

LEVEL_M = 3.2
GUESS_M = 4.0


def num(v):
    if v is None:
        return None
    s = str(v).strip().lower().replace(",", ".")
    try:
        if s.endswith("ft") or s.endswith("'"):
            return float(s.rstrip("ft'").strip()) * 0.3048
        return float(s.rstrip("m").strip())
    except ValueError:
        return None


def stitch(ways):
    """Join way fragments into closed rings."""
    rings, pool = [], [list(w) for w in ways if len(w) >= 2]
    while pool:
        cur = pool.pop()
        while cur[0] != cur[-1]:
            for i, w in enumerate(pool):
                if w[0] == cur[-1]:
                    cur += w[1:]; pool.pop(i); break
                if w[-1] == cur[-1]:
                    cur += w[-2::-1]; pool.pop(i); break
            else:
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings
