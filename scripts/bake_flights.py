# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "requests"]
# ///
"""Usage: bake_flights.py <city> [--check] [--allow-fail]

Bake every flight selected in data/flights/<city>/selection.json from what the repository holds, with no network
(plan 03, F2.7): the single-aircraft extracts (raw/<id>.trace.json.gz), the weather the bake reads
(weather/<id>.json) and the published approaches (cifp-<ICAO>.json). Writes the served files and the QA reports, and
checks them on the way:

  - every quality gate of section 7.2 and the procedure check pass (unless --allow-fail);
  - the header and binary agree (format, channels, samples x channels x 4 bytes), the binary stays under 400 KB;
  - nothing served names the aircraft or its operator (ICAO address, registration, callsign).

  Output  public/data/<city>/flights/<id>.json, <id>.bin, index.json
          data/flights/<city>/qa/<id>.json

--check bakes into memory and compares with the files on disk byte for byte instead of writing (exit 1 on any
difference): the committed files are what this command makes from the committed inputs.
"""
import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_flight  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MAX_BIN = 400_000


def served_bytes(baked):
    blob = b"".join(baked.channels[k].astype("<f4").tobytes() for k in bake_flight.CHANNELS)
    head = (json.dumps(baked.header, indent=1) + "\n").encode()
    return head, blob


def identifiers(sel_dir, f):
    """What must never be served for a flight: its ICAO address, and the registration and callsigns in its extract."""
    out = {f["icao"].lower()}
    files = json.loads(gzip.decompress((sel_dir / f["raw"]).read_bytes()))
    for tr in files if isinstance(files, list) else [files]:
        if tr.get("r"):
            out.add(tr["r"].lower())
        for pt in tr.get("trace", []):
            st = pt[8] if len(pt) > 8 else None
            if isinstance(st, dict) and (st.get("flight") or "").strip():
                out.add(st["flight"].strip().lower())
    return {s for s in out if len(s) >= 3}


def guards(f, baked, head, blob, sel_dir):
    problems = []
    h = baked.header
    if h["format"] != bake_flight.FORMAT or h["channels"] != bake_flight.CHANNELS:
        problems.append("format or channels")
    if len(blob) != h["samples"] * len(h["channels"]) * 4:
        problems.append("binary size does not match the header")
    if len(blob) >= MAX_BIN:
        problems.append(f"binary {len(blob)} bytes >= {MAX_BIN}")
    text = head.decode().lower()
    for ident in identifiers(sel_dir, f):
        if ident in text:
            problems.append(f"served header names the aircraft ({ident!r})")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--allow-fail", action="store_true")
    a = ap.parse_args()
    sel_dir = ROOT / "data" / "flights" / a.city
    out_dir = ROOT / "public" / "data" / a.city / "flights"
    done, index = bake_flight.bake_selected(a.city, offline=True, write=False)
    failed, differ = [], []
    for f, baked in done:
        head, blob = served_bytes(baked)
        qa_bytes = (json.dumps(baked.report["qa"], indent=1) + "\n").encode()
        problems = guards(f, baked, head, blob, sel_dir)
        if not baked.report["qa"]["pass"] and not a.allow_fail:
            bad = {k: g["value"] for k, g in baked.report["qa"]["gates"].items() if not g["pass"]}
            if not baked.report["qa"]["procedure"]["pass"]:
                bad["procedure"] = baked.report["qa"]["procedure"]["diffDeg"]
            problems.append(f"quality gates: {bad}")
        if problems:
            failed.append((f["id"], problems))
        targets = {out_dir / f"{f['id']}.json": head, out_dir / f"{f['id']}.bin": blob,
                   sel_dir / "qa" / f"{f['id']}.json": qa_bytes}
        for path, data in targets.items():
            if a.check:
                if not path.exists() or path.read_bytes() != data:
                    differ.append(str(path.relative_to(ROOT)))
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        q = baked.header["qa"]
        print(f"{f['id']}: {baked.header['runway']} {baked.header['aircraftType']} {baked.header['samples']} samples, "
              f"glide {q['glidePathDeg']} (published {baked.report['qa']['procedure']['nearestPublishedDeg']}), "
              f"{'pass' if baked.report['qa']['pass'] else 'FAIL'}")
    index_bytes = (json.dumps(index, indent=1) + "\n").encode()
    index_path = out_dir / "index.json"
    if a.check:
        if not index_path.exists() or index_path.read_bytes() != index_bytes:
            differ.append(str(index_path.relative_to(ROOT)))
    else:
        index_path.write_bytes(index_bytes)
    for fid, problems in failed:
        print(f"{fid}: " + "; ".join(problems))
    if differ:
        print("differs from the files on disk: " + ", ".join(differ))
    if failed or differ:
        raise SystemExit(1)
    print(f"{len(done)} flights {'reproduced byte for byte' if a.check else 'baked'}")


if __name__ == "__main__":
    main()
