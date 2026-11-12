---
name: blender-landmark-model
description: Build a true-scale, low-poly 3D model of a real building, tower or landmark from public reference photos, procedurally in a fresh headless Blender process, with night lighting baked in, exported as a GLB, checked, and optionally installed and verified in the interactive-skyline three.js app by day and night. Runs research and reference gathering (Wikimedia Commons, Pixabay, published dimensions) as parallel subagents so a model lands in about 5-10 minutes. Use this whenever someone wants a 3D model, low-poly model, GLB or Blender model of a named real-world structure (a skyscraper, observation tower, stadium, monument, casino, bridge pylon), wants to "model X from photos", wants to add or replace a hand-modelled building in interactive-skyline or a similar three.js/game scene, or wants night lighting on such a model, even if they don't mention Blender or headless.
---

# Landmark models in headless Blender

You orchestrate. Subagents gather photos and numbers in parallel while you set up; Blender runs headless in
its own process (a build takes about 8 seconds, previews about 5), so most of the clock goes to research
and to judging the shape. Aim for a first complete model in 5-10 minutes, then refine if asked.

`<SKILL>` below means this skill's folder (the one holding this file).

## Ground rules

- **Headless, always.** Run Blender only through `scripts/run_blender.py`: a fresh background process with
  factory settings. Never drive a Blender window the user has open (no Blender MCP), unless they ask to see
  the result there.
- **No logos or trademarks.** Do not model logos, wordmarks, brand names or trademarked graphics, even when
  prominent on the structure: model the surface they sit on, plain. Keep brand names out of material and
  object names too. Details in `references/modeling-guide.md#logos-and-trademarks`.
- **Every number has a source** (a published figure, project data, or a ratio read off a named photo) or
  is marked estimated, in comments at the top of the build script.
- **Closed solids, flat colors, `_GLOW` for night.** The kit enforces most of this; the build fails loudly
  when the mesh check finds errors.
- **Secrets stay put.** The Pixabay key is read by `refs.py` from `PIXABAY_API_KEY` or Windows Credential
  Manager (entry `pixabay.com`) and only ever sent to pixabay.com. Never print, echo or pass it yourself.

## Subagents

Use the Agent tool with `subagent_type: "general-purpose"`, `model: "fable"`, `effort: "low"`, in the
background. Launch every agent of a phase in one message so they run concurrently. Copy-ready briefs for each
role are in `references/subagents.md`. If a role's report comes back thin, rerun just that role once at
`effort: "medium"`; don't rerun roles that came back fine. Do small things yourself (a `find` lookup, one
build) rather than delegating them: a subagent costs more than a handful of commands.

No Agent tool (for example, you are a subagent yourself)? Play the roles yourself in the same order, each
kept to its brief and time box: photos first (Commons, then Pixabay), then dimensions, then modeling.

## Timeline

### 0:00 — set up and fan out (one message)

1. Pick a short `stem` (`strat`, `space_needle`) and a model folder: the user's choice, or next to their
   project. Create `<MODEL>/refs`, `<MODEL>/research`, copy `<SKILL>/scripts/landmark_kit.py` and
   `<SKILL>/assets/build_template.py` (as `build_<stem>.py`) into `<MODEL>`. Copying keeps the folder
   rebuildable without the skill.
2. In the same message, launch in the background:
   - **refs-commons**: side view, aerial, close-ups of top and base, night photos, plus any links the user gave
   - **refs-pixabay**: only if `python <SKILL>/scripts/refs.py pixabay-key` says a key is available (it checks
     `PIXABAY_API_KEY` and Windows Credential Manager without printing the key); otherwise skip it
   - **dimensions**: heights, section heights, plan sizes, with sources
3. Target is interactive-skyline? Run `skyline_tool.py find` yourself now (seconds): it gives the building id,
   height, footprint and any hand-measured override, which also go into the dimensions brief. Then
   `skyline_tool.py footprint --id <id> --out <MODEL>/footprint.json`: the mapped plan in meters around the
   point the app places models at. For a building that follows its footprint (most towers and slabs), extrude
   that exact plan (`kit.load_footprint`, `b.extrude`, `kit.scale_polygon` for setbacks) and install with
   offset 0,0; spend the photo work on what the plan can't show: crown, setbacks, curves, colors, night light.

4. Is there a city model for the area (CityGML/CityJSON, a 3DCityDB, or an API such as the 3D BAG)? Then
   `citymodel.py extract` gives the true footprint, height and LOD2 roof surfaces, and `Builder.surfaces`
   builds them directly; photos are then for color, detail and night light. See `references/city-models.md`
   (finding data, citymodel.py, 3DCityDB v5 Docker and citydb-tool commands, schema notes).

### 0:30 — draft while they work

Write a first `build_<stem>.py` from what you know and from `find`: the main masses at roughly the right
heights, the materials, a first `glow()`. Run it (`run_blender.py build_<stem>.py -- --out <MODEL>`) to prove
the plumbing; the numbers get corrected when research lands. Read `references/modeling-guide.md` for recipes
(which kit call fits which shape), budgets, colors and glow.

### ~3:00 — research lands: real numbers, then model

Put the researched numbers and photo ratios into the dimension tables, each with its source. Then:

- **Simple or medium structure** (most towers and buildings): finish the script yourself.
- **Complex structure with 3+ distinct sections** (e.g. legs + shaft + pod + mast): move dimensions, COLORS
  and `glow` into `<MODEL>/spec.py`, and launch one **part-modeler** per section in one message
  (`references/subagents.md`), each writing its own `part_<name>.py` from `assets/part_template.py`. The build
  script picks up part files automatically and `--only <name>` builds one part, so modelers never block each
  other. Only you edit `spec.py`; merge their material requests when they report.

### ~6:00 — build, look, review in parallel

```
python <SKILL>/scripts/run_blender.py <MODEL>/build_<stem>.py -- --out <MODEL>
python <SKILL>/scripts/run_blender.py <SKILL>/scripts/render_views.py --blend <MODEL>/<stem>.blend -- --out <MODEL>/renders --views south,east,iso [--photo NAME:BEARING:ELEV:LENS]
python <SKILL>/scripts/refs.py sheet --out <MODEL>/renders/compare.jpg <a side photo> <MODEL>/renders/south_day.png <MODEL>/renders/iso_day.png <MODEL>/renders/iso_night.png
```

Look at the comparison sheet yourself, then launch the **reviewer** in the background (fresh eyes on renders
vs photos) and, while it works, run:

```
python <SKILL>/scripts/check_glb.py <MODEL>/<stem>.glb --height <published height> --max-tris <budget>
python <SKILL>/scripts/skyline_tool.py install --repo <REPO> --city <city> --id <id> --glb <MODEL>/<stem>.glb --offset E,N   # skyline only
python <SKILL>/scripts/skyline_tool.py check   --repo <REPO> --city <city> --id <id> --out <MODEL>/app-check             # skyline only
```

`references/interactive-skyline.md` explains placement (`--offset`), what install changes in the repo, and
how to read the check. Open `app-check/sheet.jpg` and confirm `model ... loaded = True`.

Working in the interactive-skyline repo itself, put the model folder at `landmarks/<city>/<stem>/`, beside the
others: the build script, footprint, report, research notes and photo credits are committed, while photos,
renders, checks, `.blend` and the GLB (installed into `public/models/<city>/`) are git-ignored. A folder without its
own `landmark_kit.py` builds with this skill's copy.

For a demo, `skyline_tool.py`'s sibling `flyover.py` records a camera flight through the app as a GIF, frame by
frame in headless Chrome (fountains, LEDs and the wheel advance one frame each time; ffmpeg encodes):
`python <SKILL>/scripts/flyover.py --repo <REPO> --out flyover.gif --night --key E,N,Y:E,N,Y --key E,N,Y:E,N,Y`
(eye:target per key, in the app's frame; `--help` for length, size and palette).

Skyline integration v6 also has (details in the same reference):

- **Extras**, structures that are not buildings in the app's data (a canopy, a Ferris wheel, a light beam): build
  the GLB the same way, then `skyline_tool.py install --repo R --city lv --extra NAME --glb FILE --east E --north N
  [--rotation DEG] [--visible night] [--blend additive]` (east/north from `locate`) and `check --extra NAME --out DIR`.
- **Spinning extras**: a wheel built to `references/spin-contract.md` (a `Rotor` node with level
  `Cabin_*` children) turns with `install --extra ... --spin-period S`.
- **Models under the cutoff**: a building with a model is always drawn from it (the 31 m Luxor sphinx).
- **LED surfaces**: name a material `Led...` (`LedSkin`, `LedCanopy`) with a moderate base glow and the app animates
  abstract color bands on it, strong at night. Never logos, text or show content.
- **Fountain show**: install adds the Fountains of Bellagio (1,214 animated jets, one draw call) for `lv`;
  `upgrade --repo R --city lv` brings an older integration to v6 without touching models.
- Marked facade glass may slope up to about 60 degrees (pyramids); glow is per corner, so decide it from the face
  `center` on tall faces, or the crown's glow bleeds down the shaft.

### ~8:00 — one correction pass, then report

Apply the reviewer's corrections that you agree with (most visible first), rebuild, re-render, re-run the
checks. Stop when the silhouette and the main proportions match the photos; offer further refinement rather
than polishing unasked.

## The build script

`assets/build_template.py` is the starting point; `assets/examples/strat/build_strat.py` is a finished
example (4,608 triangles: lofted hyperbolic legs, a revolved pod with mullion and diamond-bracing pattern
bands, a lattice mast, night colors). The kit (`landmark_kit.py`) gives you:

- `Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})` with `loft`, `box`, `block`, `prism`, `extrude`,
  `beam`, `strut`, `lattice_mast`, `revolve` (with `curtain_wall`, `diamond_bracing`, `stripes` patterns) and
  `finish(name)`. `windows` marks the facade glass that should get the app's procedural lit windows at
  night (`_WINDOWS` attribute); without it a glass tower reads as a dark slab next to the lit city. Keep
  that glass's own glow low (about 0.03) and leave crowns, bands and podiums out of it.
- `extrude_sloped` (roofs and bands that follow a function) and `fins` (vertical fins along a plan)
- helpers `lerp_table`, `circle`, `polar`, `compass_to_math`, `scaled`, `scale_polygon`, `load_footprint`
- `Builder.surfaces(polygons, materials_by_semantic, default)` for city-model geometry from `citymodel.py`,
  `offset_polygon` (mitered inset or outset), `footprint_rings` (banded lofts with setbacks), `densify`
- `main(build, stem, script_file, max_tris)`: resets the scene, builds, runs the mesh check, writes
  `<stem>.report.json`, exports `<stem>.blend` and `<stem>.glb` (Y-up, `_GLOW` attribute, no COLOR_0), and fails
  the run on mesh errors. Script options after `--`: `--out`, `--only`, `--skip-export`, `--max-tris`,
  `--allow-errors`.

Conventions: meters; +X east, +Y north, +Z up; origin at the structure's center on the ground; base sunk 2 m.

## Batch: many buildings at once

For a list of buildings (say, a city's tallest 25), run one subagent per building, a few at a time, each
following this skill in its lean form, and keep the shared repo to yourself:

- Each subagent gets its own model folder and its own throwaway clone of the repo for `install` + `check`,
  so parallel installs never race on `models.json`. You install finished GLBs into the user's repo one at a
  time and re-run `check` there; delete the clones at the end.
- Lean brief: Commons-only references (3-5 photos, about 2 minutes), the project's height trusted as is,
  `footprint` for the plan with offset 0,0, a 3,000-triangle budget, one compare-and-fix pass, absolute paths
  everywhere, and "report a check failure and stop, don't debug the app". On Fable at low effort this took
  3-6 minutes and about 100k tokens per building.
- Mapped footprints sometimes include a podium, garage or neighboring block drawn at full height: judge
  from the photos and model those parts low, saying so in the report.
- Start the next building as soon as one finishes; keep a ledger (status, minutes, tokens, installed) so
  the run can be resumed and costs reported.

## Output

```
<MODEL>/
  build_<stem>.py  landmark_kit.py  [spec.py  part_*.py]
  <stem>.glb  <stem>.blend  <stem>.report.json
  refs/  (photos + sources.json with authors and licenses)   research/dimensions.md
  renders/  (elevations, iso, night)   [app-check/  (screenshots, sheet.jpg, check.json)]
```

## Report to the user

Lead with the result: where the GLB is, triangle count, height, and (for skyline) that it is installed and
loaded, with the app URL to open. Then, briefly:

- what the model includes, and what was simplified or left out (always say that logos and signage were
  skipped if the building has any)
- which numbers are published or measured and which are estimates
- the comparison and check images worth opening, by full path
- anything that did not match the photos and was not fixed

Credit photo sources only if the user plans to publish renders (authors and licenses are in `refs/sources.json`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Blender not found` | pass `--blender PATH` or set `BLENDER`; the runner also searches the usual install folders |
| build exits 1 with `mesh check failed` | read the errors in `<stem>.report.json`: degenerate faces (repeated points), inside-out islands (a face wound the wrong way in a hand-made `face()`), loose verts |
| `faces.new` duplicate-face error | two parts emit the same face; offset one or drop the duplicate |
| night render all black | `glow()` returns zeros for that material, or the attribute is missing |
| app check: "model did not load" | wrong `url`/file in `public/models`, or the GLB failed to parse: see the printed console lines |
| app check: building not among tall ones | it is under the height cutoff and the repo's integration is older than v6: run `skyline_tool.py upgrade` |
| app check: "did not finish loading" | a script error in the app: the printed console lines name the file and line |
| app check: model hidden in shots | a neighboring tower is in the way; add `--shot` views from other bearings (0 = north) |
| app check: "a shader failed to compile" | the printed console error names the GLSL line; a JS backtick inside a GLSL template string is a common cause |
| a tall face glows as bright as the crown at night | glow is chosen per corner and interpolated: decide it from `center[2]`, or split the face at the crown |
| renders landed in an odd folder | pass absolute `--out` paths; relative ones resolve against the current directory |
| Python can't find a path from Git Bash | pass `C:/Users/...` style paths to Python (`cygpath -m`), not `/c/Users/...` |
