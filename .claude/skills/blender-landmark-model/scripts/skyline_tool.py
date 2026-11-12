"""Put a landmark model into interactive-skyline (github.com/kevintraver/interactive-skyline) and check it.

    python skyline_tool.py find    --repo REPO --city lv --name "strat"
    python skyline_tool.py footprint --repo REPO --city lv --id w134068318 --out footprint.json
    python skyline_tool.py locate  --repo REPO --city lv --lat 36.1175 --lon -115.1682
    python skyline_tool.py install --repo REPO --city lv --id w135457469 --glb strat.glb [--offset 3.2,0.8]
    python skyline_tool.py install --repo REPO --city lv --extra "High Roller" --glb high_roller.glb
                                   --east 455 --north -60 [--rotation DEG] [--visible night] [--blend additive]
                                   [--spin-period S [--spin-direction -1] [--spin-node Rotor]]
    python skyline_tool.py upgrade --repo REPO --city lv
    python skyline_tool.py check   --repo REPO --city lv --id w135457469 --out DIR [--shot ...]
    python skyline_tool.py check   --repo REPO --city lv --extra "High Roller" --out DIR [--shot ...]

find     lists matching buildings with what is needed to place a model: id, height, ground elevation, the
         footprint's center (`c`, the point a model's origin is placed at, plus `offset`), footprint size
         and orientation, and any hand-measured override with its reason (data/overrides.json).
locate   converts latitude/longitude to the app's local meters (east, north of the city origin).
install  adds the model loader, night mode, extras, fountain shows and LED surfaces to the repo if they are
         missing or older (assets/skyline; upgrades v3/v4 integrations to v5), copies the GLB to
         public/models/, and lists it in public/models/models.json: a building model under its id, or with
         --extra a structure that is not a building in the app's data (a canopy, a wheel, a light beam),
         placed on the terrain at --east/--north (m from the city origin), turned --rotation degrees
         counter-clockwise from east, shown always or only at night; --spin-period turns its Rotor node (a
         wheel built to high_roller/SPIN_CONTRACT.md) once every S seconds. It never commits.
upgrade  does install's integration part alone (pristine repo, or v3/v4/v5 -> v6), touching no model entry.
check    serves the repo itself (no Node, no Vite, nothing written into the repo) on a local port, opens it
         in headless Edge or Chrome with a throwaway profile, frames the building (or with --extra the extra
         or fountain of that name), and saves screenshots by day and by night plus a report of what the app
         built and any console errors. three.js comes from the repo's node_modules when present, otherwise
         from the jsDelivr CDN at the repo's version. Fountain shows and LED skins are held at --show-time
         seconds into their loop, so shots are repeatable.

Shot spec for --shot: LABEL:MODE:BEARING:ELEVATION:DIST:TARGET[:HIGHLIGHT]
  MODE day|night; BEARING compass direction from the building to the camera (0 = north), or "auto" to let
  the probe pick the side from which neighbors hide the least of the building;
  ELEVATION camera angle above the horizontal (degrees); DIST and TARGET as multiples of the building's
  height (camera distance, and the height it aims at); HIGHLIGHT 1 shows the app's blue "removable" tint.
  For an extra, DIST is a multiple of its size (the larger of its height and half its width) and TARGET of
  its height.
"""
from __future__ import annotations

import argparse
import functools
import html
import http.server
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(SKILL_DIR, "assets", "skyline")
DEFAULT_SHOTS = [  # seen from above the neighbors (the Strip is dense): whole building, its top, and a wide view
    "day:day:200:28:2.2:0.45",
    "night:night:200:28:2.2:0.45",
    "top-night:night:200:22:0.8:0.8",
    "wide-night:night:215:30:5:0.3",
    "highlight:day:200:28:2.2:0.45:1",
]
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
]
INTEGRATION = 6  # `// skyline-integration: vN` is the first line of every integration file in src/
INTEGRATION_VERSION = f"skyline-integration: v{INTEGRATION}"
INTEGRATION_FILES = ("night.js", "attractions.js", "fountain.js")  # copied as they are; customModels.js aside
# fountain shows that ship with the skill, per city (assets/skyline/attractions/<file>)
BUNDLED_FOUNTAINS = {"lv": [{"name": "Fountains of Bellagio", "file": "bellagio.json"}]}
CONSOLE_NOISE = ("Permissions-Policy", "[vite]", "DevTools", "Download the React", "chrome-extension://")
DEFAULT_SHOW_TIME = 47.0  # s into the fountain loop: oarsmen crossing, rings up, shooters chasing down the line

# src/main.js hooks, as the patch writes them (an upgrade inserts whichever are missing)
GLOW_LINE = "  if (out.glow) geo.setAttribute('glow', new THREE.Float32BufferAttribute(out.glow, 3));"
WINDOWS_LINE = "  if (out.win) geo.setAttribute('windows', new THREE.Float32BufferAttribute(out.win, 1));"
LED_LINE = "  if (out.led) geo.setAttribute('led', new THREE.Float32BufferAttribute(out.led, 1));"
ATTRACTIONS_IMPORT = "import { initAttractions } from './attractions.js';"
ATTRACTIONS_CALL = [
    "// extras, the fountain show and animated LED surfaces (skyline-integration v5, src/attractions.js)",
    "initAttractions({ cityId, scene, camera, renderer, settings, invalidate, groundY, tall });",
]
CUTOFF_TEST = "if (b.h >= settings.cutoff) {"  # buildCity: removable buildings (and models) only
CUTOFF_TEST_V6 = "if (b.h >= settings.cutoff || customModels.has(b.id)) {"
CALL_NAMES = ("cityId", "scene", "camera", "renderer", "settings", "invalidate", "groundY", "tall")


# ------------------------------------------------------------------- repo data
def load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def check_repo(repo: str, city: str) -> None:
    for rel in ("src/main.js", "index.html", f"public/data/{city}/buildings.json"):
        if not os.path.exists(os.path.join(repo, rel)):
            raise SystemExit(f"{repo} does not look like interactive-skyline (no {rel}); check --repo and --city")


def footprint_facts(volumes: list[dict], c: list[float]) -> dict:
    """Size and orientation of the ground-level outline, from the building's volumes."""
    ground = min(v["b"] for v in volumes)
    rings = [v["o"] for v in volumes if v["b"] <= ground + 1] or [v["o"] for v in volumes]
    pts = [(r[i] - c[0], r[i + 1] - c[1]) for r in rings for i in range(0, len(r), 2)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    longest, bearing = 0.0, None
    for r in rings:
        n = len(r) // 2
        for i in range(n):
            x0, y0, x1, y1 = r[2 * i], r[2 * i + 1], r[2 * ((i + 1) % n)], r[2 * ((i + 1) % n) + 1]
            length = math.hypot(x1 - x0, y1 - y0)
            if length > longest:
                longest, bearing = length, math.degrees(math.atan2(x1 - x0, y1 - y0)) % 180
    return {"east_extent": [round(min(xs), 1), round(max(xs), 1)], "north_extent": [round(min(ys), 1), round(max(ys), 1)],
            "longest_edge_m": round(longest, 1), "longest_edge_bearing": None if bearing is None else round(bearing, 1)}


def find(repo: str, city: str, name: str | None, bid: str | None, limit: int) -> int:
    check_repo(repo, city)
    data = load_json(os.path.join(repo, "public", "data", city, "buildings.json"))
    cities = load_json(os.path.join(repo, "public", "data", "cities.json"))
    overrides_path = os.path.join(repo, "data", "overrides.json")
    overrides = load_json(overrides_path) if os.path.exists(overrides_path) else {}
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    manifest = load_json(manifest_path).get(city, {}) if os.path.exists(manifest_path) else {}
    matches = [b for b in data["buildings"]
               if (bid and b["id"] == bid) or (name and name.lower() in (b.get("name") or "").lower())]
    matches.sort(key=lambda b: -b["h"])
    info = cities.get(city, {})
    print(f"{info.get('name', city)}: origin {info.get('origin')} ({info.get('originNote', '')}); "
          f"base elevation {info.get('base')} m; removable above {data.get('tallCutoff')} m by default")
    if not matches:
        print("no building matches; try a shorter --name")
        return 1
    for b in matches[:limit]:
        print(f"\n{b['id']}  {b.get('name') or '(unnamed)'}")
        print(f"  height {b['h']} m ({b['src']}), ground {b['ground']} m, center c = {b['c']} (m east, north of origin)")
        if b["id"].startswith(("w", "r")):
            kind = "way" if b["id"][0] == "w" else "relation"
            print(f"  OpenStreetMap: https://www.openstreetmap.org/{kind}/{b['id'][1:]}")
        print(f"  footprint relative to c: {footprint_facts(b['v'], b['c'])}")
        for v in b["v"][:12]:
            xs, ys = v["o"][0::2], v["o"][1::2]
            cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
            r = max(math.hypot(x - cx, y - cy) for x, y in zip(xs, ys))
            shape = " leaning/tapering" if "u" in v else (f" roof {v['r']}" if v.get("r") else "")
            print(f"    volume {v['b'] - b['ground']:+.1f}..{v['t'] - b['ground']:.1f} m above ground, "
                  f"center offset ({cx - b['c'][0]:+.1f}, {cy - b['c'][1]:+.1f}), radius {r:.1f}, {len(xs)} corners{shape}")
        if len(b["v"]) > 12:
            print(f"    ... {len(b['v']) - 12} more volumes")
        if b["id"] in overrides:
            o = overrides[b["id"]]
            print(f"  override: {o.get('reason', '')}")
            if "model" in o:
                print(f"  hand-drawn pieces (b/t heights, from/to = [east, north, radius] from c): {json.dumps(o['model'])}")
        if b["id"] in manifest:
            print(f"  already has a model: {manifest[b['id']]}")
    return 0


def locate(repo: str, city: str, lat: float, lon: float) -> int:
    """Latitude/longitude to the app's local meters (east, north of the city origin). The app uses a transverse
    Mercator centered on the origin; within a few km this ellipsoidal approximation is good to well under 1 m."""
    origin = load_json(os.path.join(repo, "public", "data", "cities.json"))[city]["origin"]
    a, e2 = 6378137.0, 6.69437999014e-3  # WGS84
    phi = math.radians(origin["lat"])
    w = math.sqrt(1 - e2 * math.sin(phi) ** 2)
    n_radius, m_radius = a / w, a * (1 - e2) / w ** 3
    east = math.radians(lon - origin["lon"]) * n_radius * math.cos(phi)
    north = math.radians(lat - origin["lat"]) * m_radius
    print(json.dumps({"east": round(east, 1), "north": round(north, 1), "city": city,
                      "note": "meters east and north of the city origin, the app's local frame"}))
    return 0


def footprint(repo: str, city: str, bid: str, out: str) -> int:
    """Write the building's volumes relative to its center `c` (where the app puts a model's origin), so a build
    script can extrude the exact mapped plan and install with offset 0,0."""
    check_repo(repo, city)
    data = load_json(os.path.join(repo, "public", "data", city, "buildings.json"))
    b = next((x for x in data["buildings"] if x["id"] == bid), None)
    if b is None:
        raise SystemExit(f"{bid} is not a building in {city}; use `find` to look it up")
    cx, cy, ground = b["c"][0], b["c"][1], b["ground"]
    def rel(flat: list[float]) -> list[list[float]]:
        return [[round(flat[i] - cx, 2), round(flat[i + 1] - cy, 2)] for i in range(0, len(flat), 2)]
    volumes = [{"bottom": round(v["b"] - ground, 2), "top": round(v["t"] - ground, 2), "outline": rel(v["o"]),
                "holes": [rel(h) for h in v.get("h", [])], **({"roof": v["r"]} if v.get("r") else {}),
                **({"top_outline": rel(v["u"])} if v.get("u") else {})} for v in b["v"]]
    doc = {"id": bid, "name": b.get("name"), "height": b["h"], "height_source": b["src"],
           "frame": "meters east and north of the footprint center c; heights in meters above ground; "
                    "a model built in this frame installs with --offset 0,0",
           "facts": footprint_facts(b["v"], b["c"]), "volumes": volumes}
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
    print(f"{out}: {b.get('name') or bid}, {len(volumes)} volumes, height {b['h']} m ({b['src']}), {doc['facts']}")
    return 0


# --------------------------------------------------------------------- install
def git(repo: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=check)


def legacy_entries(text: str) -> dict:
    """Entries of the older hard-coded MODELS object in customModels.js, to move into models.json."""
    entries: dict[str, dict] = {}
    block = re.search(r"const MODELS = \{(.*?)\n\};", text, re.S)
    if not block:
        return entries
    for city, body in re.findall(r"(\w+):\s*\{(.*?)\n\s*\},", block.group(1), re.S):
        for bid, url, offset in re.findall(r"(\w+):\s*\{\s*url:\s*'([^']+)'(?:,\s*offset:\s*\[([^\]]*)\])?", body):
            entries.setdefault(city, {})[bid] = {
                "url": url, "offset": [float(x) for x in offset.split(",")] if offset else [0, 0]}
    return entries


def file_version(text: str) -> int:
    """The N of a `// skyline-integration: vN` marker, 0 if there is none."""
    match = re.search(r"skyline-integration: v(\d+)", text[:400])
    return int(match.group(1)) if match else 0


def declares(text: str, name: str) -> bool:
    """Is `name` declared at the top level of a module (not indented): `const name =`, `let a = 1, name = 2`,
    `const { name } = ...` or `function name(`? The hook call at the end of main.js can only see those."""
    decl = re.search(rf"^(?:const|let|var)\s[^;\n]*?(?<![\w.]){name}\s*(?:=(?!=)|,|\}})", text, re.M)
    return decl is not None or re.search(rf"^(?:async\s+)?function\s+{name}\b", text, re.M) is not None


def upgrade_main(text: str) -> tuple[str, list[str]]:
    """Insert what an older integration lacks into src/main.js, each step on its own: the `windows` and `led`
    attributes in toGeometry, the attractions import and the initAttractions call at the end (v5), the
    `fountain` and `wheel` settings' defaults, and drawing a building with a model even under the height cutoff
    (v6). Raises SystemExit (writing nothing) when an anchor line is missing."""
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    notes: list[str] = []

    def find(pred) -> int | None:
        return next((i for i, line in enumerate(lines) if pred(line)), None)

    if find(lambda l: "setAttribute('windows'" in l) is None:  # integrated before lit windows on models
        i = find(lambda l: l.strip() == GLOW_LINE.strip())
        if i is None:
            raise SystemExit("src/main.js has the model loader but not the expected toGeometry line; add\n"
                             f"{WINDOWS_LINE}\nafter the line that sets the 'glow' attribute, then rerun install.")
        lines.insert(i + 1, WINDOWS_LINE)
        notes.append("src/main.js: passes the models' `windows` attribute to the night shader")
    has_call = any(l.strip().startswith("initAttractions(") for l in lines)
    has_import = find(lambda l: "from './attractions.js'" in l) is not None
    has_led = find(lambda l: "setAttribute('led'" in l) is not None
    if not (has_call and has_import and has_led):
        night_import = find(lambda l: "from './night.js'" in l)
        windows_line = find(lambda l: "setAttribute('windows'" in l)
        missing = [n for n in CALL_NAMES if not declares(text, n)]
        if night_import is None or windows_line is None or missing:
            raise SystemExit(
                "src/main.js does not have the lines the v5 upgrade hooks onto"
                + (f" (no declaration of {', '.join(missing)})" if missing else "") + ". Add by hand:\n"
                f"  after the night.js import:   {ATTRACTIONS_IMPORT}\n"
                f"  in toGeometry, after 'windows': {LED_LINE.strip()}\n"
                f"  at the very end of the file: {ATTRACTIONS_CALL[1]}\n"
                "and `fountain: true, wheel: true` in DEFAULTS, then rerun install.")
        if not has_led:  # later in the file than the import: insert it first
            lines.insert(windows_line + 1, LED_LINE)
        if not has_import:
            lines.insert(night_import + 1, ATTRACTIONS_IMPORT)
        if not has_call:
            while lines and not lines[-1].strip():
                lines.pop()
            lines += ["", *ATTRACTIONS_CALL, ""]
        notes.append("src/main.js: v5 hooks (attractions import, `led` attribute in toGeometry, initAttractions "
                     "call at the end)")
    defaults = find(lambda l: l.startswith("const DEFAULTS = {"))
    if defaults is not None:
        line = lines[defaults]
        if "fountain:" not in line and "night: false" in line:
            line = line.replace("night: false", "night: false, fountain: true", 1)
        if "wheel:" not in line and "fountain: true" in line:
            line = line.replace("fountain: true", "fountain: true, wheel: true", 1)
        if line != lines[defaults]:
            lines[defaults] = line
            notes.append("src/main.js: the Fountain show and Wheel turns settings are kept between visits")
        if "fountain:" not in line or "wheel:" not in line:
            notes.append("note: DEFAULTS in src/main.js has no `night: false`, so the fountain and wheel settings "
                         "were not added; they still default to on, but are not kept between visits")
    cutoff = find(lambda l: l.strip() == CUTOFF_TEST)
    if cutoff is not None and any("customModels.get(b.id)" in l for l in lines):
        lines[cutoff] = lines[cutoff].replace(CUTOFF_TEST, CUTOFF_TEST_V6, 1)
        notes.append("src/main.js: a building with a model is drawn from it also under the height cutoff")
    elif cutoff is None and not any(CUTOFF_TEST_V6 in l for l in lines):
        notes.append(f"note: src/main.js has no `{CUTOFF_TEST}` line in buildCity, so buildings with a model "
                     "under the height cutoff still draw from their footprint; change it to "
                     f"`{CUTOFF_TEST_V6}` by hand")
    return (nl.join(lines) if notes else text), notes


def ensure_fountains(repo: str, city: str | None) -> list[str]:
    """Copy the fountain shows that ship with the skill for this city and list them in models.json, unless
    the manifest already has a "fountains" entry for the city (an empty list there means none, by choice)."""
    done: list[str] = []
    bundled = BUNDLED_FOUNTAINS.get(city or "", [])
    if not bundled:
        return done
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    manifest = load_json(manifest_path) if os.path.exists(manifest_path) else {}
    shows = manifest.get("fountains", {})
    if not isinstance(shows, dict):
        raise SystemExit(f"{manifest_path}: \"fountains\" should be an object keyed by city")
    folder = os.path.join(repo, "public", "models", "attractions")
    os.makedirs(folder, exist_ok=True)

    def data_version(path: str) -> int:
        try:
            return int(load_json(path).get("version", 0))
        except (OSError, ValueError, AttributeError):
            return -1  # unreadable: replace it
    for show in bundled:
        source, target = os.path.join(ASSETS, "attractions", show["file"]), os.path.join(folder, show["file"])
        # a newer bundled version replaces the repo's copy; an edited copy keeps its place if you bump "version"
        if not os.path.exists(target) or data_version(target) < data_version(source):
            shutil.copyfile(source, target)
            done.append(f"copied the {show['name']} data to public/models/attractions/{show['file']}")
    if city not in shows:
        shows[city] = [{"name": s["name"], "url": f"/models/attractions/{s['file']}"} for s in bundled]
        manifest["fountains"] = shows
        write_manifest(manifest_path, manifest)
        done.append(f"listed {', '.join(s['name'] for s in bundled)} under \"fountains\" in models.json")
    return done


def write_manifest(path: str, manifest: dict) -> None:
    """Write models.json whole: to a temporary file next to it, then swapped in, so a reader never sees half."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = f"{path}.{os.getpid()}.tmp"
    with open(temp, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    try:
        os.replace(temp, path)
    except PermissionError:  # Windows: someone has it open right now; fall back to writing in place
        shutil.copyfile(temp, path)
        os.remove(temp)


def ensure_integration(repo: str, force: bool, city: str | None = None) -> list[str]:
    """Make sure the repo has the current integration: the manifest-based loader, night mode, extras, fountain
    shows and LED surfaces. Applies the patch to a pristine repo and upgrades older integrations in place.
    Returns what was done."""
    done: list[str] = []
    main_path = os.path.join(repo, "src", "main.js")
    main_js = open(main_path, encoding="utf-8", newline="").read()
    # everything that can refuse runs before anything is written, so a refusal leaves the repo as it was
    cm = os.path.join(repo, "src", "customModels.js")
    if os.path.exists(cm) and not force:
        cm_text = open(cm, encoding="utf-8").read()
        if "models.json" not in cm_text and "const MODELS = {" not in cm_text:
            raise SystemExit("src/customModels.js is not a version this tool knows; rerun with --force to replace "
                             "it (a backup is kept in the system temp folder)")
    if "loadCustomModels" in main_js:
        upgrade_main(main_js)  # raises when the anchors are missing
    else:
        patch = os.path.join(ASSETS, "skyline-main.patch")
        result = git(repo, "apply", "--check", patch, check=False)
        if result.returncode != 0:
            raise SystemExit("src/main.js has changed since the integration patch was made, so it does not apply:\n"
                             f"{result.stderr.strip()}\nApply {patch} by hand (it is small), then rerun install.")
        git(repo, "apply", patch)
        done.append("applied skyline-main.patch (src/main.js, index.html: model loader hooks, night mode, extras)")
        main_js = open(main_path, encoding="utf-8", newline="").read()
    upgraded, notes = upgrade_main(main_js)  # nothing to do after the current patch; upgrades older ones
    if upgraded != main_js:
        with open(main_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(upgraded)
    done += notes
    for name in INTEGRATION_FILES:
        target = os.path.join(repo, "src", name)
        if not os.path.exists(target):
            shutil.copyfile(os.path.join(ASSETS, name), target)
            done.append(f"added src/{name}")
        elif file_version(open(target, encoding="utf-8").read()) < INTEGRATION:
            shutil.copyfile(os.path.join(ASSETS, name), target)
            done.append(f"updated src/{name} to {INTEGRATION_VERSION}")
    done += ensure_custom_models(repo, force)
    done += ensure_fountains(repo, city)
    return done


def ensure_custom_models(repo: str, force: bool) -> list[str]:
    """Add or update src/customModels.js; a hard-coded older version moves its entries into models.json."""
    cm = os.path.join(repo, "src", "customModels.js")
    asset_cm = os.path.join(ASSETS, "customModels.js")
    if not os.path.exists(cm):
        shutil.copyfile(asset_cm, cm)
        return ["added src/customModels.js (reads public/models/models.json)"]
    text = open(cm, encoding="utf-8").read()
    if "models.json" in text:
        if file_version(text) < INTEGRATION:
            shutil.copyfile(asset_cm, cm)
            return [f"updated src/customModels.js to {INTEGRATION_VERSION} (reads `_WINDOWS` and Led materials)"]
        return []
    entries = legacy_entries(text)
    if "const MODELS = {" not in text and not force:
        raise SystemExit("src/customModels.js is not a version this tool knows; rerun with --force to replace it "
                         "(a backup is kept in the system temp folder)")
    backup = os.path.join(tempfile.mkdtemp(prefix="customModels-"), "customModels.js")
    shutil.copyfile(cm, backup)
    shutil.copyfile(asset_cm, cm)
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    manifest = load_json(manifest_path) if os.path.exists(manifest_path) else {}
    for city, models in entries.items():
        for bid, spec in models.items():
            manifest.setdefault(city, {}).setdefault(bid, spec)
    write_manifest(manifest_path, manifest)
    return [f"replaced the hard-coded src/customModels.js with the manifest version (backup: {backup}); "
            f"moved {sum(len(m) for m in entries.values())} existing entries into public/models/models.json"]


def copy_glb(repo: str, glb: str) -> str:
    models_dir = os.path.join(repo, "public", "models")
    os.makedirs(models_dir, exist_ok=True)
    target = os.path.join(models_dir, os.path.basename(glb))
    if os.path.abspath(glb) != os.path.abspath(target):
        shutil.copyfile(glb, target)
    return f"/models/{os.path.basename(glb)}"


def finish_install(repo: str, done: list[str]) -> None:
    for line in done:
        print(f"- {line}")
    status = git(repo, "status", "--short", check=False).stdout.strip()
    print("repo status (nothing committed):\n" + (status or "(clean)"))


def install(repo: str, city: str, bid: str, glb: str, offset: list[float], name: str | None, force: bool) -> int:
    check_repo(repo, city)
    if not os.path.isfile(glb):
        raise SystemExit(f"no such file: {glb}")
    data = load_json(os.path.join(repo, "public", "data", city, "buildings.json"))
    building = next((b for b in data["buildings"] if b["id"] == bid), None)
    if building is None:
        raise SystemExit(f"{bid} is not a building in {city}; use `find` to look it up")
    done = ensure_integration(repo, force, city)
    url = copy_glb(repo, glb)
    done.append(f"copied {os.path.basename(glb)} to public/models/")
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    manifest = load_json(manifest_path) if os.path.exists(manifest_path) else {}
    entry = {"url": url, "offset": offset, "name": name or building.get("name") or bid}
    manifest.setdefault(city, {})[bid] = entry
    write_manifest(manifest_path, manifest)
    done.append(f"listed {bid} in public/models/models.json: {entry}")
    finish_install(repo, done)
    cutoff = data.get("tallCutoff", 35)
    if building["h"] < cutoff:
        print(f"note: {building.get('name') or bid} is {building['h']} m, under the default {cutoff} m cutoff; the app "
              "(integration v6) draws it from the model anyway, as one of the removable buildings")
    return 0


def upgrade(repo: str, city: str, force: bool) -> int:
    """Bring the integration up to the current version without installing a model."""
    check_repo(repo, city)
    done = ensure_integration(repo, force, city)
    finish_install(repo, done or [f"already at {INTEGRATION_VERSION}; nothing to do"])
    return 0


def glb_node_names(glb: str) -> tuple[set[str], dict[str, list[str]]]:
    """Node names in a GLB, and each node's children's names (for the spin contract: Rotor and its Cabin_*)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.dont_write_bytecode = True
    from check_glb import read_glb  # noqa: E402  (same folder)
    nodes = read_glb(glb)[0].get("nodes", [])
    names = [n.get("name", "") for n in nodes]
    return set(names), {names[i]: [names[c] for c in n.get("children", [])] for i, n in enumerate(nodes)}


def install_extra(repo: str, city: str, name: str, glb: str, east: float, north: float, rotation: float,
                  visible: str, blend: str, force: bool, spin: dict | None = None) -> int:
    """List a structure that is not a building in the app's data under "extras" (upserted by name). `spin`
    ({"node", "period_s", "direction"}) makes it a turning wheel (high_roller/SPIN_CONTRACT.md)."""
    check_repo(repo, city)
    if not name.strip():
        raise SystemExit("--extra needs a name")
    if not os.path.isfile(glb):
        raise SystemExit(f"no such file: {glb}")
    if not all(math.isfinite(v) for v in (east, north, rotation)):
        raise SystemExit("--east, --north and --rotation must be numbers (meters east/north of the city origin, "
                         "degrees counter-clockwise from east)")
    spin_notes: list[str] = []
    if spin:
        if not (math.isfinite(spin["period_s"]) and spin["period_s"] > 0) or spin["direction"] not in (1, -1):
            raise SystemExit("--spin-period must be a positive number of seconds and --spin-direction 1 or -1")
        names, children = glb_node_names(glb)
        if spin["node"] not in names:
            spin_notes.append(f"warning: {os.path.basename(glb)} has no node named {spin['node']!r}, so the app "
                              "draws it without turning (see high_roller/SPIN_CONTRACT.md)")
        else:
            cabins = [c for c in children.get(spin["node"], []) if c.startswith("Cabin_")]
            spin_notes.append(f"{spin['node']} turns once every {spin['period_s']:g} s with {len(cabins)} level cabins")
    near = load_json(os.path.join(repo, "public", "data", "cities.json")).get(city, {}).get("terrain", {}).get("near")
    done = ensure_integration(repo, force, city)
    url = copy_glb(repo, glb)
    done.append(f"copied {os.path.basename(glb)} to public/models/")
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    manifest = load_json(manifest_path) if os.path.exists(manifest_path) else {}
    extras = manifest.setdefault("extras", {})
    if not isinstance(extras, dict) or not isinstance(extras.setdefault(city, []), list):
        raise SystemExit(f"{manifest_path}: \"extras\" should be {{\"<city>\": [ ... ]}}")
    entry = {"name": name.strip(), "url": url, "east": round(east, 2), "north": round(north, 2),
             "rotation_deg": round(rotation, 2), "visible": visible, **({"blend": blend} if blend != "opaque" else {}),
             **({"spin": spin} if spin else {})}
    done += spin_notes
    others = [e for e in extras[city] if e.get("name") != entry["name"]]
    replaced = len(others) != len(extras[city])
    if any(e.get("url") == url for e in others):
        done.append(f"warning: another extra already uses {url}; give each extra its own GLB file name")
    extras[city] = others + [entry]
    write_manifest(manifest_path, manifest)
    done.append(f"{'updated' if replaced else 'listed'} extra {entry['name']!r} in public/models/models.json: {entry}")
    finish_install(repo, done)
    if near and not (near["x0"] < east < near["x1"] and near["y0"] < north < near["y1"]):
        print(f"note: {east:.0f}, {north:.0f} is outside the detailed terrain of {city}; the extra stands on the "
              "coarse terrain there (check its ground height)")
    return 0


# ----------------------------------------------------------------------- check
PROBE = r"""
<script type="module">
// added by skyline_tool.py check: frames one building and reports what the app built
import * as THREE from 'three';
const q = new URLSearchParams(location.search), out = document.createElement('pre');
out.id = 'probe'; out.hidden = true; document.body.append(out);
const report = { ok: false, errors: [] };
addEventListener('error', (e) => report.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => report.errors.push(String((e.reason && e.reason.message) || e.reason)));
// full text of console errors (a shader compile log is long; its error lines are at the end)
const consoleError = console.error.bind(console);
console.error = (...args) => {
  const msg = args.map((a) => (a && a.message) || String(a)).join(' ');
  (report.consoleErrors = report.consoleErrors || []).length < 8
    && report.consoleErrors.push(msg.length > 6000 ? `${msg.slice(0, 1200)} ... ${msg.slice(-4800)}` : msg);
  if (/Shader Error|program not valid/.test(msg)) report.errors.push('a shader failed to compile (see consoleErrors)');
  consoleError(...args);
};
const t0 = performance.now();
while (!window.__skyline && performance.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 100));
const s = window.__skyline;
if (!s) report.errors.push('the app never finished loading (window.__skyline missing)');
else {
  report.nightSupported = 'night' in s.settings;
  if (report.nightSupported) s.setSetting('night', q.get('night') === '1');
  s.setSetting('highlight', q.get('highlight') === '1');
  if (s.attractions) {
    // hold fountain shows and LED skins at one moment: repeatable shots, and no frames rendered meanwhile
    s.attractions.freeze(Number(q.get('show')));
    const loaded = await Promise.race([s.attractions.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
    if (!loaded) report.errors.push('extras and fountains did not finish loading');
    report.attractions = s.attractions.summary();
  }
  const round = (a) => a.toArray().map((v) => +v.toFixed(1));
  let self = null, b = null, h = 0, size = 0;
  if (q.get('extra')) {
    const o = s.attractions && s.attractions.find(q.get('extra'));
    if (!s.attractions) report.errors.push('this app has no extras: install adds them (skyline-integration v5)');
    else if (!o) report.errors.push(`extra "${q.get('extra')}" is not in the scene; it has: ${[...s.attractions.extras, ...s.attractions.fountains].map((e) => e.name).join(', ') || 'none'}`);
    else {
      b = new THREE.Box3().setFromObject(o); h = b.max.y - b.min.y;
      size = Math.max(h, 0.5 * Math.max(b.max.x - b.min.x, b.max.z - b.min.z)); self = o;
      let verts = 0; // a wheel is several meshes (static parts, rotor, cabins): count them all
      o.traverse((m) => { if (m.isMesh && !m.isInstancedMesh) verts += m.geometry.attributes.position.count; });
      const listed = s.attractions.summary().extras.find((e) => e.name === o.name) || {};
      report.extra = { name: o.name, kind: o.userData.fountain ? 'fountain' : 'extra', visible: o.visible,
        verts: o.isInstancedMesh ? null : verts, url: o.userData.extra ? o.userData.extra.url : null,
        ...(listed.spin ? { spin: listed.spin } : {}),
        position: [+o.position.x.toFixed(1), +(-o.position.z).toFixed(1), +o.position.y.toFixed(1)], min: round(b.min), max: round(b.max) };
    }
  } else {
    const t = s.tall.find((e) => e.data.id === q.get('id'));
    if (!t) report.errors.push(`building ${q.get('id')} is not among the removable (tall) buildings`);
    else {
      const g = t.mesh.geometry; g.computeBoundingBox();
      b = g.boundingBox; h = b.max.y - b.min.y; size = h; self = t.mesh;
      report.building = { id: t.data.id, name: t.data.name, h: t.data.h, verts: g.attributes.position.count,
        glow: !!g.attributes.glow, min: round(b.min), max: round(b.max),
        center: [+((b.min.x + b.max.x) / 2).toFixed(1), +(-(b.min.z + b.max.z) / 2).toFixed(1)] };
    }
  }
  if (b) {
    let [bearing, elev, dist, target] = ['bearing', 'elev', 'dist', 'target'].map((k) => Number(q.get(k)));
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, ty = b.min.y + target * h, d = dist * size;
    // a long, low extra (a canopy) hides between buildings from the default pitch: look down on it more steeply
    if (self !== null && q.get('extra') && q.get('autopitch') === '1' && h < 0.35 * size) elev = Math.max(elev, 55);
    const el = elev * Math.PI / 180;
    const eye = (deg) => new THREE.Vector3(cx + d * Math.cos(el) * Math.sin(deg * Math.PI / 180), ty + d * Math.sin(el),
      cz - d * Math.cos(el) * Math.cos(deg * Math.PI / 180));
    if (bearing < 0) {
      // auto: the bearing from which rays to the building's middle hit the building itself, not a neighbor
      const targets = [];
      s.scene.traverse((o) => { if (o.isMesh && o.visible && o.material && !o.material.transparent) targets.push(o); });
      const rc = new THREE.Raycaster(), aims = [0.35, 0.55, 0.75].map((k) => new THREE.Vector3(cx, b.min.y + k * h, cz));
      const seen = (from) => aims.filter((p) => {
        const dir = p.clone().sub(from), far = dir.length();
        rc.set(from, dir.normalize()); rc.far = far + 1;
        const hit = rc.intersectObjects(targets, false)[0];
        let own = false; // a hit on the target itself, or on one of its meshes (a wheel is several)
        for (let x = hit && hit.object; x; x = x.parent) if (x === self) own = true;
        return !hit || own || hit.distance > far - 0.08 * h;
      }).length;
      const scores = [200, 245, 290, 335, 20, 65, 110, 155].map((deg) => [deg, seen(eye(deg))]);
      bearing = scores.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
      report.autoBearing = { chosen: bearing, scores };
    }
    Object.assign(s.controls, { minDistance: 1, maxDistance: 1e7, maxPolarAngle: Math.PI, enableDamping: false });
    s.camera.position.copy(eye(bearing));
    s.controls.target.set(cx, ty, cz);
    s.controls.update();
  }
  for (const id of ['loading', 'panel', 'tip', 'menu', 'card', 'toast', 'top', 'tools', 'dock', 'hint', 'changes'])
    if (q.get('panel') !== '1' || id === 'loading') document.getElementById(id)?.style.setProperty('display', 'none');
  s.invalidate();
  // draw once now, so every material compiles here and a shader that fails is caught in this report
  try { s.renderer.render(s.scene, s.camera); } catch (e) { report.errors.push(`render failed: ${e.message}`); }
  report.ok = report.errors.length === 0;
}
out.textContent = JSON.stringify(report);
</script>
"""


def three_versions(repo: str) -> dict[str, str]:
    pkg = load_json(os.path.join(repo, "package.json")).get("dependencies", {})
    versions = {}
    for name in ("three", "three-mesh-bvh"):
        installed = os.path.join(repo, "node_modules", name, "package.json")
        if os.path.exists(installed):
            versions[name] = load_json(installed)["version"]
        elif name in pkg:
            versions[name] = re.sub(r"^[^\d]*", "", pkg[name])
    return versions


BARE_IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(['"])(three-mesh-bvh(?:/worker)?|three(?:/addons/[^'"]+)?)\2""")
JSON_IMPORT = re.compile(r"""(\bfrom\s*)(['"])(\.{0,2}/[^'"]+\.json)\2""")


def has_local_modules(repo: str) -> bool:
    return all(os.path.exists(os.path.join(repo, "node_modules", n, "package.json")) for n in ("three", "three-mesh-bvh"))


def local_module(name: str) -> str:
    """Where a bare import resolves in the repo's node_modules, as Vite resolves it in dev."""
    if name == "three":
        return "/node_modules/three/build/three.module.js"
    if name.startswith("three/addons/"):
        return "/node_modules/three/examples/jsm/" + name[len("three/addons/"):]
    if name == "three-mesh-bvh/worker":
        return "/node_modules/three-mesh-bvh/src/workers/index.js"
    return "/node_modules/three-mesh-bvh/src/index.js"


def rewrite_imports(source: str, local: bool) -> str:
    """Make app source load without Vite. JSON imports become `?module` requests that the server wraps as a JS
    module. With local node_modules, bare imports become paths too: a module worker (three-mesh-bvh's BVH worker)
    does not see the page's import map, so its `three` imports have to be rewritten in the files themselves."""
    source = JSON_IMPORT.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?module{m[2]}", source)
    if local:
        source = BARE_IMPORT.sub(lambda m: f"{m[1]}{m[2]}{local_module(m[3])}{m[2]}", source)
    return source


def import_map(repo: str) -> str:
    if has_local_modules(repo):
        imports = {name: local_module(name) for name in ("three", "three-mesh-bvh", "three-mesh-bvh/worker")}
        imports["three/addons/"] = "/node_modules/three/examples/jsm/"
    else:
        # from a CDN the BVH worker cannot start (a worker must come from the page's origin): run `pnpm install`
        v = three_versions(repo)
        cdn = "https://cdn.jsdelivr.net/npm"
        imports = {"three": f"{cdn}/three@{v['three']}/build/three.module.js",
                   "three/addons/": f"{cdn}/three@{v['three']}/examples/jsm/",
                   "three-mesh-bvh": f"{cdn}/three-mesh-bvh@{v['three-mesh-bvh']}/build/index.module.js",
                   "three-mesh-bvh/worker": f"{cdn}/three-mesh-bvh@{v['three-mesh-bvh']}/src/workers/index.js"}
    return f'<script type="importmap">{json.dumps({"imports": imports})}</script>\n'


def check_page(repo: str) -> bytes:
    page = open(os.path.join(repo, "index.html"), encoding="utf-8").read()
    first_module = page.find('<script type="module"')
    if first_module < 0 or "</body>" not in page:
        raise SystemExit("index.html has no module script or </body>; the check page cannot be built")
    page = page[:first_module] + import_map(repo) + page[first_module:]
    return page.replace("</body>", PROBE + "</body>", 1).encode("utf-8")


class RepoHandler(http.server.SimpleHTTPRequestHandler):
    """Serves /src and /node_modules from the repo, /__check.html from memory, everything else from public/."""
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript",
                      ".mjs": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary",
                      ".bin": "application/octet-stream", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png"}

    def __init__(self, *args, repo: str, page: bytes, missing: list[str], **kwargs):
        self.repo, self.page, self.missing = repo, page, missing
        super().__init__(*args, directory=repo, **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        url = urllib.parse.urlparse(self.path)
        rel = urllib.parse.unquote(url.path).lstrip("/")
        if url.path == "/__check.html":
            self.send_body(self.page, "text/html; charset=utf-8")
            return
        if url.query == "module" and rel.endswith(".json"):
            # a JSON import in the app source resolves against the repo (like Vite), not public/
            full = os.path.normpath(os.path.join(self.repo, rel))
            if full.startswith(os.path.normpath(self.repo) + os.sep) and os.path.isfile(full):
                with open(full, encoding="utf-8") as fh:
                    self.send_body(f"export default {fh.read()};".encode("utf-8"), "text/javascript")
                return
        elif rel.endswith(".js") and rel.startswith(("src/", "node_modules/")):
            full = self.translate_path(self.path)
            if os.path.isfile(full):
                with open(full, encoding="utf-8") as fh:
                    body = rewrite_imports(fh.read(), has_local_modules(self.repo))
                self.send_body(body.encode("utf-8"), "text/javascript")
                return
        super().do_GET()

    def send_body(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path: str) -> str:
        rel = urllib.parse.unquote(urllib.parse.urlparse(path).path).lstrip("/")
        base = self.repo if rel.startswith(("src/", "node_modules/")) else os.path.join(self.repo, "public")
        full = os.path.normpath(os.path.join(base, rel))
        if not full.startswith(os.path.normpath(base)):
            return os.path.join(base, "__forbidden__")
        return full

    def send_error(self, code, message=None, explain=None):  # noqa: D401
        if code == 404 and not self.path.startswith("/favicon"):
            self.missing.append(self.path)
        super().send_error(code, message, explain)

    def log_message(self, *args) -> None:
        pass


class QuietServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128  # several browsers load the whole app at once; the default backlog of 5 drops requests
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            super().handle_error(request, client_address)  # a browser hanging up early is normal; anything else is not


def find_browser(explicit: str | None) -> str:
    for path in [explicit, os.environ.get("BROWSER_BIN"), *BROWSERS, shutil.which("msedge"), shutil.which("chrome"),
                 shutil.which("google-chrome"), shutil.which("chromium")]:
        if path and os.path.isfile(path):
            return path
    raise SystemExit("no Edge or Chrome found; pass --browser PATH")


def run_browser(browser: str, profile: str, url: str, size: str, extra: list[str]) -> tuple[str, list[str]]:
    cmd = [browser, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
           f"--user-data-dir={profile}", f"--window-size={size}", "--hide-scrollbars", "--enable-unsafe-swiftshader",
           "--ignore-gpu-blocklist", "--enable-logging=stderr", "--v=0", "--virtual-time-budget=45000", *extra, url]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240)
    console = [line.split("CONSOLE", 1)[1].strip(":]() 0123456789") for line in proc.stderr.splitlines()
               if "CONSOLE" in line and not any(n in line for n in CONSOLE_NOISE)]
    return proc.stdout, console


def expected_model(repo: str, city: str, bid: str, glb: str | None = None) -> dict | None:
    """What the app should draw for this building if its model loads: the GLB's triangles, as loose vertices.
    The GLB is `glb` if given, else the one models.json lists for the building."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
    from check_glb import summarize  # noqa: E402  (same folder)
    if glb:
        return {"url": glb, "verts": summarize(glb)["tris"] * 3} if os.path.exists(glb) else \
            {"url": glb, "verts": -1, "missing": True}
    manifest_path = os.path.join(repo, "public", "models", "models.json")
    if not os.path.exists(manifest_path):
        return None
    entry = load_json(manifest_path).get(city, {}).get(bid)
    if not entry:
        return None
    glb = os.path.join(repo, "public", entry["url"].lstrip("/"))
    if not os.path.exists(glb):
        return {"url": entry["url"], "verts": -1, "missing": True}
    return {"url": entry["url"], "verts": summarize(glb)["tris"] * 3}


def expected_extra(repo: str, url: str | None) -> dict | None:
    """The GLB triangles (as loose vertices) of the extra the probe found, from its URL in the repo."""
    if not url:
        return None
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.dont_write_bytecode = True
    from check_glb import summarize  # noqa: E402  (same folder)
    glb = os.path.join(repo, "public", url.lstrip("/"))
    return {"url": url, "verts": summarize(glb)["tris"] * 3} if os.path.exists(glb) else \
        {"url": url, "verts": -1, "missing": True}


def parse_shot(spec: str) -> dict:
    parts = spec.split(":")
    if len(parts) not in (6, 7) or parts[1] not in ("day", "night"):
        raise SystemExit(f"--shot {spec!r}: expected LABEL:day|night:BEARING:ELEVATION:DIST:TARGET[:HIGHLIGHT]")
    bearing = -1.0 if parts[2] == "auto" else float(parts[2])  # auto: the probe picks an unobstructed side
    return {"label": parts[0], "night": parts[1] == "night", "bearing": bearing, "elev": float(parts[3]),
            "dist": float(parts[4]), "target": float(parts[5]), "highlight": len(parts) == 7 and parts[6] == "1"}


def check(repo: str, city: str, bid: str | None, out: str, shots: list[str], browser: str | None, size: str,
          panel: bool, expect_glb: str | None = None, extra: str | None = None,
          show_time: float = DEFAULT_SHOW_TIME) -> int:
    check_repo(repo, city)
    os.makedirs(out, exist_ok=True)
    missing: list[str] = []
    handler = functools.partial(RepoHandler, repo=os.path.abspath(repo), page=check_page(repo), missing=missing)
    server = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    exe = find_browser(browser)
    scratch = tempfile.mkdtemp(prefix="skyline-check-")
    report: dict = {"repo": os.path.abspath(repo), "city": city, **({"extra": extra} if extra else {"id": bid}),
                    "browser": exe, "shots": []}
    specs = [parse_shot(s) for s in (shots or DEFAULT_SHOTS)]

    def url_for(shot: dict) -> str:
        params = {"city": city, "id": bid or "", "night": int(shot["night"]), "highlight": int(shot["highlight"]),
                  "bearing": shot["bearing"], "elev": shot["elev"], "dist": shot["dist"], "target": shot["target"],
                  "panel": int(panel), "show": show_time, **({"extra": extra} if extra else {}),
                  "autopitch": int(not shots)}
        return f"http://127.0.0.1:{port}/__check.html?{urllib.parse.urlencode(params)}"

    def take(job: tuple[int, dict | None]) -> tuple[str, list[str]]:
        # every browser gets its own throwaway profile, so they can all run at once
        k, shot = job
        profile = os.path.join(scratch, f"profile-{k}")
        if shot is None:  # the DOM dump that carries the probe's report
            return run_browser(exe, profile, url_for(specs[0]), size, ["--dump-dom"])
        png = os.path.abspath(os.path.join(out, f"{shot['label']}.png"))
        return run_browser(exe, profile, url_for(shot), size, [f"--screenshot={png}"])

    try:
        jobs = [(0, None)] + [(k + 1, shot) for k, shot in enumerate(specs)]
        with ThreadPoolExecutor(max_workers=min(6, len(jobs))) as pool:
            results = list(pool.map(take, jobs))
        dom, console = results[0]
        match = re.search(r'<pre id="probe"[^>]*>(.*?)</pre>', dom, re.S)
        try:
            report["probe"] = json.loads(html.unescape(match.group(1)))
        except (AttributeError, json.JSONDecodeError):  # no probe element, or the app never got far enough
            report["probe"] = {"ok": False, "errors": [
                "the app did not finish loading (no probe result); the console lines below usually say why"]}
        lines = set(console)
        for shot, (_, shot_console) in zip(specs, results[1:]):
            png = os.path.abspath(os.path.join(out, f"{shot['label']}.png"))
            report["shots"].append({"label": shot["label"], "file": png if os.path.exists(png) else None,
                                    "night": shot["night"], "highlight": shot["highlight"]})
            lines.update(shot_console)
        report["console"] = sorted(lines)
    finally:
        server.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)
    report["missing_files"] = sorted(set(missing))
    files = [s["file"] for s in report["shots"] if s["file"]]
    try:
        from PIL import Image, ImageDraw
        tiles = [Image.open(f).convert("RGB") for f in files]
        if tiles:
            w, h = tiles[0].size
            scale = 520 / w
            cols = min(3, len(tiles))
            sheet = Image.new("RGB", (cols * 520, ((len(tiles) + cols - 1) // cols) * (round(h * scale) + 18)), (20, 20, 20))
            draw = ImageDraw.Draw(sheet)
            for i, (img, s) in enumerate(zip(tiles, [s for s in report["shots"] if s["file"]])):
                img = img.resize((520, round(h * scale)))
                x, y = (i % cols) * 520, (i // cols) * (img.height + 18)
                sheet.paste(img, (x, y))
                draw.text((x + 4, y + img.height + 2), s["label"], fill=(235, 235, 235))
            report["sheet"] = os.path.abspath(os.path.join(out, "sheet.jpg"))
            sheet.save(report["sheet"], quality=88)
    except ImportError:
        pass
    probe = report.get("probe", {})
    if extra:
        found = probe.get("extra") or {}
        expected = expected_extra(repo, found.get("url"))
        if expect_glb:
            expected = expected_model(repo, city, "", expect_glb)
        built = found.get("verts")
    else:
        expected = expected_model(repo, city, bid, expect_glb)
        built = probe["building"]["verts"] if probe.get("building") else None
    if expected and built is not None:
        report["model"] = {**expected, "built_verts": built, "loaded": built == expected["verts"]}
        if built != expected["verts"]:
            probe.setdefault("errors", []).append(
                f"the app drew {built} vertices, but {expected['url']} has {expected['verts']}: the model did not "
                "load" + ("" if extra else " and the footprint was drawn instead") + " (see console lines)")
            probe["ok"] = False
    report["ok"] = bool(probe.get("ok") and all(s["file"] for s in report["shots"]))
    with open(os.path.join(out, "check.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    # the verdict comes first, so it survives anyone reading only the head of the output
    if report.get("model"):
        print(f"model: {report['model']['url']} loaded = {report['model']['loaded']}")
    print("OK" if report["ok"] else "PROBLEMS: see below and check.json")
    if extra:
        print(f"extra: {json.dumps(probe.get('extra'))}")
    else:
        print(f"building: {json.dumps(probe.get('building'))}")
    if probe.get("attractions"):
        a = probe["attractions"]
        print(f"extras: {', '.join(e['name'] + ('' if e['visible'] else ' (hidden now)') for e in a['extras']) or 'none'}; "
              f"fountains: {', '.join(f['name'] for f in a['fountains']) or 'none'}")
        for line in a.get("problems", []):
            print(f"attractions problem: {line}")
    if probe.get("autoBearing"):
        print(f"auto bearing: {probe['autoBearing']['chosen']} (rays reaching the building per bearing: "
              f"{probe['autoBearing']['scores']})")
    print(f"night mode supported: {probe.get('nightSupported')}")
    for e in probe.get("errors", []):
        print(f"page error: {e}")
    for e in probe.get("consoleErrors", []):
        print(f"console error: {e[-1500:]}")
    for line in report.get("console", []):
        print(f"console: {line}")
    for path in report["missing_files"]:
        print(f"404: {path}")
    for s in report["shots"]:
        print(f"shot {s['label']}: {s['file'] or 'FAILED'}")
    if report.get("sheet"):
        print(f"sheet: {report['sheet']}")
    return 0 if report["ok"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for cmd in ("find", "footprint", "install", "upgrade", "check", "locate"):
        p = sub.add_parser(cmd)
        p.add_argument("--repo", required=True)
        p.add_argument("--city", required=True, help="city id from public/data/cities.json, e.g. lv or slc")
        if cmd == "upgrade":
            p.add_argument("--force", action="store_true", help="replace an unknown src/customModels.js (backed up)")
        if cmd == "locate":
            p.add_argument("--lat", type=float, required=True); p.add_argument("--lon", type=float, required=True)
        if cmd == "find":
            p.add_argument("--name"); p.add_argument("--id"); p.add_argument("--limit", type=int, default=5)
        if cmd == "footprint":
            p.add_argument("--id", required=True); p.add_argument("--out", required=True)
        if cmd == "install":
            target = p.add_mutually_exclusive_group(required=True)
            target.add_argument("--id", help="building id: the model replaces this building")
            target.add_argument("--extra", metavar="NAME", help="a structure that is not a building in the app's data")
            p.add_argument("--glb", required=True)
            p.add_argument("--offset", default="0,0", help="model origin from the footprint center, m east,north")
            p.add_argument("--name"); p.add_argument("--force", action="store_true")
            p.add_argument("--east", type=float, help="extra: origin, m east of the city origin (see locate)")
            p.add_argument("--north", type=float, help="extra: origin, m north of the city origin")
            p.add_argument("--rotation", type=float, default=0.0, help="extra: degrees counter-clockwise from east")
            p.add_argument("--visible", choices=("always", "night"), default="always", help="extra: when it shows")
            p.add_argument("--blend", choices=("opaque", "additive"), default="opaque",
                           help="extra: additive adds its night glow as light (a beam)")
            p.add_argument("--spin-period", type=float, help="extra: seconds per turn of its Rotor node (a wheel)")
            p.add_argument("--spin-direction", type=int, choices=(1, -1), default=1, help="extra: 1 or -1")
            p.add_argument("--spin-node", default="Rotor", help="extra: the node that turns (default Rotor)")
        if cmd == "check":
            target = p.add_mutually_exclusive_group(required=True)
            target.add_argument("--id", help="building id to frame")
            target.add_argument("--extra", metavar="NAME", help="extra or fountain to frame, by name")
            p.add_argument("--out", required=True)
            p.add_argument("--shot", action="append", default=[]); p.add_argument("--browser")
            p.add_argument("--size", default="1400,900"); p.add_argument("--panel", action="store_true",
                                                                          help="keep the app's side panel visible")
            p.add_argument("--expect-glb", help="confirm the app drew this GLB (default: the one in models.json)")
            p.add_argument("--show-time", type=float, default=DEFAULT_SHOW_TIME,
                           help="seconds into the fountain show (and LED) loop to hold for the shots")
    args = parser.parse_args()
    repo = os.path.abspath(args.repo)
    if args.cmd == "find":
        if not (args.name or args.id):
            raise SystemExit("find needs --name or --id")
        return find(repo, args.city, args.name, args.id, args.limit)
    if args.cmd == "footprint":
        return footprint(repo, args.city, args.id, args.out)
    if args.cmd == "locate":
        return locate(repo, args.city, args.lat, args.lon)
    if args.cmd == "upgrade":
        return upgrade(repo, args.city, args.force)
    if args.cmd == "install":
        if args.extra:
            if args.east is None or args.north is None:
                raise SystemExit("install --extra needs --east and --north (m from the city origin; `locate` "
                                 "converts latitude/longitude)")
            spin = None if args.spin_period is None else {
                "node": args.spin_node, "period_s": args.spin_period, "direction": args.spin_direction}
            return install_extra(repo, args.city, args.extra, os.path.abspath(args.glb), args.east, args.north,
                                 args.rotation, args.visible, args.blend, args.force, spin)
        offset = [float(x) for x in args.offset.split(",")]
        if len(offset) != 2:
            raise SystemExit("--offset is east,north in meters, e.g. 3.2,0.8")
        return install(repo, args.city, args.id, os.path.abspath(args.glb), offset, args.name, args.force)
    return check(repo, args.city, args.id, os.path.abspath(args.out), args.shot, args.browser, args.size, args.panel,
                 os.path.abspath(args.expect_glb) if args.expect_glb else None, args.extra, args.show_time)


if __name__ == "__main__":
    sys.exit(main())
