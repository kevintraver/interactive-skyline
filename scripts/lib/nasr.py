"""The FAA NASR 28-day subscription's airport CSV bundle: which cycle, where it is, and reading its rows.

Bundle: https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip (US government work), e.g. the
cycle effective 29 October 2026 (downloaded 2026-11-23). Cycles are 28 days apart. Files used: APT_BASE.csv,
APT_RWY.csv, APT_RWY_END.csv; column names as in that cycle's APT_CSV_DATA_STRUCTURE.csv.
"""
import csv
import io
import zipfile
from datetime import date, timedelta
from pathlib import Path

FILES = ("APT_BASE", "APT_RWY", "APT_RWY_END")
KNOWN_CYCLE = date(2026, 10, 29)
FT = 0.3048


def cycle_for(day: date) -> date:
    """The NASR cycle in effect on `day`."""
    k = (day - KNOWN_CYCLE).days // 28
    return KNOWN_CYCLE + timedelta(days=28 * k)


def zip_url(cycle: date) -> str:
    return f"https://nfdc.faa.gov/webContent/28DaySub/extra/{cycle.day:02d}_{cycle:%b}_{cycle.year}_APT_CSV.zip"


def _rows(text, faa):
    return [r for r in csv.DictReader(io.StringIO(text)) if faa is None or r["ARPT_ID"] == faa]


def read_zip(path, faa):
    """{file stem: [rows]} for one airport from the bundle zip."""
    with zipfile.ZipFile(path) as z:
        return {f: _rows(z.read(f"{f}.csv").decode("utf-8-sig", errors="replace"), faa) for f in FILES}


def read_dir(path, faa=None):
    """{file stem: [rows]} from a folder of the three CSV files (the tests' committed extract)."""
    path = Path(path)
    return {f: _rows((path / f"{f}.csv").read_text(encoding="utf-8-sig"), faa) for f in FILES}


def num(v):
    v = (v or "").strip()
    return float(v) if v else None


def flag(v):
    return (v or "").strip().upper() == "Y"


def vgsi(code):
    """A visual glide slope indicator code (P4L, P2R, V4L, ...) as type, light count and side."""
    code = (code or "").strip().upper()
    if len(code) < 3 or code[0] not in "PV" or not code[1].isdigit():
        return None
    return {"type": "PAPI" if code[0] == "P" else "VASI", "lights": int(code[1]),
            "side": {"L": "left", "R": "right"}.get(code[-1], code[-1].lower())}


MARKING_KINDS = {"PIR": "precision", "NPI": "non-precision", "BSC": "basic", "NRS": "numbers-only",
                 "NSTD": "non-standard", "BUOY": "buoys", "STOL": "stol", "NONE": None}
INTENSITY = {"HIGH": "high", "MED": "medium", "LOW": "low", "NSTD": "non-standard", "PERI": "perimeter",
             "STRB": "strobe", "FLD": "flood", "NONE": None}
PAVEMENT = {"R": "rigid", "F": "flexible"}
# Approach light systems: base system and length (ft) from FAA Order JO 6850.2C; F = sequenced flashers,
# R = runway alignment indicator lights (RAIL), which carry the system out to its longer length.
APPROACH = {"ALSAF": ("ALSF", 3000, True, False), "ALSF1": ("ALSF-1", 2400, True, False),
            "ALSF2": ("ALSF-2", 2400, True, False), "MALS": ("MALS", 1400, False, False),
            "MALSF": ("MALS", 1400, True, False), "MALSR": ("MALS", 2400, True, True),
            "SSALS": ("SSALS", 1400, False, False), "SSALF": ("SSALS", 1400, True, False),
            "SSALR": ("SSALS", 2400, True, True), "SALS": ("SALS", 1500, False, False),
            "SALSF": ("SALS", 1500, True, False), "ODALS": ("ODALS", 1500, True, False)}
BEACON = {"W": "white", "G": "green", "Y": "yellow"}


def marking_kind(code):
    """A runway end's marking type code (PIR, NPI, BSC, ...) as a word; None for none or unknown."""
    return MARKING_KINDS.get((code or "").strip().upper())


def light_intensity(code):
    """A runway's edge light code (HIGH, MED, LOW, ...) as a word; None for none or unknown."""
    return INTENSITY.get((code or "").strip().upper())


def approach_lights(code):
    """An approach light system code as {code, system, lengthFt, flashers, rail}; None for none.

    MALSR is listed with its flashers because the FAA's MALSR has sequenced flashers on the RAIL. An unknown code
    gives the code with the rest unknown (None)."""
    code = (code or "").strip().upper()
    if not code or code == "NONE":
        return None
    system, length, flashers, rail = APPROACH.get(code, (None, None, None, None))
    return {"code": code, "system": system, "lengthFt": length, "flashers": flashers, "rail": rail}


def beacon_colours(code):
    """A beacon lens colour code ('WG', 'SWG', 'WY', ...) as the colours of one rotation; 'S' (split white, the
    military's two-peaked white) adds a second white."""
    code = (code or "").strip().upper()
    out = ["white"] if code.startswith("S") else []
    return out + [BEACON[c] for c in code.lstrip("S") if c in BEACON]


def beacon_rate(code):
    """Flashes a minute, [low, high], of a land airport's beacon (AIM 2-1-9: 24 to 30); None if not one."""
    return [24, 30] if beacon_colours(code) in (["white", "green"], ["white", "white", "green"]) else None


def end_name(nasr_id):
    """'01L' -> '1L', '19R' -> '19R'."""
    nasr_id = nasr_id.strip()
    return nasr_id.lstrip("0") or nasr_id
