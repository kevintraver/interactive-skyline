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


def end_name(nasr_id):
    """'01L' -> '1L', '19R' -> '19R'."""
    nasr_id = nasr_id.strip()
    return nasr_id.lstrip("0") or nasr_id
