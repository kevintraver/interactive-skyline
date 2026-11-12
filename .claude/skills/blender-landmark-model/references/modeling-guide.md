# Modeling guide

How to turn photos and published numbers into a build script that reads well from a distance.
Contents: [numbers from photos](#numbers-from-photos) · [recipes](#recipes-from-shape-to-kit-call) ·
[budgets and detail](#budgets-and-detail) · [color](#color) · [night glow](#night-glow) ·
[logos and trademarks](#logos-and-trademarks) · [mesh hygiene](#mesh-hygiene) · [orientation](#orientation)

## Numbers from photos

Published figures give a few heights; photos give everything in between. Use a square-on side view taken
from far away (long lens, little vertical convergence) and read ratios, not pixels:

1. Crop the structure (`refs.py crop`) so its base and tip are both visible.
2. Note the pixel rows of the base, the tip, and every visible break: setbacks, where legs meet, the
   underside and top of a pod, the base of a spire. Note widths at the same rows.
3. Divide by the base-to-tip pixel height and multiply by the published height. Widths scale the same way
   (correct for viewing angle: a hexagon seen across a corner is wider than across a face).
4. Cross-check with a second photo from another side or with the researched numbers; when they disagree,
   prefer measured or published values and say which you used in the script's source notes.

Photos from below exaggerate the top and shrink the base, and aerial photos the reverse: use them for shape
and detail, not proportions. The model's orthographic renders (`render_views.py --views south,east`) are the
thing to hold against the side photo.

## Recipes: from shape to kit call

| Element | Kit call | Notes |
|---|---|---|
| Round or polygonal shaft, frustum | `b.prism(r, z0, z1, n, mat, radius_top=...)` | 8-16 sides for shafts; 24 for big round pods |
| Spire, pointed roof | `prism(..., radius_top=0)` | |
| Curved or varying shaft, legs | `b.loft(rings, mat)` with `lerp_table` stations | one ring every 10-25 m of height, more where it bends |
| Pod, dome, saucer, any round profile | `b.revolve(profile, segments, patterns)` | profile is (radius, height, band) bottom-up; equal heights make flat rings |
| Glass band with mullions, braced cone, stripes | a pattern band in `revolve` | coplanar pieces: no extra geometry outline, closed skin |
| Rectangular tower, podium, setbacks | `b.block(center, hx, hy, z0, z1, mat, turn_deg, top=)` | stack blocks for setbacks; each block a closed solid |
| Irregular footprint | `b.extrude(points, z0, z1, mat)` | points in meters, any winding; concave is fine |
| Building on a mapped footprint | `fp = kit.load_footprint("footprint.json")`, then `b.extrude(v["outline"], ...)` per volume | exact plan from `skyline_tool.py footprint`; offset 0,0 |
| Tower inset on its podium, setback, ledge | `kit.offset_polygon(plan, -6.0)` | mitered offset (d < 0 shrinks); raises instead of folding the outline |
| Banded facade, setbacks in one solid | `b.loft(kit.footprint_rings(plan, [0, 60, (60, -3), 120]), ["Glass", "Ledge", "Glass"])` | a level is a height or (height, offset_m); one material per band |
| Sloping or swooping roofline | `b.extrude_sloped(plan, z0, roof_fn, "Glass", top="Roof", max_edge=8)` | roof_fn(x, y) -> height; z0 may be a function too (a crown band that follows the roof) |
| Vertical fins, piers, mullions | `b.fins(plan, z0, z1, spacing, depth, width, "Fin")` | spaced along the whole perimeter (curves too); 12 triangles each |
| Lattice mast, truss tower | `b.lattice_mast(...)` | girts plus an X per bay per face |
| Arms, braces, rides, cantilevers | `b.beam(bearing, (r,z), (r,z), hw, hd, mat)` or `b.strut(a, b, half, facing, mat)` | |
| Anything else | `b.face(verts, mat)` on `b.bm.verts.new(...)` | keep it closed |

`assets/examples/strat/build_strat.py` uses most of these: a hyperbolic leg profile lofted through stations,
a revolved pod with two pattern bands, a lattice mast, beams for rides.

## Budgets and detail

| Landmark | Triangles |
|---|---|
| Simple tower or block building | 300-1,500 |
| Distinctive tower with a detailed top | 2,000-6,000 |
| Very complex structure (lattice, many parts) | up to 10,000 |

What counts is what reads from 300 m to 3 km away. Make small things bold rather than accurate: a 10 cm
mullion becomes 0.4 m, a hundred window columns become forty-eight. Leave out what disappears at that
distance (railings, small vents, signs). A silhouette that is right beats surface detail every time.

## Color

Pick sRGB hex values from daylight photos, from a mid-tone patch away from highlights and shadows. White
concrete and paint are rarely pure white (`EDE6CC`, `F2F2EE`); glass from outside is dark (`1C222A`-`2E3640`).
Give a distinct material to every element whose color or night lighting differs, even if two share a
color, so `glow()` can tell them apart. Never take colors from a logo or sign.

## Night glow

`glow(material, corner, face_center)` returns linear RGB per face corner. Read it off night photos:

- Flood-lit structure: moderate light (0.3-0.9), usually brightest near the floodlights and fading with
  distance; `exp(-z / 50)` falloffs give that cheaply.
- Glass with lit rooms behind: in interactive-skyline, mark it with `windows={"Glass": 1.0}` and keep its
  glow near 0.03: the app then draws its scattered lit-window pattern on it, matching the extruded city. For
  other targets, low warm light (0.05-0.15) instead. Many windows at 1.0 make a white blob.
- Feature lighting (colored rings, a lit spire, a beacon): the brightest values, 0.8-1.5, on few faces.
- Mullions, roofs, unlit steel: near zero. Dark parts are what make the lit parts read.
- Vary by height or by angle around the axis (`atan2(center[1], center[0])`) for bands and bulb rings.
- Zones by height (crown wash, shaft, base): decide them from `face_center`, not the corner. A pier or wall
  face that runs base to cornice in one piece otherwise gets the crown value at its top corners and the base
  value at its bottom ones, and the GPU smears the crown's wash down the whole shaft. Use the corner only for
  smooth gradients you want, such as a falloff.

The night render (`render_views.py`, mode night) shows exactly this attribute on a dark background.

## Logos and trademarks

Never model logos, wordmarks, brand names, mascots or trademarked graphics, even when they are prominent on
the building (a casino's name on its tower, a brand sign on a crown, lettering on a pod). Model the surface
they sit on in the surrounding material, or leave a plain panel of a neutral color. Do not put brand names
in material names, object names or glow patterns either; name things for what they are ("CrownSign"
becomes "CrownPanel"). Reference photos that show logos are fine to use for shape; just skip the logo.
Generic architectural lighting (floodlights, colored bands) is fine; a lit logo is not.

## Mesh hygiene

- The model is a set of closed solids that may overlap; it is never boolean-merged. Each island must be
  closed (`open_islands` 0) with positive volume; the build report lists errors and warnings.
- Overlapping solids are fine, but two faces in the same plane flicker (z-fighting). Offset touching faces by
  5 cm or more, or make the detail a pattern band instead of a plate on top.
- `finish()` recomputes normals; an island reported inside-out has a face wound against its neighbors.
- Keep n-gons flat (the report warns). Split bent quads into triangles.
- Sink the base `BURY` (about 2 m) below zero so it meets uneven terrain without a gap.
- Each sharp edge (over 30 degrees) of a small part draws an outline line in apps that use EdgesGeometry
  (interactive-skyline's highlight mode); patterns and smooth curves do not.

## Orientation

`polar()` and `beam()` take math bearings (degrees counter-clockwise from east); photos and maps use compass
bearings (clockwise from north): convert with `kit.compass_to_math`. Get orientation from an aerial photo, the
OpenStreetMap footprint, or `skyline_tool.py find` (longest edge bearing, volume centers). Put the origin at the
structure's center or main axis, not at a corner, so a `--offset` places it precisely.
