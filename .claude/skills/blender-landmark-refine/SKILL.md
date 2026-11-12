---
name: blender-landmark-refine
description: Second pass on landmark models already built procedurally in Blender (by blender-landmark-model or a similar procedural build script) - compares renders with the reference photos, has a fresh-eyes reviewer list the worst discrepancies in meters, fixes them in the build script (smooth sloped rooflines instead of steps, podiums and tower insets, floor bands, fins and mullions, crown shape, night lighting), adds fidelity detail such as facade glass that gets lit windows by night and mullion grids and sky reflections by day, then gates the result (triangle budget, _GLOW, no COLOR_0, clean mesh, height unchanged) and reinstalls it in interactive-skyline with an automatic revert if anything fails. Runs one Fable 5.2 subagent per model, four at a time. Use it whenever someone wants to refine, improve, polish, fix the proportions of, add detail or windows or reflections to, or do a second pass on existing landmark models or skyline buildings, even if they don't say "refine".
---

# Refining landmark models

A first build gets the silhouette roughly right in a few minutes; a refine pass makes it hold up next to the
photos. This skill works on model folders that `blender-landmark-model` made (or anything with the same
layout): `build_<stem>.py`, `landmark_kit.py`, `refs/`, `<stem>.glb`, `<stem>.report.json`, and optionally a
`footprint.json` and an install in the interactive-skyline repo.

`<SKILL>` is this skill's folder and `<BUILD>` the `blender-landmark-model` skill next to it; this skill uses
its scripts (`run_blender.py`, `render_views.py`, `check_glb.py`, `skyline_tool.py`, `refs.py`) and never
copies them. `refine_tool.py` here does the deterministic steps.

## Ground rules

- **Headless Blender only**, through `<BUILD>/scripts/run_blender.py`. Never the Blender MCP or a window the
  user has open.
- **No logos, wordmarks or brand signs**, ever: a refinement is not a reason to add a sign the build left out.
- **Keep the previous version.** `refine_tool.py start` backs up the folder; `finalize` restores it and
  reinstalls the old GLB automatically if the gate or the app check fails, and keeps the failed attempt in
  `backups/<time>-failed/` so the work isn't lost.
- **Budget per model: about 10 minutes and $5.** Two review-fix rounds, then stop. On Fable at medium effort
  expect more tokens than a build (roughly 150-250k).
- **Keep it procedural**: every fix goes into the build script (or `spec.py`/`part_*.py`), never into the mesh.

## Decide with the user first (main thread)

Ask, in one message, unless they already said:
1. **Which models**: all of them, or a first wave (the ones flagged in the build reports: missing or
   full-height podiums, stepped rooflines, thinned-out bands, flat or over-bright night lighting).
2. **In place or copy**: in place with a backup and automatic revert (default), or `--copy`, which writes
   `<model>/refined/` and installs only after they have compared it.

## Orchestrating a batch

One refiner subagent per model, `subagent_type: "general-purpose"`, `model: "fable"`, `effort: "medium"`, in
the background, **four at a time**; start the next as one finishes. Each gets its own throwaway clone of the
repo for `finalize`, so installs never race; when a model finishes, install its GLB into the user's repo
yourself (`skyline_tool.py install`, then `check`), one at a time. Briefs are in `references/subagents.md`:
the refiner brief, and a reviewer brief for fresh eyes (when the refiner can't spawn one, it plays the
reviewer from that brief itself, before reading its own build script). Keep a ledger (model, minutes,
tokens, gate, check, installed, reverted).

Before the first refine of a repo, make sure it has the current integration (`skyline-integration: v4` at the
top of `src/night.js`; `skyline_tool.py install` upgrades older versions): v4 is what draws the facade detail.

## One refine pass (what a refiner does)

```
python <SKILL>/scripts/refine_tool.py start   <MODEL> [--copy]
python <SKILL>/scripts/refine_tool.py compare <MODEL> --tag before [--photo NAME:BEARING:ELEV:LENS[:TARGET_Z]]
   (review: list the top discrepancies with corrections in meters; see references/subagents.md#reviewer)
   (fix the build script, using references/fidelity-recipes.md)
python <BUILD>/scripts/run_blender.py <WORK>/build_<stem>.py -- --out <WORK>
python <SKILL>/scripts/refine_tool.py compare <MODEL> --tag round1
   (second review on the round-1 sheet; fix; rebuild)
python <SKILL>/scripts/refine_tool.py compare <MODEL> --tag after
python <SKILL>/scripts/refine_tool.py gate    <MODEL> [--complex] [--allow-height-change]
python <SKILL>/scripts/refine_tool.py finalize <MODEL> --repo <CLONE> --city lv --id <ID> [--install-copy]
```

`<WORK>` is `<MODEL>` in place, `<MODEL>/refined` with `--copy` (`start` prints it). `start` also refreshes
`landmark_kit.py` from `<BUILD>`, which adds the helpers below without changing what old scripts build.

**Photo-matched views** make the comparison honest: for each reference photo, estimate where it was taken
from (compass bearing from the building, elevation angle, lens) and pass `--photo name:bearing:elev:lens`, so
the render shows the building from the same side as the photo.

**The gate** fails on: more than 5,000 triangles (8,000 with `--complex`), a primitive without `_GLOW`, any
`COLOR_0`, mesh errors or open islands in the build report, or a top that moved more than 1% from the
previous version (pass `--allow-height-change` only for a deliberate, sourced correction).

**The app check** in `finalize` uses `--shot ...:auto:...`: the probe casts rays from eight bearings and picks
the side from which neighbors hide the least of the building, so a check is never just a neighbor's wall.

## What to improve, in order

1. Silhouette: roofline shape, setbacks, tower position and inset on its podium, crown.
2. Major bands and fins that read from a distance (spandrels, balcony edges, piers).
3. Facade fidelity: mark the facade glass with `windows=` so the app draws lit windows at night and, with the
   v4 integration, a mullion and floor grid, uneven panes and the sky's reflection by day, at no geometry
   cost. Add geometric fins or bands only where they are bold enough to read.
4. Night lighting: match the night photo; keep most surfaces low and only features bright; a podium that
   reads black needs a little warm glow.

`references/fidelity-recipes.md` maps each common problem to the kit call that fixes it.

## Report

Per model: what changed (before → after, in meters), triangles before/after, gate and check results, whether
it was installed or reverted, and the before/after sheet path. For a batch, a table plus the totals (minutes,
tokens) and the models that need a human look.
