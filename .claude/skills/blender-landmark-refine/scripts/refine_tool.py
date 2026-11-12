"""Deterministic steps of a refine pass on a model folder made by blender-landmark-model.

    python refine_tool.py start    MODEL [--copy]
    python refine_tool.py compare  MODEL [--tag before|after|NAME] [--photos IMG ...] [--photo NAME:BEARING:ELEV:LENS[:TARGET_Z]] ...
    python refine_tool.py gate     MODEL [--complex] [--max-tris N] [--allow-height-change]
    python refine_tool.py finalize MODEL --repo REPO --city lv --id ID [--offset E,N] [--complex] [--install-copy]
    python refine_tool.py restore  MODEL [--backup DIR]
    python refine_tool.py backup   MODEL

start     backs up the folder (build script, kit, spec, parts, JSON inputs, GLB, blend, report) into
          MODEL/backups/<time>/, refreshes landmark_kit.py from blender-landmark-model (new helpers, same
          output for old scripts), and records the pass in MODEL/.refine.json. In place (default) you edit
          MODEL/build_<stem>.py; with --copy the pass works in MODEL/refined/ and the original stays untouched
          until you decide.
compare   renders the work folder's model (elevations, iso, photo-matched views; day and night) and puts
          them next to the reference photos in WORK/compare-<tag>/compare.jpg.
gate      pass/fail: triangle budget (5,000; 8,000 with --complex), _GLOW on every primitive, no COLOR_0,
          no mesh errors in the build report, top within 1% of the version before the pass.
finalize  gate, then install into REPO and run the app check by day and night (auto camera bearing). If
          either fails, the backup is restored and reinstalled, and the exit code is 1. In --copy mode it
          installs only with --install-copy (otherwise it stops after the gate and says where the result is).
restore   puts the recorded (or given) backup back into MODEL.

Blender only ever runs headless, through blender-landmark-model's run_blender.py.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_SKILL = os.environ.get("BLENDER_LANDMARK_MODEL_SKILL") or os.path.normpath(
    os.path.join(HERE, "..", "..", "blender-landmark-model"))
SCRIPTS = os.path.join(BUILD_SKILL, "scripts")
STATE = ".refine.json"
BUDGET, COMPLEX_BUDGET = 5_000, 8_000
SKIP_DIRS = {"backups", "refined", "renders", "app-check", "refs", "research", "__pycache__", "work"}


def py(script: str, *args: str, check: bool = False, quiet: bool = False) -> subprocess.CompletedProcess:
    cmd = [sys.executable, "-I", os.path.join(SCRIPTS, script), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not quiet:
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr[-2000:])
    if check and proc.returncode != 0:
        raise SystemExit(f"{script} failed (exit {proc.returncode})")
    return proc


def stem_of(model: str) -> str:
    builds = [f[6:-3] for f in os.listdir(model) if f.startswith("build_") and f.endswith(".py")]
    if len(builds) != 1:
        raise SystemExit(f"{model}: expected exactly one build_<stem>.py, found {builds or 'none'}")
    return builds[0]


def inputs(folder: str) -> list[str]:
    """The files a build reads: scripts and JSON inputs (not outputs or the pass's own state)."""
    names = []
    for f in os.listdir(folder):
        path = os.path.join(folder, f)
        if os.path.isfile(path) and (f.endswith(".py") or (f.endswith(".json") and not f.endswith(".report.json")
                                                           and f not in (STATE, "refine-log.json"))):
            names.append(f)
    return sorted(names)


def outputs(folder: str, stem: str) -> list[str]:
    return [f for f in (f"{stem}.glb", f"{stem}.blend", f"{stem}.report.json") if os.path.exists(os.path.join(folder, f))]


def load_state(model: str) -> dict:
    path = os.path.join(model, STATE)
    if not os.path.exists(path):
        raise SystemExit(f"{model}: no refine pass started; run `refine_tool.py start {model}` first")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_state(model: str, state: dict) -> None:
    with open(os.path.join(model, STATE), "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)


# ----------------------------------------------------------------- commands
def backup(model: str) -> str:
    stem = stem_of(model)
    dest = os.path.join(model, "backups", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(dest, exist_ok=False)
    for f in inputs(model) + outputs(model, stem):
        shutil.copy2(os.path.join(model, f), dest)
    print(f"backup: {dest} ({len(os.listdir(dest))} files)")
    return dest


def start(model: str, copy: bool) -> int:
    model = os.path.abspath(model)
    stem = stem_of(model)
    if not os.path.exists(os.path.join(model, f"{stem}.glb")):
        raise SystemExit(f"{model}: no {stem}.glb to refine; build it with blender-landmark-model first")
    saved = backup(model)
    work = os.path.join(model, "refined") if copy else model
    if copy:
        os.makedirs(work, exist_ok=True)
        for f in inputs(model) + outputs(model, stem):
            shutil.copy2(os.path.join(model, f), work)
    shutil.copy2(os.path.join(SCRIPTS, "landmark_kit.py"), os.path.join(work, "landmark_kit.py"))
    state = {"mode": "copy" if copy else "in-place", "stem": stem, "work": work, "backup": saved,
             "started": time.strftime("%Y-%m-%d %H:%M:%S"), "previous_glb": os.path.join(saved, f"{stem}.glb")}
    save_state(model, state)
    print(f"mode: {state['mode']}; edit {os.path.join(work, f'build_{stem}.py')}")
    print(f"rebuild: python {os.path.join(SCRIPTS, 'run_blender.py')} \"{os.path.join(work, f'build_{stem}.py')}\" "
          f"-- --out \"{work}\"")
    return 0


def compare(model: str, tag: str, photos: list[str], photo_views: list[str], views: str) -> int:
    model = os.path.abspath(model)
    state = load_state(model)
    work, stem = state["work"], state["stem"]
    blend = os.path.join(work, f"{stem}.blend")
    if not os.path.exists(blend):
        raise SystemExit(f"no {blend}; rebuild first")
    out = os.path.join(work, f"compare-{tag}")
    args = ["--blend", blend, "--", "--out", out, "--views", views, "--modes", "day,night", "--size", "900"]
    for spec in photo_views:
        args += ["--photo", spec]
    py("run_blender.py", os.path.join(SCRIPTS, "render_views.py"), *args, check=True, quiet=True)
    if not photos:
        photos = sorted(glob.glob(os.path.join(model, "refs", "*.jp*g")))[:4]
    day = [os.path.join(out, f"{v}_day.png") for v in views.split(",")]
    day += [os.path.join(out, f"{s.split(':')[0]}_day.png") for s in photo_views]
    night = [os.path.join(out, f"{v}_night.png") for v in ("iso",) if os.path.exists(os.path.join(out, f"{v}_night.png"))]
    images = [p for p in photos + day + night if os.path.exists(p)]
    py("refs.py", "sheet", "--out", os.path.join(out, "compare.jpg"), "--cols", "4", "--cell", "380", *images,
       check=True, quiet=True)
    print(f"compare sheet: {os.path.join(out, 'compare.jpg')}  ({len(photos)} photos, {len(images) - len(photos)} renders)")
    return 0


def gate(model: str, complex_model: bool, max_tris: int | None, allow_height_change: bool) -> tuple[bool, list[str]]:
    model = os.path.abspath(model)
    state = load_state(model)
    work, stem = state["work"], state["stem"]
    sys.path.insert(0, SCRIPTS)
    sys.dont_write_bytecode = True
    from check_glb import summarize  # noqa: E402
    problems: list[str] = []
    glb, report_path = os.path.join(work, f"{stem}.glb"), os.path.join(work, f"{stem}.report.json")
    if not os.path.exists(glb):
        return False, [f"no {glb}"]
    s = summarize(glb)
    budget = max_tris or (COMPLEX_BUDGET if complex_model else BUDGET)
    if s["tris"] > budget:
        problems.append(f"{s['tris']} triangles, over the budget of {budget}")
    problems += s["errors"]  # includes COLOR_0, missing POSITION/NORMAL
    if any(m["glow_max"] is None for m in s["materials"]):
        problems.append("a primitive has no _GLOW")
    if os.path.exists(report_path):
        with open(report_path, encoding="utf-8") as fh:
            report = json.load(fh)
        problems += [f"mesh: {e}" for e in report.get("errors", [])]
        if report.get("open_islands"):
            problems.append(f"mesh: {report['open_islands']} islands are not closed")
    else:
        problems.append(f"no {report_path}")
    previous = state.get("previous_glb")
    if previous and os.path.exists(previous) and not allow_height_change:
        before, after = summarize(previous)["bbox_max"]["up"], s["bbox_max"]["up"]
        if abs(after - before) > 0.01 * before:
            problems.append(f"top moved from {before:.1f} m to {after:.1f} m (more than 1%; pass --allow-height-change "
                            "if that is a deliberate correction)")
    print(f"gate: {s['tris']} tris (budget {budget}), top {s['bbox_max']['up']:.1f} m, "
          f"{s['primitives']} primitives -> {'PASS' if not problems else 'FAIL'}")
    for p in problems:
        print(f"  - {p}")
    return not problems, problems


def restore(model: str, backup_dir: str | None) -> int:
    model = os.path.abspath(model)
    if backup_dir is None:
        state_path = os.path.join(model, STATE)
        if os.path.exists(state_path):
            backup_dir = load_state(model)["backup"]
        else:
            dirs = sorted(glob.glob(os.path.join(model, "backups", "*")))
            if not dirs:
                raise SystemExit("no backups to restore")
            backup_dir = dirs[-1]
    for f in os.listdir(backup_dir):
        shutil.copy2(os.path.join(backup_dir, f), os.path.join(model, f))
    print(f"restored {len(os.listdir(backup_dir))} files from {backup_dir}")
    return 0


def repo_offset(repo: str, city: str, bid: str) -> str | None:
    path = os.path.join(repo, "public", "models", "models.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            entry = json.load(fh).get(city, {}).get(bid)
        if entry:
            return ",".join(str(v) for v in entry.get("offset", [0, 0]))
    return None


def app_check(repo: str, city: str, bid: str, out: str, shots: list[str]) -> bool:
    args = ["check", "--repo", repo, "--city", city, "--id", bid, "--out", out]
    for spec in shots or ["day:day:auto:24:2.0:0.5", "night:night:auto:24:2.0:0.5", "top-day:day:auto:18:0.8:0.8"]:
        args += ["--shot", spec]
    return py("skyline_tool.py", *args).returncode == 0


def finalize(model: str, repo: str, city: str, bid: str, offset: str | None, complex_model: bool,
             allow_height_change: bool, install_copy: bool, shots: list[str]) -> int:
    model, repo = os.path.abspath(model), os.path.abspath(repo)
    state = load_state(model)
    work, stem = state["work"], state["stem"]
    offset = offset or repo_offset(repo, city, bid) or "0,0"
    passed, problems = gate(model, complex_model, None, allow_height_change)
    log_entry = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "mode": state["mode"], "gate": problems}

    def revert(reason: str) -> int:
        print(f"REVERTING: {reason}")
        # keep the failed attempt (its edited script too), so the work can be picked up again
        stash = os.path.join(model, "backups", time.strftime("%Y%m%d-%H%M%S") + "-failed")
        os.makedirs(stash, exist_ok=True)
        for f in inputs(work) + outputs(work, stem):
            shutil.copy2(os.path.join(work, f), stash)
        print(f"failed attempt kept in {stash}")
        log_entry["failed_attempt"] = stash
        if state["mode"] == "in-place":
            restore(model, state["backup"])
        previous = state["previous_glb"]
        py("skyline_tool.py", "install", "--repo", repo, "--city", city, "--id", bid, "--glb", previous,
           "--offset", offset, quiet=True)
        ok = app_check(repo, city, bid, os.path.join(work, "app-check-reverted"), shots)
        print(f"previous model reinstalled; its check {'passed' if ok else 'ALSO FAILED: look at the repo'}")
        log_entry.update(result="reverted", reason=reason)
        write_log(model, log_entry)
        return 1

    if not passed:
        return revert("gate failed")
    if state["mode"] == "copy" and not install_copy:
        print(f"copy mode: refined model at {os.path.join(work, stem + '.glb')}; compare it with the original, then "
              "rerun finalize with --install-copy to install it")
        log_entry.update(result="gated, not installed")
        write_log(model, log_entry)
        return 0
    py("skyline_tool.py", "install", "--repo", repo, "--city", city, "--id", bid,
       "--glb", os.path.join(work, f"{stem}.glb"), "--offset", offset, check=True, quiet=True)
    if not app_check(repo, city, bid, os.path.join(work, "app-check-refined"), shots):
        return revert("app check failed")
    log_entry.update(result="installed", sheet=os.path.join(work, "app-check-refined", "sheet.jpg"))
    write_log(model, log_entry)
    print(f"FINALIZED: installed and checked; sheet {os.path.join(work, 'app-check-refined', 'sheet.jpg')}")
    return 0


def write_log(model: str, entry: dict) -> None:
    path = os.path.join(model, "refine-log.json")
    log = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            log = json.load(fh)
    log.append(entry)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(log, fh, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("start"); p.add_argument("model"); p.add_argument("--copy", action="store_true")
    p = sub.add_parser("backup"); p.add_argument("model")
    p = sub.add_parser("restore"); p.add_argument("model"); p.add_argument("--backup")
    p = sub.add_parser("compare"); p.add_argument("model"); p.add_argument("--tag", default="current")
    p.add_argument("--photos", nargs="*", default=[]); p.add_argument("--photo", action="append", default=[])
    p.add_argument("--views", default="south,east,iso")
    p = sub.add_parser("gate"); p.add_argument("model"); p.add_argument("--complex", action="store_true")
    p.add_argument("--max-tris", type=int); p.add_argument("--allow-height-change", action="store_true")
    p = sub.add_parser("finalize"); p.add_argument("model"); p.add_argument("--repo", required=True)
    p.add_argument("--city", required=True); p.add_argument("--id", required=True); p.add_argument("--offset")
    p.add_argument("--complex", action="store_true"); p.add_argument("--allow-height-change", action="store_true")
    p.add_argument("--install-copy", action="store_true"); p.add_argument("--shot", action="append", default=[])
    args = parser.parse_args()
    if not os.path.isdir(SCRIPTS):
        raise SystemExit(f"blender-landmark-model not found at {BUILD_SKILL}; set BLENDER_LANDMARK_MODEL_SKILL")
    if args.cmd == "start":
        return start(args.model, args.copy)
    if args.cmd == "backup":
        backup(os.path.abspath(args.model))
        return 0
    if args.cmd == "restore":
        return restore(args.model, args.backup)
    if args.cmd == "compare":
        return compare(args.model, args.tag, args.photos, args.photo, args.views)
    if args.cmd == "gate":
        return 0 if gate(args.model, args.complex, args.max_tris, args.allow_height_change)[0] else 1
    return finalize(args.model, args.repo, args.city, args.id, args.offset, args.complex, args.allow_height_change,
                    args.install_copy, args.shot)


if __name__ == "__main__":
    sys.exit(main())
