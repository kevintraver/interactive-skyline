# interactive-skyline

[github.com/kevintraver/interactive-skyline](https://github.com/kevintraver/interactive-skyline): true-scale
three.js skylines of Salt Lake City (`slc`) and Las Vegas (`lv`). Buildings are extruded OpenStreetMap
footprints with LiDAR heights; tall ones can be hidden or dragged. This skill swaps a building's extruded
volumes for a GLB model and adds a night mode, extras, a fountain show and LED surfaces. Contents:
[data](#the-data) · [placing a model](#placing-a-model) · [install](#install) · [check](#check) ·
[running it yourself](#running-it-yourself) · [night mode](#night-mode) · [extras](#extras) ·
[fountain show](#fountain-show) · [LED surfaces](#led-surfaces) · [limits](#limits)

## The data

`public/data/<city>/buildings.json` → `buildings[]`, each:

| Field | Meaning |
|---|---|
| `id` | OSM id with a type letter: `w135457469` is way 135457469 |
| `name`, `h`, `src` | name, height in m, where the height came from (`osm-height`, `lidar`, `osm-levels`, `guess`) |
| `ground` | ground elevation in m above sea level |
| `c` | footprint center, [east, north] in m from the city origin (`public/data/cities.json`) |
| `v[]` | volumes: `o` outline (flat x,y list), `h` holes, `b`/`t` bottom/top elevation, `u` top outline of a leaning piece, `r` roof `[kind, height]` |

`data/overrides.json` holds hand corrections. Its `model` entries (the Strat `w135457469`, the Paris Las Vegas
Eiffel Tower `w27831699`) are hand-drawn pieces with heights measured from LiDAR or OSM: reuse their numbers
and read their `reason` before researching from scratch. `skyline_tool.py find` prints all of this.

World coordinates in the app: x = east, y = elevation − city `base`, z = −north. One unit is one meter.

## Placing a model

The app puts the model's origin at the footprint center `c` plus `offset` ([east, north] m), at the
building's `ground` elevation, unrotated. So:

- build the model with its origin where its real center is, axes east/north/up, true scale;
- choose `offset` so that origin lands on the real center: `find` prints each volume's center relative to `c`
  (the Strat's core sits at +3.2, +0.8 from the mapped circle's center, so its offset is `3.2,0.8`);
- a footprint-shaped building: run `skyline_tool.py footprint --repo R --city lv --id ID --out footprint.json`
  and build on those outlines (already in meters around `c`), then install with offset 0,0.

## Install

```
python <skill>/scripts/skyline_tool.py install --repo <repo> --city lv --id <id> --glb <model>.glb --offset E,N
```

Idempotent. On a repo without the integration it applies `assets/skyline/skyline-main.patch` (loader hooks,
night mode and the `initAttractions` call in `src/main.js`, a Night checkbox in `index.html`) and adds
`src/customModels.js`, `src/night.js`, `src/attractions.js` and `src/fountain.js`; for `lv` it also copies the
Bellagio show data (below). A v3/v4 repo is upgraded in place: the missing `main.js` lines are inserted (attractions
import, `led` attribute in `toGeometry`, `fountain: true, wheel: true` in DEFAULTS, the hook call at the end, and
since v6 `|| customModels.has(b.id)` in buildCity's height test) and older files replaced; pristine, v3, v4 and v5
repos all end with the same `main.js`. `upgrade --repo R --city lv` does just that, without touching a model. It copies the GLB to
`public/models/` and lists it in `public/models/models.json`:

```json
{ "lv": { "w135457469": { "url": "/models/strat.glb", "offset": [3.2, 0.8], "name": "Stratosphere Tower" } } }
```

A repo with the older hard-coded `customModels.js` (a `const MODELS = {...}` object) is upgraded: the file is
replaced by the manifest version, its entries move into `models.json`, and a backup goes to the system temp
folder. Nothing is committed. If upstream `main.js` changed so the patch no longer applies, install stops and
says so; apply the small patch by hand, then rerun.

## Check

```
python <skill>/scripts/skyline_tool.py check --repo <repo> --city lv --id <id> --out <dir>
```

Serves the repo directly (no Node, nothing written into the repo), opens it in headless Edge/Chrome with
throwaway profiles in parallel, frames the building and saves `day`, `night`, `top-night`, `wide-night` and
`highlight` screenshots plus `sheet.jpg` and `check.json`. It confirms the model really loaded by comparing
the vertices the app drew with the GLB's triangles; "the model did not load" means a wrong URL, a missing
file, or a GLB the loader rejected (see the console lines it prints). About 20 seconds. Custom shots:
`--shot LABEL:day|night:BEARING:ELEVATION:DIST:TARGET[:HIGHLIGHT]` (distance and target height as multiples of
the building's height). BEARING `auto` casts rays from eight bearings and uses the one from which neighbors hide
the least of the building (printed as "auto bearing"), which fixes checks blocked by a neighboring tower. three.js comes from the repo's `node_modules` if installed, else from jsDelivr.
`check --extra NAME` frames an extra or a fountain by name instead of a building (DIST is then a multiple of its
size, the larger of its height and half its width) and confirms an extra's GLB loaded the same way. Fountain shows
and LED skins are held at `--show-time` seconds into their loop (default 47) so shots repeat; a shader that fails
to compile fails the check and its log is printed.

## Running it yourself

`npm install` (or pnpm) then `npm run dev` needs Node 22.12+ for the project's Vite 8. On older Node, run
`npx --yes vite@5 --port 5173` from the repo instead; it serves the same code. If npm skipped the bundler's
native binding ("Cannot find native binding"), that is the same Node-version cause. Open
`http://localhost:5173/?city=lv`, tick Night in Settings for night mode, and click the building in the list to
center on it.

## Night mode

`src/night.js` patches the building materials (`onBeforeCompile`) to add emissive light scaled by one shared
uniform: the model's `glow` attribute (from `_GLOW`) plus procedural lit windows, everywhere on extruded
buildings and on a model only where its `windows` attribute (from `_WINDOWS`, set by the kit's `windows=`)
asks for them. No lights or draw calls are added. Since v4, the same marked facade glass also gets day
detail: a mullion and floor-slab grid, slightly uneven panes, and the sky reflected with a Fresnel falloff
(tinted by the current haze, so it follows day and night), fading with distance; extruded buildings look
exactly as before by day. Since v5, marked glass on a model may slope up to about 60 degrees from vertical
(a pyramid's faces): bays run along the face's horizontal direction and floors stay level; extruded buildings
keep vertical walls only. The integration files start with a `// skyline-integration: vN` line; `install`
replaces older versions. `main.js` switches sky, fog color (which keeps its own copy of the haze color),
hemisphere light, a dim moon in place of the sun, and a street-light glow on the ground photo.

At night a surface's light is its `_GLOW` plus windows; hemisphere and moon add only about 1-2 % on a white
face. Glow is set per face corner and interpolated, so a tall face whose top corners get the crown's glow is lit
crown-bright all the way down: decide glow from the face `center` (or split the face at the crown line).

## Extras

Structures that are not buildings in the app's data (the Fremont Street canopy, the High Roller, the Luxor
beam) go under a top-level `extras` key of `models.json`, by city:

```json
"extras": { "lv": [{ "name": "High Roller", "url": "/models/high_roller.glb", "east": 455.0, "north": -60.0,
                     "rotation_deg": 0, "visible": "always" }] }
```

```
python <skill>/scripts/skyline_tool.py install --repo R --city lv --extra "High Roller" --glb high_roller.glb --east 455 --north -60 [--rotation DEG] [--visible night] [--blend additive]
```

`install --extra` upserts the entry by name and copies the GLB; `locate` turns lat/lon into east/north. The model
is built like a building model (origin at its center on the ground, +X east, +Y north) and stands on the app's
terrain (`groundY`) at that spot, turned `rotation_deg` counter-clockwise from east. Extras are static, not
removable or clickable, lit at night by the same shader (`_GLOW`; lit windows only where `_WINDOWS` is set), and
`"visible": "night"` shows one only at night. `"blend": "additive"` (a light beam) draws no surface: only its
glow, added as light. `src/attractions.js` loads them; `window.__skyline.attractions.find(name)` returns the mesh.

**Spinning extras** (v6; the contract is `references/spin-contract.md`): a wheel GLB keeps a
`Rotor` node (origin at the hub, turning about its local axle, Blender +Y = glTF -Z) with `Cabin_*` children
(origins at their pivots, modelled level). `install --extra ... --spin-period 180 [--spin-direction -1]` adds
`"spin": {"node": "Rotor", "period_s": 180, "direction": 1}`; the app then draws the static parts, the rotor and
each cabin as separate meshes (same night material), turns the rotor and turns each cabin back about its pivot so
it stays level. Settings gets "Wheel turns" (default on, saved). Frames: at most 12 a second, only while a wheel
is in view within 3 km, none for a hidden tab. Without `spin`, or without a `Rotor` node (install warns), the GLB
draws at rest pose. `check --extra` counts all of a wheel's meshes against the GLB and reports
`spin.angle_deg` (held by `--show-time`: at 47 s a 180 s wheel stands at 94 degrees).
Long, low extras (height under a third of their size, like the Fremont canopy) get a steeper camera (55 degrees)
in check's default shots, so they show between buildings.

## Fountain show

For `lv`, install adds the Fountains of Bellagio on Lake Bellagio (in front of w25723909) as
`public/models/attractions/bellagio.json`, listed under `"fountains": {"lv": [...]}` (an empty list there turns it
off for good). The data is offline: the lake outline (OSM way 22971030) and 1,214 nozzles laid on the layout
mapped in OSM relation 19511963 (a 251 m curved front line, two concentric rings of 28 and 19 m, two small rings
of 9 m), in the published types and heights: 208 oarsmen (23.5 m), 798 mini-shooters (30.5 m), 192
super-shooters (73 m), 16 extreme-shooters (140 m). `src/fountain.js` draws every jet as one InstancedMesh (one
draw call, about 36k triangles) of soft camera-facing ribbons with mist puffs, animated in the vertex shader from
a shared clock through an 80 s loop: oarsmen sweep (0-16 s), a wave down the line with crossing oarsmen and
chasing small rings (16-30), ring pulses with ring shooters on the beat (30-44), a shooter chase down the line
(44-58), the finale with every jet up and the 140 m shooters (58-70), then mist. White and see-through by day,
lit from below at night. Settings gets a "Fountain show" checkbox (default on, saved with the other settings).
`scripts/make_fountain.py LAKE.json NOZZLES.json OUT.json` rebuilds the data from two Overpass results (the lake
way with `out geom`; `relation(19511963);node(r);out body;` for the nozzles), in the same frame as `locate`.

## LED surfaces

Faces whose glTF material name starts with `Led` followed by a capital, digit, `_` or nothing (`LedSkin`,
`LedCanopy`, `LedRim`; not `Ledge`) get `led = 1` in `customModels.js`, on building models and extras alike.
`night.js` adds slowly drifting color bands with soft noise on them (abstract only: no text, logos or show
content), strong at night and faint by day, on top of the material's own `_GLOW`. Give LED materials a moderate
base glow so they still read when the pattern is dark.

The app renders on demand. `attractions.js` asks for frames only while the show is on and the lake is in view
within 4 km (30 a second), an LED surface is in view within 3 km (15), or a wheel turns in view (12); otherwise,
and for a hidden tab, it adds no frames at all.

## Limits

- Since v6 a building with a model is drawn from it whatever its height (the Luxor sphinx is 31 m), and joins
  the removable buildings; before v6 only buildings at or above the height cutoff (default 35 m) were.
- Models use flat material colors: textures and vertex colors in the GLB are ignored, so color comes from
  materials and night light from `_GLOW`.
- The upstream app may change; the patch was made against commit `c725477` ("Map-style controls and a
  hand-modelled Eiffel Tower").
- Extras cannot be hidden or moved, and only GLB colors, `_GLOW`, `_WINDOWS` and Led material names carry over.
