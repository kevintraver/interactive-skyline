"""Run a Python script in a fresh, headless Blender process.

    python run_blender.py SCRIPT.py [--blend FILE.blend] [--blender PATH] [--timeout SEC] [-- SCRIPT ARGS...]

Each run is its own process with factory settings (no user add-ons, no startup file), so it never
touches a Blender window the user has open, and two runs can go side by side. A Python exception in
the script makes this exit non-zero (Blender's --python-exit-code), so a failed build is never silent.

Blender is found from --blender, then the BLENDER environment variable, then PATH, then the usual
install folders (the newest version wins).
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import threading

# lines Blender prints on every headless start that say nothing about the script
NOISE = re.compile(r"^(Blender \d|Read prefs|Color management|Warning: Unable to find|"
                   r"Read blend:|AL lib|found bundled python|\s*$)")


def version_key(path: str) -> tuple[int, ...]:
    match = re.search(r"Blender[ _-]?(\d+(?:\.\d+)*)", path)
    return tuple(int(p) for p in match.group(1).split(".")) if match else (0,)


def find_blender(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("BLENDER"), shutil.which("blender")]
    patterns = [
        r"C:\Program Files\Blender Foundation\Blender*\blender.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Blender Foundation\Blender*\blender.exe"),
        r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe",
        "/Applications/Blender*.app/Contents/MacOS/Blender",
        "/usr/bin/blender", "/snap/bin/blender", os.path.expanduser("~/blender*/blender"),
    ]
    for pattern in patterns:
        candidates += sorted(glob.glob(pattern), key=version_key, reverse=True)
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise SystemExit("Blender not found. Pass --blender PATH or set the BLENDER environment variable.")


def main() -> int:
    argv = sys.argv[1:]
    script_args: list[str] = []
    if "--" in argv:
        cut = argv.index("--")
        argv, script_args = argv[:cut], argv[cut + 1:]
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("script", help="Python script to run inside Blender")
    parser.add_argument("--blend", help="open this .blend before running the script")
    parser.add_argument("--blender", help="path to the Blender executable")
    parser.add_argument("--timeout", type=float, default=900, help="seconds before the run is stopped (default 900)")
    parser.add_argument("--verbose", action="store_true", help="also print Blender's start-up noise")
    args = parser.parse_args(argv)

    script = os.path.abspath(args.script)
    if not os.path.isfile(script):
        raise SystemExit(f"script not found: {script}")
    blender = find_blender(args.blender)
    cmd = [blender, "--background", "--factory-startup"]
    if args.blend:
        if not os.path.isfile(args.blend):
            raise SystemExit(f"blend file not found: {args.blend}")
        cmd.append(os.path.abspath(args.blend))
    # the skill's scripts folder goes last on sys.path: a script that has no landmark_kit.py beside it imports the
    # skill's copy, while one that has its own (pinned to the version it was built with) keeps using that
    kit_dir = os.path.dirname(os.path.abspath(__file__))
    cmd += ["--python-exit-code", "1", "--python-expr", f"import sys; sys.dont_write_bytecode = True; sys.path.append({kit_dir!r})",
            "--python", script, "--", *script_args]
    print(f"[run_blender] {os.path.basename(blender)} ({os.path.dirname(blender)}) -> {os.path.basename(script)}",
          flush=True)
    try:
        # keep the caller's working directory, so relative paths in the script's arguments mean what they say
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace")
    except OSError as err:
        raise SystemExit(f"could not start Blender: {err}") from err
    timed_out = threading.Event()
    def stop() -> None:
        timed_out.set()
        proc.kill()
    watchdog = threading.Timer(args.timeout, stop)  # reading the output blocks, so the clock runs on its own
    watchdog.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if args.verbose or not NOISE.match(line):
                sys.stdout.write(line)
        code = proc.wait()
    finally:
        watchdog.cancel()
    if timed_out.is_set():
        print(f"[run_blender] stopped after {args.timeout:.0f} s", flush=True)
        return 124
    print(f"[run_blender] exit code {code}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
