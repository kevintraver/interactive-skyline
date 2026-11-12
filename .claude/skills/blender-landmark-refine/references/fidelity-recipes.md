# Fidelity recipes

From a problem the reviewer names to the kit call that fixes it. All helpers live in
`blender-landmark-model/scripts/landmark_kit.py` (`refine_tool.py start` copies the current version into the
model folder). Coordinates are meters east/north of the footprint center; heights above ground.

Contents: [roofline](#roofline-in-steps) · [podium](#podium-missing-or-at-full-height) ·
[bands](#bands-and-floor-lines) · [fins](#fins-mullions-piers) · [crown](#crown) ·
[facade glass](#facade-glass-windows-mullions-reflections) · [night](#night-lighting) · [budget](#budget)

## Roofline in steps

A swooping or tilted roof built as flat strips. Replace the strips with one solid whose top follows a function:

```python
def roof(x, y):                      # 183 m at the south end, falling smoothly to 150 m at the north end
    t = (y - Y_SOUTH) / (Y_NORTH - Y_SOUTH)
    return 150.0 + 33.0 * (1.0 - t) ** 1.4

b.extrude_sloped(outline, BAND_TOP, lambda x, y: roof(x, y) - CROWN, "Glass", max_edge=8.0)
b.extrude_sloped(outline, lambda x, y: roof(x, y) - CROWN, roof, "Crown", top="Roof", max_edge=8.0)
```

`z0` can be a function too, which is how the crown band follows the roofline. `max_edge` adds points along
long walls so a curved function is followed; sloped faces are triangulated and stay closed.

## Podium missing or at full height

The mapped footprint often includes a garage or podium drawn at the tower's height. Model the podium on the
whole plan, then the tower on an inset (or on the part of the plan the photos show as the tower):

```python
b.extrude(plan, BURY, PODIUM, "Podium", top="PodiumRoof")
tower = kit.offset_polygon(plan, -6.0)            # 6 m in from the podium edge; raises if it would fold
b.extrude(tower, PODIUM, HEIGHT, "Glass", top="Roof")
```

For a tower over only one end of the plan, cut the plan with `kit.split(plan, (a, b, c))` (the line
a*x + b*y = c; fine for a plan the line crosses twice) and keep the piece you need.

## Bands and floor lines

Bold spandrels or balcony edges that read from afar: loft the plan with a band per material.

```python
levels, mats = [BASE], []
z = BASE + EVERY - DEPTH
while z + DEPTH <= TOP:
    levels += [z, z + DEPTH]; mats += ["Glass", "Band"]; z += EVERY
levels.append(TOP); mats.append("Glass")
b.loft(kit.footprint_rings(plan, levels), mats)
```

A level can be `(height, offset_m)`: two levels at one height with different offsets make a ledge or setback
(`[0, 60, (60, -3), 120]`). Bands every 2-3 floors read better than every floor and cost a third. Where the
roof slopes, add bands as separate solids on the part of the plan still below the crown, standing 10-15 cm
proud (`kit.offset_polygon(piece, 0.12)`) so they never share a plane with the glass.

## Fins, mullions, piers

```python
b.fins(plan, BASE, TOP, spacing=6.0, depth=0.8, width=0.5, material="Fin")
```

Spaced along the whole perimeter, so curved walls built from many short edges get them too; corners sharper
than 30 degrees are skipped. Each fin is 12 triangles: 40 fins is about 500. Below roughly 0.4 m wide they
vanish at distance; prefer the app's facade grid (below) for fine mullions.

## Crown

Plain bands stay plain (no lettering). Shape matters more than detail: a sloped crown (above), a set-back
attic (`offset_polygon(plan, -2)` from the cornice up), a parapet ring (`footprint_rings` with an outward
offset level), a dome (`b.revolve` with a profile, or `b.prism` with `radius_top`).

## Facade glass: windows, mullions, reflections

Mark the facade glass, and only it, when building:

```python
b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
```

With the app's v4 integration (`// skyline-integration: v4` in `src/night.js`) those faces get, for no
geometry:
- **at night**: the city's procedural lit-window pattern (keep the glass's own glow near 0.03);
- **by day**: a mullion and floor-slab grid (3.6 m bays, 3.4 m floors) darkening the glass along the lines,
  panes that vary slightly in tone, and the sky reflected with a Fresnel falloff (little head-on, strong at
  grazing angles), tinted by the current haze so it follows day and night. The detail fades with distance so
  it never shimmers.

Leave crowns, bands, podiums and stone out of `windows`, or give stone a lower value (0.4-0.6) for punched
windows. Extruded buildings are unaffected by day.

## Night lighting

- Match the night photo: what is flood-lit, what glows from inside, what stays dark.
- A crown or LED strip: 0.8-1.2 on few faces. Bands: 0.05-0.1. Glass: 0.03 plus `windows`. Stone flood-lit
  from below: `0.15 + 0.5 * exp(-z / 30)`, not a uniform 0.8 (the "too bright" complaint).
- A podium that reads black: give its walls 0.08-0.15 warm light (shopfronts, entrances).

## Budget

5,000 triangles, 8,000 for genuinely complex buildings (`--complex`). Where it goes: a lofted band costs
2 x (plan points) triangles per band edge; a fin 12; a sloped solid about 4 x (plan points). Simplify a dense
plan before lofting many bands (fewer outline points), and let the app's facade grid carry the fine lines.
