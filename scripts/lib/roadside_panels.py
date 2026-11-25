"""Panel sizes for the roadside signs, from MUTCD chapters 2B, 2D, 2E and 2H and plan 02 section
7.4. Every size is worked out in inches, as the MUTCD gives them, and returned in metres.

The layout model here (margins, row heights, gaps) is the one src/drive/roadside/faces.js draws,
so a panel sized here holds its legend there. Keep the two together.
"""
import math

from .roadside_legend import text_width

IN = 0.0254

# letter heights, inches (section 7.4: 20/15 at major interchanges, 16/12 at intermediate ones)
CAP_MAJOR, CAP_INTERMEDIATE = 20, 16
TAB_H, TAB_WORD, TAB_NUM = 30, 12, 15  # exit number plaque: 30 in tall, numerals 15 in
GORE_CAP = 15
SPEED_WORD, SPEED_NUM = 8, 20  # R2-1 at 48 x 60 in
MILE_WORD, MILE_NUM = 4, 10
ROUTE_WORD = 10

# the layout, in units of the cap height C (faces.js uses the same numbers)
SIDE = 1.0  # left and right margin inside the border
TOPBOT = 0.75  # top and bottom margin
GAP = 0.75  # between rows
SHIELD = 2.25  # shield row height
ARROW = 1.6  # arrow row height
BORDER, EDGE = 2, 1  # white border width and its inset from the panel edge, inches


def _round_up(v, step=6):
    return step * math.ceil(v / step - 1e-9)


def shield_width(num, height):
    return height * (1.0 if len(num) <= 2 else 1.3)


def shields_width(shields, cap):
    """The shield row: each shield followed by its cardinal word, groups a cap height apart."""
    w = 0.0
    for i, r in enumerate(shields):
        w += shield_width(r["num"], SHIELD * cap)
        if r.get("dir"):
            w += 0.4 * cap + text_width(r["dir"].upper(), 0.75 * cap)
        if i:
            w += cap
    return w


def guide_rows(sign, cap):
    """[(kind, width, height)] top to bottom, in inches, for a guide sign's legend."""
    rows = []
    if sign.get("shields"):
        rows.append(("shields", shields_width(sign["shields"], cap), SHIELD * cap))
    for line in sign.get("lines", []):
        rows.append(("line", text_width(line, cap), cap))
    if sign.get("action"):
        rows.append(("action", text_width(sign["action"], cap), cap))
    if sign.get("arrow"):
        rows.append(("arrow", ARROW * cap, ARROW * cap))
    for r in sign.get("rows", []):  # interchange sequence: name, then distance at the right
        rows.append(("seq", text_width(r["text"], cap) + 2 * cap + text_width(r["dist"], cap), cap))
    return rows


def guide_size(sign, cap):
    """(w, h) in inches of a green guide panel holding `sign`'s legend at cap height `cap`."""
    rows = guide_rows(sign, cap)
    w = max(r[1] for r in rows) + 2 * SIDE * cap
    h = sum(r[2] for r in rows) + GAP * cap * (len(rows) - 1) + 2 * TOPBOT * cap
    return max(72, _round_up(w)), max(36, _round_up(h))


def tab_size(text, left):
    """(w, h) in inches of the exit number plaque; a left exit adds the yellow LEFT panel."""
    word, _, num = text.partition(" ")
    w = text_width(word, TAB_WORD) + (0.4 * TAB_WORD + text_width(num, TAB_NUM) if num else 0) + 2 * 8
    if left:
        w += text_width("LEFT", TAB_WORD) + 2 * 4 + 6
    return _round_up(w), TAB_H


def gore_size(number):
    rows = [text_width("EXIT", GORE_CAP)] + ([text_width(number, GORE_CAP)] if number else []) + [ARROW * GORE_CAP]
    w = max(rows) + 2 * SIDE * GORE_CAP
    h = GORE_CAP * (len(rows) - 1) + ARROW * GORE_CAP + GAP * GORE_CAP * (len(rows) - 1) + 2 * TOPBOT * GORE_CAP
    return max(48, _round_up(w)), _round_up(h)


def mile_size(n):
    return 12, 24 if n < 10 else 36


SPEED_SIZE = (48, 60)
ROUTE_SIZE = (36, 56)  # cardinal plaque 36 x 18 over a 36 x 36 route marker, as one white panel


def metres(v):
    return round(v * IN, 3)
