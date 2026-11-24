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

Not fetched: B2 (EASA data sheet; nothing here needed it), B6 and B7 (seat maps and the blank-window
article: the window counts and blanks are taken from plan section 7.4, and every window station is tagged
ESTIMATED), B9 (wing frequency quoted from the plan, tagged as such), B10 (light colours are the regulation's
well-known red left, green right, white aft; positions are ESTIMATED).

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

- Window stations (the rule is in `WINDOWS["right"]`'s note), window height above the floor (0.97 m), corner
  radius.
- Flap travel and angle per detent; slat droop; Krueger rotation; spoiler panel spans and which are ground
  spoilers; flap-track fairing positions; aileron span.
- Gear trunnion positions and retraction angles.
- Every light position.
- The aerofoil (a generic cambered section with the published thickness ratios) and the 2° washout.
