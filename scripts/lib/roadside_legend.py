"""Sign legends for the roadside pipeline: what a guide sign says, from an exit's OSM tags, with
the provenance of every line; the deny-list of trade names (plan 02, assumption A5); and the
text-width estimate that sizes the panels.

    from lib.roadside_legend import exit_legend, load_denylist, denied
    deny = load_denylist(path)
    leg = exit_legend(link, node_tags, link_tags_list, deny)   # dict or None
"""
import re
from pathlib import Path

# MUTCD Table 1A-2 abbreviations for street suffixes, used on guide signs to keep panels a
# reasonable width. A legend still "equals its tags": expand() undoes them for the check.
ABBREVIATIONS = {
    "Avenue": "Ave", "Boulevard": "Blvd", "Drive": "Dr", "Parkway": "Pkwy", "Road": "Rd",
    "Street": "St", "Lane": "Ln", "Highway": "Hwy", "Expressway": "Expwy", "Freeway": "Fwy",
}
_EXPAND = {v: k for k, v in ABBREVIATIONS.items()}

MAX_DESTINATIONS = 2  # MUTCD 2E.10: no more than two destination names on a guide sign
MAX_SHIELDS = 3

CARDINALS = {"north": "North", "south": "South", "east": "East", "west": "West"}


def load_denylist(path):
    """Terms from the deny-list file: one per line, '#' comments, blank lines ignored."""
    terms = []
    for line in Path(path).read_text().splitlines():
        t = line.split("#", 1)[0].strip()
        if t:
            terms.append(t)
    return terms


def _pattern(term):
    # whole words or phrases, case-insensitive; an apostrophe matches a straight or curly one
    body = re.escape(term).replace("'", "['’]")
    return re.compile(rf"(?<![\w]){body}(?![\w])", re.IGNORECASE)


_PATTERNS = {}


def denied(text, terms):
    """The deny-listed terms found in text (empty if none)."""
    out = []
    for t in terms:
        p = _PATTERNS.get(t) or _PATTERNS.setdefault(t, _pattern(t))
        if p.search(text or ""):
            out.append(t)
    return out


def abbreviate(name):
    """'Blue Diamond Road' -> 'Blue Diamond Rd': the last word only, as signs do."""
    words = name.split()
    if len(words) > 1 and words[-1] in ABBREVIATIONS:
        words[-1] = ABBREVIATIONS[words[-1]]
    return " ".join(words)


def expand(name):
    words = name.split()
    if len(words) > 1 and words[-1] in _EXPAND:
        words[-1] = _EXPAND[words[-1]]
    return " ".join(words)


def split_list(v):
    return [p.strip() for p in (v or "").split(";") if p.strip()]


def parse_ref(ref):
    """'CC 215 West' -> {'net': 'CC', 'num': '215', 'dir': 'West'}; None if it is not a route."""
    m = re.match(r"^\s*([A-Z]{1,4})\s*(\d{1,4}[A-Z]?)(?:\s+(North|South|East|West|EXPR|Business|BUS))?\s*$", ref or "", re.I)
    if not m:
        return None
    d = (m.group(3) or "").lower()
    return {"net": m.group(1).upper(), "num": m.group(2).upper(), "dir": CARDINALS.get(d, "")}


def exit_legend(link, node_tags, link_tags, deny):
    """The legend of an exit's guide signs, or None when OSM gives nothing to put on one.

    Precedence (plan 02, D3.7): `destination` and `destination:ref` on the exit ramp; the exit
    number from the junction's `ref`, else the ramp's `junction:ref`, else the link record's
    `ref`; and only when the ramp has no destination at all, the link record's `label`.
    Destinations that match the deny-list are replaced by the ramp's `destination:street` when
    that is clean, else dropped. Returns {"lines", "shields", "exit", "src", "dropped",
    "replaced", "full"}; `src` names the tag behind each part.
    """
    tags = {}
    for t in link_tags:  # the first ramp that says something wins, key by key
        for k, v in t.items():
            tags.setdefault(k, v)
    src = {}
    dests = split_list(tags.get("destination"))
    if dests:
        src["lines"] = "osm:destination"
    refs = [r for r in (parse_ref(x) for x in split_list(tags.get("destination:ref"))) if r]
    if refs:
        src["shields"] = "osm:destination:ref"
    number = node_tags.get("ref") or tags.get("junction:ref") or link.get("ref") or ""
    if node_tags.get("ref"):
        src["exit"] = "osm:junction ref"
    elif tags.get("junction:ref"):
        src["exit"] = "osm:junction:ref"
    elif link.get("ref"):
        src["exit"] = "osm:link ref"
    replaced, dropped = [], []
    clean = []
    for d in dests:
        hit = denied(d, deny)
        if not hit:
            clean.append(d)
            continue
        street = tags.get("destination:street")
        if street and not denied(street, deny) and street not in clean:
            clean.append(street)
            replaced.append({"from": d, "to": street, "terms": hit})
        else:
            dropped.append({"from": d, "terms": hit})
    if dests and not clean and link.get("label") and not denied(link["label"], deny):
        clean = [p.strip() for p in link["label"].split("/") if p.strip()]
        src["lines"] = "osm:label"
    if not dests and not refs:
        label = link.get("label") or ""
        if label and not denied(label, deny):
            clean = [p.strip() for p in label.split("/") if p.strip()]
            src["lines"] = "osm:label"
    if not clean and not refs:
        return None
    full = list(clean)
    lines = [abbreviate(d) for d in clean[:MAX_DESTINATIONS]]
    return {
        "lines": lines, "shields": refs[:MAX_SHIELDS], "exit": number, "src": src,
        "dropped": dropped, "replaced": replaced, "full": full, "truncated": full[MAX_DESTINATIONS:],
    }


# Approximate advance widths of a bold grotesque (Helvetica Bold's, per 1000 units of em), used
# only to size panels; the runtime measures the real font and fits to the panel by rule.
_W = dict(zip(
    " !\"#$%&'()*+,-./0123456789:;<=>?@",
    [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278]
    + [556] * 10 + [333, 333, 584, 584, 584, 611, 975]))
_W.update(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ",
              [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
               667, 611, 722, 667, 944, 667, 667, 611]))
_W.update(zip("abcdefghijklmnopqrstuvwxyz",
              [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389,
               556, 333, 611, 556, 778, 556, 556, 500]))
_W["½"] = 834
CAP = 0.718  # cap height per em


def text_width(text, cap):
    """Width of text set with capitals `cap` tall (any unit; the result is in the same unit)."""
    em = cap / CAP
    return sum(_W.get(ch, 600) for ch in text) / 1000 * em
