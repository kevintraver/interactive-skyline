# Subagent briefs

Contents: [refiner](#refiner) · [reviewer](#reviewer)

## refiner

One per model, `subagent_type: "general-purpose"`, `model: "fable"`, `effort: "medium"`, background, four at a
time. Fill the `<...>` fields (`<REFINE_SKILL>` is this skill's own folder).

```
Refine an existing low-poly landmark model: <NAME> (id <ID>, city <CITY>), model folder <MODEL>.
Follow the skill at <REFINE_SKILL> (read its SKILL.md and
references/fidelity-recipes.md first). Mode: <in place | --copy>.

Your own repo clone for finalize (create it first; it is yours alone):
  git clone -q <USER_REPO> "<CLONES>/<stem>-refine"
Do not touch <USER_REPO> itself; the orchestrator installs your result there.

Known issues from the build report: <flags, e.g. "podium extruded to full height", "roofline in steps">.

Limits: 10 minutes of wall time, a cost cap (about $5): two review-fix rounds, then finalize and stop.
You cannot launch subagents: play the reviewer yourself from references/subagents.md#reviewer, on the
compare sheet, BEFORE you reread the build script, so the review is about what the photos show.
Rules: headless Blender only (never the Blender MCP); no logos, wordmarks or brand signs; keep everything
procedural in the build script; absolute paths in every command; budget 5,000 triangles (8,000 if the
building is genuinely complex: pass --complex); keep the height unless a published source says otherwise.
Mark the facade glass with windows={...} (the app draws lit windows at night, mullions and reflections by day).

Steps: refine_tool.py start, compare --tag before (with --photo views matched to the reference photos), review,
fix, rebuild, compare --tag round1, review, fix, rebuild, compare --tag after, gate, finalize --repo <your clone>.
If finalize reverts, report why; do not loop.

Report back in under 150 words: what changed (with meters), triangles before/after, gate result, finalize
result (installed or reverted), and the paths of compare-before/compare.jpg and compare-after/compare.jpg.
```

## reviewer

For a separate reviewer subagent (`effort: "low"` is enough), or for the refiner to play from the compare
sheet before rereading its own code. Fresh eyes are the point: no opinion of the model in the brief.

```
Compare a low-poly 3D model of <NAME> with reference photos and list what is wrong with its shape.
Sheet: <WORK>/compare-<tag>/compare.jpg (photos first, then the model's renders; *_night shows only its night
lighting; south/east views are orthographic, so proportions are true; photo-* views match a photo's camera).

List at most 6 discrepancies, most visible first: silhouette and roofline, setbacks and podium, crown shape,
band or fin spacing, facade color, night lighting. For each, say what the photos show versus the model and a
concrete correction in meters or ratios ("the roof falls from 183 m at the south end to about 150 m in one
smooth curve, not in 12 steps"; "the podium is about 14 m high and the tower sits about 6 m in from its
edge"). Ignore detail too fine to read from 300 m. Never ask for logos, lettering or brand signs: they are left
out on purpose. Under 200 words. Do not edit files.
```
