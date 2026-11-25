# 737-800 dimensions for the window-seat airframe (plan 03, F3.1)

`../spec.py` holds every number as a `Dim(value, unit, source, note)`. This file says what was fetched,
how the drawings were measured, and where the sources disagree. Fetched 23 November 2026 with a generic
user agent; the downloads were kept out of the repository.

## What was read

| Key | Document | What it gave |
| --- | --- | --- |
| B1 | Boeing D6-58325-7 rev C (Oct 2025), 342 pages | Length, span, tail height (p. 2-14), ground clearances (p. 2-18, 2-19), cross-section (p. 2-29), doors (p. 2-33 to 2-37), gear footprint and tyres (p. 7-5); the plan, side and front views of p. 2-14 traced for shapes |
| B3 | b737.org.uk, archived 2025: techspecsdetailed, flightcontrols, winglets | Fuselage 3.76 × 4.01 m; wing area 124.58 m², MAC 3.96 m, quarter-chord sweep 25.02°, dihedral 6°, root incidence 1°, thickness 14% root and 11.5% tip (published for the older wings); fin and tailplane; fan 61 in, nacelle 2.06 m; flaps double slotted, flap span ratio 0.599, area ratio 0.300; flight spoilers "33/38 degrees"; aileron about 20°; winglet "8ft 2in tall and about 4 feet wide at the base, narrowing to approximately two feet at the tip" |
| B4 | NTSB AAR-19/03, s. 1.7.1 | "The exterior cabin window by seat 14A measured 10 1/2 inches horizontally, 14 3/8 inches vertically, and 15 inches diagonally"; acrylic outer and middle panes, structural, silicone seal; non-structural inner pane |
| B5 | Aircraft Drafting Services ADS00021, 737-800 189Y study LOPA | Body stations: door 1L STA 328, service door STA 314, overwing exits STA 589.5 and 627.5, aft door STA 975; lettered plug stations ("STN 727F+17.95") |
| B8 | 737 NG Systems Summary, Flight Controls (reposted) | "four flaps and eight slats: two flaps inboard and four slats outboard of each engine"; "Four flight spoilers ... on the upper surface of each wing"; "four ground spoilers, two on the upper surface of each wing"; detents "1, 2, 5, 10, 15, 25, 30 or 40"; slats to "extend" at 1, 2 and 5 and "full extended" beyond 5 |

Not fetched: B2 (EASA data sheet; nothing here needed it), B7 (the blank-window article: it is cited only for
why the blanks exist; where they are comes from B6), B9 (wing frequency quoted from the plan, tagged as such),
B10 (light colours are the regulation's well-known red left, green right, white aft; positions are ESTIMATED).

Fetched 24 November 2026 for the cabin (F3.5, F3.6), with a generic user agent, kept outside the repository:

| Key | Document | What it gave |
| --- | --- | --- |
| B6 | aeroLOPA fr-738, the neutral to-scale seat map (`fr-738.neutral.webp`, 800 × 4213 px) | Every window centre station on both sides, both blanks, and the windows covered by the galley and lavatories (see below) |
| B1 | p. 2-30, cabin cross-section, six abreast (traced at 300 dpi, 8.38 px/in) | Trim to trim 139.2 in; the trim's shape (a circle of half that about the line of max breadth, within 1.5 cm from 0.3 to 1.4 m above the floor; 3 cm inboard of it at the floor); bins: lip 62.2 in and underside at the wall 66 in above the floor, 45.5 in between the lips; ceiling 86.6 in; seat 17 in, triple 59 in, aisle 20 in |
| B1 | p. 2-14, side view (1200 dpi, 148.8 px/m) | The overwing hatch's top 1.17 m and sill 2.08 m below the fuselage top: 0.41 to 1.32 m above the floor, the bound on the window's height |
| B5 | view C-C (600 dpi, 10.56 px/in) | The seat: cushion top 17.2 in, armrest 24.3 in, back top 45.0 in above the floor; seat front to reference point 18.5 in; back shell about 3.8 in deep; exit-row pitch 38 in |

## Window stations, traced from B6

The seat map draws each window as a dark tick on the fuselage edge and each window that a monument covers as a
faint outline. Tick centres were found by thresholding the two bands along the fuselage edges (dark runs 26 to
34 px long; two wing-root artefacts and the exit-hatch arrows excluded by length and by eye). Both sides' ticks
agree within 2 px wherever both have one, so each position is the mean of the two.

The scale is set piecewise by four things the map also draws, with their published stations: door 1L's centre
(y 692 px, 5.03 m, [B1] p. 2-33), the two overwing exit windows (y 2166.75 and 2287.75 px, 16.70 and 17.67 m,
[B5]) and the aft doors' centre (y 4066 px, 31.88 m, [B1] p. 2-37): 126.3 px/m ahead of the exits and 125.1
behind. A single straight fit through all five anchors (right door included, 4.76 m) leaves residuals of 0.6 to
5.7 cm, mostly the doors' centres read by eye, so the stations are good to about 3 cm absolute; relative to
each other, about 1 cm.

Results (`spec.WINDOWS`):

- **Right: 46 windows**, 5.588 to 30.470 m. The first two (5.59, 6.10 m) and the last (30.47 m) are the faint
  outlines, behind the forward galley and the aft lavatory in that airline's layout; the fuselage has them.
- **Left: 44 windows**, 6.102 to 30.470 m: no window at 5.59 m (door 1L is wider and further aft than the right
  service door) and a blank at 13.58 m.
- **Blanks**: 14.656 m on both sides (between 14.13 and 15.19 m, two pitches with nothing), and 13.58 m on the
  left (between 13.03 and 14.13 m). Plan 7.4's "about 13.6 m (left) and 14.7 m (both)" and its counts of 44 and
  46 are confirmed.
- **Pitch**: 20.0 to 20.9 in (mean 20.3) over the original fuselage, 21.1 to 23.3 in (mean 21.6) through the
  plugs (9.7 to 14.1 m and 17.7 to 22.7 m), and 18.9 to 19.2 in in the three bays just ahead of the exits, which
  may be the map's drawing rather than the aircraft.
- **Exits**: the two exit windows fall on [B5]'s exit stations within the fit (they are two of its anchors).

With these stations the seats beside a blank are exactly 10A, 11A and 11F, as plan 7.4 said. The default-seat
rule of plan 4.3 now gives **23F**, not 21F or 22F: 21F's window is 22.67 m aft of the nose, 1.19 m behind the
traced trailing edge at the root (21.48 m), a centimetre short of the rule's 1.2 m, and 22F's window is 17 cm from
the eye (the rule allows 15). The rule is the specification, so 23F stands; both misses are inside the
stations' 3 cm uncertainty.

## Still estimates (cabin)

- The window's centre above the floor (0.97 m): no source prints it. Bounded by the overwing hatch traced on
  [B1] p. 2-14 (0.41 to 1.32 m above the floor), with photographs putting the window in the hatch's upper half.
- The corner radius, the reveal's flare (3.5 cm), the bezel (4.5 cm wide, 8 mm proud), the inner pane's depth
  (6.7 cm behind the trim face) and the pane gaps; the shade's travel (0.40 m).
- The seat layout itself (section 7.4's generic cabin: 30 rows at 31 in, the eye 0.55 m aft of the seat front
  and 1.20 m above the floor, the back's face 0.72 m aft). The model rakes the seat back 18° so that its face at
  the eye's height is at 0.72 m; [B5]'s drawn seat is more upright (about 12°).
- The tray table's size; the bin's section between the published lip and wall heights.

## Tracing p. 2-14

The page was rendered at 8× (576 px per inch of paper) and the blue outline pixels extracted. The scale is
72.00 px per metre of airframe: nose to tailplane tips is 2842 px for the printed 39.47 m, and the span over
the winglets is 2577 px for the printed 35.79 m, so both agree to 0.01 m. Outlines are double lines about
0.12 m apart; the outer line is used and the plan-view half widths are scaled by 1.88/1.95 so the fuselage
width matches the printed 3.76 m.

Results, metres aft of the nose (x) and out from the centre line (y):

- **Wing leading edge**: x = 15.15 + 0.706 (y − 2.2) inboard (35° glove), x = 18.01 + 0.514 (y − 6.5)
  outboard (27°); they cross at y = 5.53. At the body side (y = 1.88) x = 14.92; at the bare tip (y = 17.16)
  x = 23.49, against 23.47 printed on p. 2-13.
- **Trailing edge**: x = 21.48 inboard, unswept, to y = 5.52; then x = 21.62 + 0.289 (y − 6) (16°). Chord at
  the body 6.56 m; at the kink 3.98 m; at y = 17 m 1.40 m.
- **Engine**: inlet 13.36 m (printed); fan nozzle 16.2 m, core nozzle 16.76 m, plug tip 17.30 m (traced).
- **Tailplane**: LE x = 34.18 + 0.72 (y − 2), TE x = 37.80 + 0.32 (y − 2); tip trailing edge 39.44 m (the
  overall length). The traced planform has about 40 m² against [B3]'s 32.78 m² (perhaps without elevators);
  the drawing's shape is used.
- **Fin**: a dorsal fillet to 6.3 m over the drawing's ground line, then LE 36° and TE 11°; tip at 12.6 m.
- **Fuselage**: plan half width and side top/bottom by station (`FUSELAGE["plan"]`, `FUSELAGE["side"]`).

## Heights: three frames that had to be reconciled

1. **The airframe sits nose-down on its gear.** At empty weight the forward door sill is 2.74 m above the
   ground and the aft one 3.12 m (p. 2-19). Both sills are at floor level, so the floor tilts 0.81° nose-down
   between 5.03 m and 31.88 m. The model is built in body axes (fuselage datum level, origin on the main-gear
   contact plane), which puts the floor at 2.95 m everywhere and the nose-wheel contact 0.22 m above the
   main-wheel plane. A height h from the ground at station x becomes h + (19.69 − x) tan 0.81°.
2. **The drawing's ground line is not to scale.** On p. 2-14 the fuselage is drawn with its top 4.90 m over
   the ground line, where the clearance table, taken to body axes, says 5.44 m. Side-view heights are
   therefore shifted +0.54 m and front-view heights +0.41 m, chosen so the drawn belly falls on the
   body-axis belly (5.44 − 4.01 = 1.43 m). Checks after the shift: engine bottom 0.68 m (table: 0.71 m);
   winglet top 6.61 m (table: 6.67 m); tailplane tip 5.4 to 5.5 m (table: 5.37 m).
3. **The drawn fin is too tall.** After the shift its tip would be 13.1 m in body axes, but the table
   (12.62 m at empty weight) and the printed 12.55 m say about 12.3 m. Fin heights above the root are scaled
   (`spec.fin_z`) to put the tip at 12.57 m above the ground on the gear, within 1% of both figures. [B3]'s
   fin height of 7.16 m agrees with the table, not the drawing.

The table's bare wingtip height (3.91 m, for the -800 without winglets) is 0.3 m above the drawn wing's lower
line extended at 6°; the drawing is used, because with the table's figure the wing root would pass through
the cabin floor.

## Body stations

The study LOPA [B5] numbers body stations the Boeing way: the stretch plugs are lettered, not counted. Door
1L at STA 328 is 5.03 m from the nose (so the nose is STA 130); the exits at STA 589.5 are 16.70 m from the
nose; the aft door at STA 975 is 31.88 m. That makes the forward plug (from STA 360) 198 in and the aft plug
(from STA 727) 212 in, and `spec.body_station_to_x` converts.

## Estimates worth checking first

- Window height above the floor (0.97 m) and corner radius (the stations are traced since 24 November: see
  "Window stations, traced from B6").
- Flap travel and angle per detent; slat droop; Krueger rotation; spoiler panel spans and which are ground
  spoilers; flap-track fairing positions; aileron span.
- Gear trunnion positions and retraction angles.
- Every light position.
- The aerofoil (a generic cambered section with the published thickness ratios) and the 2° washout.
