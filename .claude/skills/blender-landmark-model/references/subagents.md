# Subagent briefs

Copy-ready prompts for the roles in SKILL.md's timeline. Fill the `<...>` fields; keep the rest. Every role
runs as `subagent_type: "general-purpose"`, `model: "fable"`, `effort: "low"` unless noted, in the background.
Launch the roles of one phase in a single message so they run at the same time.

A subagent only knows what its brief says, so each brief names the skill's scripts by absolute path, the
folder to write into, and what to send back. Ask for short reports: paths and facts, not narration.

Escalation: if a report comes back thin (see each role's "good enough"), rerun that one role once with
`effort: "medium"`, adding what was missing to the brief. Do not rerun roles that came back fine.

Contents: [refs-commons](#refs-commons) · [refs-pixabay](#refs-pixabay) · [dimensions](#dimensions) ·
[part-modeler](#part-modeler) · [reviewer](#reviewer)

---

## refs-commons

```
Find reference photos of <LANDMARK> (<CITY>) on Wikimedia Commons for building a low-poly 3D model.

Tools (run with Python; Windows paths with forward slashes, e.g. C:/Users/...):
  python <SKILL>/scripts/refs.py commons-search --out <MODEL>/refs/commons "<LANDMARK> <CITY>" "<LANDMARK> night"
  python <SKILL>/scripts/refs.py commons --out <MODEL>/refs "File:<title>" ...
  python <SKILL>/scripts/refs.py crop <image> --box x0,y0,x1,y1 --frac --out <MODEL>/refs/<name>_crop.jpg
commons-search writes commons_sheet.jpg (labels "index: title") and commons_candidates.json; look at the sheet
with the Read tool and pick by eye: search results include unrelated files.
<USER_LINKS: also fetch these with `refs.py commons` or `refs.py url`: ...>

Get, in this order of priority (stop at about 8 images):
1. one side-on view of the whole structure, as square-on as possible (proportions are read from it)
2. an aerial or three-quarter view showing the plan shape
3. close-ups of the top and of the base or podium
4. one or two night photos
Crop close-ups out of large images when a detail is small.

Report back (under 200 words): each saved file path, one line on what it shows and from which side
(compass direction if you can tell), and for the night photos what is lit and in what colors. Note any
logo, wordmark or brand sign visible on the structure so the modeler can leave it out. Write nothing else.
Good enough: at least one usable side view and one view of the top.
```

## refs-pixabay

```
Find reference photos of <LANDMARK> (<CITY>) on Pixabay for building a low-poly 3D model.

  python <SKILL>/scripts/refs.py pixabay-search --out <MODEL>/refs/pixabay "<query 1>" "<query 2>" "<query 3>"
  python <SKILL>/scripts/refs.py pixabay-get --out <MODEL>/refs --hits <MODEL>/refs/pixabay/hits.json --ids 123,456
The API key comes from the PIXABAY_API_KEY environment variable or Windows Credential Manager (entry
"pixabay.com"); the script never prints it. Do not try to read, print or pass the key yourself.
Use 2-4 queries: the landmark's name, name + city, and a night variant. Pixabay's search is loose
(other towers, products with the same name), so open hits_sheet.jpg with the Read tool and pick only images
that clearly show <LANDMARK>. Prefer sharp close-ups of the top, side elevations, and night shots.

Report back (under 150 words): each saved file path with one line on what it shows and from which side,
and any logo or brand sign visible on the structure. If Pixabay has nothing usable, say so in one line.
Good enough: two or more images that really show the landmark, or a clear "nothing usable".
```

## dimensions

```
Research the dimensions of <LANDMARK> (<CITY>) for a true-scale low-poly 3D model. Use web search and read
the pages (Wikipedia, CTBUH/Skyscraper Center, Emporis archives, architects' and engineers' pages, news on
its construction). Spend at most a few minutes; numbers matter more than prose.

Find, with a source URL for each number:
- total height to the tip, roof or main-structure height, and the heights of the key levels or sections
  (observation decks, setbacks, where legs or supports meet, base of the top element)
- plan size: footprint or base width, diameters of round parts, widths of towers or shafts
- shape facts that photos alone get wrong: number of sides or legs, tapering, setbacks, what the top is made of
- the main materials and colors of the facade
<SKYLINE: the project's data says height <h> m (<src>); compare and say which you trust>

Write the result to <MODEL>/research/dimensions.md as a table (quantity, value in meters, source, confidence)
and report the same table back. Convert feet to meters (1 ft = 0.3048 m). Flag conflicting sources rather than
averaging them. Good enough: total height plus at least three section heights or widths, each sourced.
```

## part-modeler

Use only when the build is split (SKILL.md, step 4). One brief per part, all launched together.
`effort: "low"` first; a part that fails review twice gets one rerun at `"medium"`.

```
You are modeling one part of a low-poly 3D model of <LANDMARK> in Blender, headless, while other agents
model the other parts at the same time.

Model folder: <MODEL>. Read, in order:
  <MODEL>/spec.py                  shared dimensions, COLORS, glow rules (read-only for you)
  <MODEL>/landmark_kit.py          the helper library (Builder.loft/box/block/prism/extrude/beam/strut/
                                   lattice_mast/revolve, curtain_wall/diamond_bracing/stripes patterns)
  <SKILL>/assets/examples/strat/build_strat.py   a finished example of the style
  <MODEL>/research/dimensions.md   researched numbers with sources
Your part: <PART> — <what it covers, height range, how it meets the neighboring parts>.
Write only <MODEL>/part_<PART>.py (start from <SKILL>/assets/part_template.py). Do not edit spec.py,
other part files or the build script; if you need a new material or dimension, say so in your report.
Reference photos for your part: <paths with one line each>.

Build and look, as often as useful (each run takes seconds):
  python <SKILL>/scripts/run_blender.py <MODEL>/build_<stem>.py -- --only <PART> --out <MODEL>/work/<PART> --allow-errors
  python <SKILL>/scripts/run_blender.py <SKILL>/scripts/render_views.py --blend <MODEL>/work/<PART>/<stem>.blend -- --out <MODEL>/work/<PART>/renders --views south,east,iso
Compare the renders with the photos (Read both) and fix what is off.

Rules: closed solids only (the build report's errors must be empty); stay under <TRI_BUDGET> triangles for
this part; bold shapes over fine detail (it is seen from hundreds of meters); never model logos, wordmarks,
brand signs or trademarked graphics: leave those areas as plain surfaces in the surrounding material.
Report back (under 150 words): what you modeled, its triangle count from the build report, any requests for
spec.py, and anything you could not match.
```

## reviewer

Runs in the background while the orchestrator checks the GLB and installs the model. Fresh eyes are the
point: do not include your own opinion of the model in the brief.

```
Compare a low-poly 3D model of <LANDMARK> with reference photos and list what is wrong with its shape.

Renders of the model (orthographic elevations have true proportions; *_night shows only the night lighting):
  <paths>
Reference photos, with what each shows:
  <paths + one line each>
Published dimensions: <MODEL>/research/dimensions.md

List at most 8 discrepancies, most visible first. For each: the element, what the photos show versus the
model, and a concrete correction in meters or ratios (e.g. "the pod's underside should start at 0.67 of the
total height, not 0.72"). Judge proportions and silhouette first, then major elements, then night lighting.
Ignore fine detail a low-poly model should not have, and do not ask for logos, lettering or brand signs:
they are left out on purpose. Do not edit any files. Under 250 words.
```
