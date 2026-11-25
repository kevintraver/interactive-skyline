"""Every dimension of the generic 737-800-class airframe (plan 03, task F3.1), each with its source.

The rule: no number without a source line or an ESTIMATED tag. Each number lives in a `Dim` whose `source`
names one or more references from SOURCES (B1..B10 of the plan's section 13, plus CFR) and whose `note`
quotes the line used or says how it was measured; or whose source is ESTIMATED, with the basis in the note.
tests/python/flight/test_aircraft_spec.py enforces this for every capitalised module-level name.
research/dimensions.md tells the story: what was fetched, what was traced, and where the sources disagree.

Frames used here (the build converts to the model's axes):
  x   station: metres aft of the nose tip, along the fuselage datum (the drawings' horizontal)
  y   buttock line: metres from the centre line, positive to the right (starboard) wing
  z   height in BODY axes: metres above the plane through the main-gear tyre contact points, parallel to the
      fuselage datum. On its gear at empty weight the airframe sits GROUND_ATTITUDE nose-down, so a height
      measured from the ground in [B1] at station x converts as z = h + (main_gear - x) * tan(attitude).
The model's axes (section 5.5): nose -Z, right wing +X, up +Y, origin on the centre line at the main-gear
contact point, i.e. (X, Y, Z) = (y, z, x - main_gear).

"Traced" means measured by this task from the vector drawing on page 2-14 of [B1] (General Dimensions:
737-800W), rendered at 576 px per inch of paper (72.0 px per metre of airframe, calibrated so that the
printed 39.47 m length and 35.79 m span both come out exact); the drawing's outlines are double lines and
the outer line is used. The drawing's own ground line is not to scale (see dimensions.md), so its heights
are re-referenced to the fuselage belly (side and front views separately) before use.

Pure Python with no imports beyond the standard library: Blender's Python and pytest both load it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

ESTIMATED = "ESTIMATED"
_IN = 0.0254  # metres per inch: a unit conversion, not a dimension
_FT = 0.3048  # metres per foot

SOURCES = {
    "B1": "Boeing, 737 Airplane Characteristics for Airport Planning, D6-58325-7 rev C, October 2025: "
          "https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737NG_REV_C.pdf",
    "B2": "EASA type-certificate data sheet for the 737: https://www.easa.europa.eu/en/downloads/7297/en",
    "B3": "The Boeing 737 Technical Site, archived 2025: techspecsdetailed.htm, flightcontrols.htm, "
          "winglets.htm, landinggear.htm at https://web.archive.org/web/2025/http://www.b737.org.uk/",
    "B4": "NTSB accident report AAR-19/03, section 1.7.1 Cabin Window: "
          "https://www.ntsb.gov/investigations/AccidentReports/Reports/AAR1903.pdf",
    "B5": "Aircraft Drafting Services, B737-800 189Y study LOPA, drawing ADS00021 rev A: "
          "http://aircraftdrafting.ie/wp-content/uploads/2014/07/LOPA_ADS_B737-800.pdf",
    "B6": "aeroLOPA, to-scale 737-800 seat maps with window positions: https://www.aerolopa.com/fr-738",
    "B7": "Alaska Airlines, why some window seats have no window: "
          "https://news.alaskaair.com/alaska-airlines/mystery-solved-aircraft-windowless-window-seat/",
    "B8": "Boeing B737 NG Systems Summary [Flight Controls], as reposted: "
          "https://aerocadet.com/cbts/pdf/B_NG-Flight_Controls.pdf",
    "B9": "NASA flight-data study, wing bending near 2.4-2.7 Hz on a 737-100: "
          "https://ntrs.nasa.gov/api/citations/20010045674/downloads/20010045674.pdf",
    "B10": "Aircraft lights: 14 CFR 25.1385-25.1401 and AIM 4-3-24: https://www.ecfr.gov/current/title-14",
    "CFR": "14 CFR part 25 (airworthiness standards, transport category): https://www.ecfr.gov/current/title-14",
    "B13": "Reference-speed and attitude tables from the type's crew reference (QRH), as publicly reposted, plan 03 "
           "[B8]: https://preflightbase.com/en/737/qrh.html (values as tabled in plan 03 section 7.3; secondary copy)",
    "B14": "Training-manual pages as publicly reposted, plan 03 [B8]: approach sequence "
           "http://www.aero.cn/2011/0314/21528_62.html, flare http://www.aero.cn/2011/0314/21528_89.html, descent "
           "http://www.aero.cn/2011/0314/21528_53.html (values as tabled in plan 03 section 7.3; secondary copy)",
}


@dataclass(frozen=True)
class Dim:
    """A number (or a table of numbers) with the line it came from."""
    value: object
    unit: str
    source: str
    note: str
    _is_dim = True

    def __float__(self) -> float:
        return float(self.value)


def est(value, unit: str, note: str) -> Dim:
    return Dim(value, unit, ESTIMATED, note)


# ===================================================================================== headline figures
LENGTH_OVERALL = Dim(39.47, "m", "B1", "p. 2-14 General Dimensions 737-800W: '129 FT 6 IN (39.47 M)', nose to "
                     "the tailplane tips' trailing edge")
LENGTH_FUSELAGE = Dim(38.02, "m", "B1", "p. 2-14: '124 FT 9 IN (38.02 M)', nose to the tail cone")
SPAN_WINGLETS = Dim(35.79, "m", "B1", "p. 2-14: '117 FT 5 IN (35.79 M)' over the winglets")
SPAN_BARE = Dim(34.32, "m", "B1+B3", "[B3] techspecsdetailed: 'Span (m) ... 34.32' for the NG wing without winglets; "
                "[B1] p. 2-13 (737-800) prints the same")
TAIL_HEIGHT = Dim(12.55, "m", "B1", "p. 2-14: '41 FT 2 IN (12.55 M)' ground to fin tip; p. 2-19 table J gives "
                  "12.62 m at empty weight and 12.37 m at maximum taxi weight")
TAIL_HEIGHT_OEW = Dim(12.62, "m", "B1", "p. 2-19, Ground Clearances 737-800W: 'J VERTICAL TAIL 41 - 5 12.62' "
                      "(MAX, AT OEW)")
TAIL_HEIGHT_TARGET = Dim(12.57, "m", "B1", "built height of the fin tip above the ground on the gear: between the "
                         "12.55 m general dimension and the 12.62 m empty-weight clearance, inside 1% of both")

# ===================================================================================== stations, attitude
GEAR = {
    "nose_station": Dim(4.09, "m", "B1", "p. 2-14: '13 FT 5 IN (4.09 M)' nose to nose-gear axle"),
    "wheelbase": Dim(15.60, "m", "B1", "p. 2-14 and p. 7-5: '737-800: 51 FT 2 IN (15.60 M)'"),
    "track": Dim(5.72, "m", "B1", "p. 2-14 and p. 7-5: '18 FT 9 IN (5.72 M)' between main-gear centre lines"),
    "main_outer_width": Dim(7.00, "m", "B1", "p. 7-5: '-800: 22 FT 11.5 IN (7.00 M)' over the outer main tyres"),
    "main_wheel_spacing": Dim(0.86, "m", "B1", "p. 7-5: '34 IN (0.86 M)' between the two wheels of a main gear"),
    "nose_wheel_spacing": Dim(0.41, "m", "B1", "p. 7-5: '16 IN (0.41 M)' between the nose wheels"),
    "main_tyre_diameter": Dim(44.5 * _IN, "m", "B1", "p. 7-5: main gear tire size 'H44.5x16.5-21, 28PR' (737-800)"),
    "main_tyre_width": Dim(16.5 * _IN, "m", "B1", "p. 7-5: 'H44.5x16.5-21': 16.5 in section width"),
    "main_rim_diameter": Dim(21 * _IN, "m", "B1", "p. 7-5: 'H44.5x16.5-21': 21 in rim"),
    "nose_tyre_diameter": Dim(27 * _IN, "m", "B1", "p. 7-5: nose gear tire size '27x7.75-15, 12PR'"),
    "nose_tyre_width": Dim(7.75 * _IN, "m", "B1", "p. 7-5: '27x7.75-15': 7.75 in section width"),
    "nose_rim_diameter": Dim(15 * _IN, "m", "B1", "p. 7-5: '27x7.75-15': 15 in rim"),
    # retraction geometry: not published
    "main_trunnion_y": est(2.86, "m", "trunnion on the wing rear spar above the axle (the leg stands vertical at "
                           "half the track); the leg swings inboard into the belly well with the wheels' outer faces "
                           "showing, as the type does"),
    "main_trunnion_z": est(2.10, "m", "on the wing's lower surface at the rear spar (wing lower at that buttock "
                           "line about 1.92 m, plus the spar depth)"),
    "main_retract_deg": est(88.0, "deg", "inboard swing that lays the wheels flat in the belly well"),
    "nose_trunnion_z": est(1.82, "m", "just above the belly at the nose-gear station (belly 1.55 m there)"),
    "nose_retract_deg": est(100.0, "deg", "the nose gear folds forward and up into its well"),
    "nose_trunnion_dx": est(-0.15, "m", "trunnion slightly ahead of the axle: the strut rakes back a little"),
}

GROUND_ATTITUDE = Dim(-math.degrees(math.atan((3.12 - 2.74) / (31.88 - 5.03))), "deg", "B1",
                      "derived from p. 2-19 door sills at empty weight, 'B ENTRY DOOR NO 1 ... 2.74' and "
                      "'G ENTRY DOOR NO 2 ... 3.12', at the door stations 5.03 m and 31.88 m: the airframe sits "
                      "this far nose-down on its gear (negative = nose down)")

STATIONS = {
    "main_gear": Dim(4.09 + 15.60, "m", "B1", "nose-gear station plus wheelbase, p. 2-14: 4.09 + 15.60"),
    "plug_fwd_body_station": Dim(360.0, "in", "B5", "lettered plug stations start at 360 (the drawing's "
                                 "'STN 372.00', 'STN 392.95' lie just aft of it)"),
    "plug_fwd_length": Dim(198.0, "in", "B1+B5", "derived: body station 328 (door 1L on [B5]) lies 5.03 m aft of the "
                           "nose ([B1] p. 2-33) and the exits at STA 589.5 lie 16.70 m aft ([B5] with [B1] p. 2-14)"),
    "plug_aft_body_station": Dim(727.0, "in", "B5", "'STN 727F+17.95' on [B5]: the aft plug is lettered from 727"),
    "plug_aft_length": Dim(212.0, "in", "B1+B5", "derived: STA 975 (aft door on [B5]) lies 31.88 m aft of the nose "
                           "([B1] p. 2-37 '-800: 104 FT 7 IN (31.88 M)')"),
    "nose_body_station": Dim(130.0, "in", "B1+B5", "derived: STA 328 at 5.03 m puts the nose at body station 130"),
}

# ===================================================================================== fuselage
FUSELAGE = {
    "width": Dim(3.76, "m", "B1+B3", "[B1] p. 2-29 cabin cross-section: '148 IN (3.76 M)'; [B3] 'Width (m) 3.76'"),
    "half_width": Dim(1.88, "m", "B1", "half of p. 2-29's 148 in (3.76 m)"),
    "height": Dim(4.01, "m", "B3", "techspecsdetailed: fuselage 'Height (m) | 4.01' for every series"),
    "cabin_width": Dim(3.54, "m", "B1", "p. 2-29: 'INTERIOR TRIM-TO-TRIM 139.2 IN (3.54 M)'"),
    "floor_to_ceiling": Dim(2.20, "m", "B1", "p. 2-29: '86.6 IN (2.20 M)' floor to ceiling at the aisle"),
    "top_to_floor": Dim(2.49, "m", "B1", "traced on p. 2-29 (155.6 px/m): outer skin top to floor line 388 px"),
    "belly_to_max_breadth": Dim(2.12, "m", "B1", "traced on p. 2-29: the upper lobe is a 1.88 m circle; its "
                                "centre lies 330 px (2.12 m) above the skin's lowest point"),
    "floor_z": Dim(2.74 + (19.69 - 5.03) * math.tan(math.radians(0.811)), "m", "B1",
                   "door 1 sill 2.74 m above the ground at empty weight (p. 2-19 'B ENTRY DOOR NO 1 9 - 0 2.74') "
                   "taken to body axes at the 0.811 deg ground attitude; the aft sill (3.12 m) gives the same"),
    "top_z": Dim(2.95 + 2.49, "m", "B1", "floor (2.95 m) plus top-to-floor (2.49 m); p. 2-19 'A TOP OF FUSELAGE "
                 "18 - 3 5.56' at the ground attitude matches near station 11"),
    "skin_double_line": Dim(0.964, "ratio", "B1", "the plan view's double outline: the outer line traces 1.95 m "
                            "where p. 2-29 prints 1.88 m, so traced half widths are scaled by 1.88/1.95"),
    # station, half width (plan view), traced and scaled by skin_double_line
    "plan": Dim(((0.0, 0.0), (0.10, 0.125), (0.25, 0.30), (0.50, 0.48), (1.0, 0.68), (1.5, 0.86), (2.0, 1.02),
                 (2.5, 1.17), (3.0, 1.29), (3.5, 1.42), (4.0, 1.52), (5.0, 1.66), (6.0, 1.76), (7.0, 1.81),
                 (8.0, 1.85), (10.0, 1.88), (28.0, 1.88), (29.0, 1.86), (30.0, 1.78), (31.0, 1.72), (32.0, 1.56),
                 (33.0, 1.41), (34.0, 1.20), (35.0, 0.90), (36.0, 0.65), (37.0, 0.39), (37.5, 0.30),
                 (38.02, 0.20)), "m", "B1",
                "traced from the plan view, p. 2-14: half width of the outer skin line by station (34 m "
                "interpolated where the tailplane crosses; the last 0.5 m judged from the drawn tail cone)"),
    # station, top z, bottom z (body axes): side view traced, heights re-referenced so the mid-cabin top and
    # belly fall on top_z and top_z - height
    "side": Dim(((0.0, 2.98, 2.98), (0.25, 3.28, 2.57), (0.50, 3.55, 2.38), (1.0, 3.82, 2.04), (1.5, 4.14, 1.84),
                 (2.0, 4.48, 1.66), (2.5, 4.77, 1.54), (3.0, 4.89, 1.46), (3.5, 5.00, 1.43), (4.0, 5.11, 1.43),
                 (5.0, 5.23, 1.43), (6.0, 5.32, 1.43), (7.0, 5.39, 1.43), (8.0, 5.43, 1.43), (10.0, 5.44, 1.43),
                 (24.0, 5.44, 1.44), (26.0, 5.44, 1.46), (28.0, 5.44, 1.62), (29.0, 5.44, 1.74), (30.0, 5.43, 1.89),
                 (31.0, 5.43, 2.06), (32.0, 5.41, 2.26), (33.0, 5.41, 2.49), (34.0, 5.41, 2.75), (35.0, 5.40, 3.03),
                 (36.0, 5.40, 3.35), (37.0, 5.33, 3.69), (37.5, 5.22, 3.88), (38.02, 4.97, 4.50)), "m", "B1",
                "traced from the side view, p. 2-14 (outer skin lines), plus 0.54 m so that the drawn mid-cabin "
                "top (4.90 m over the drawing's ground line) lands on top_z; the last metre aft of 37 m judged "
                "from the drawn tail cone, where the tailplane's lines cross it"),
    "nose_tip_z": Dim(2.98, "m", "B1", "traced: the side view's nose tip, 2.44 m over the drawn ground line, +0.54"),
}

COCKPIT = {
    # station of the pane's centre, its ring angle (0 = the side at max breadth, 90 = the crown), half length
    # along the fuselage, half height around it; a side
    "panes": est(((1.78, 60.0, 0.27, 0.27), (2.30, 39.0, 0.24, 0.21), (2.76, 31.0, 0.17, 0.18)), "m|deg",
                 "the windscreen and the two side windows a side, placed and sized from the side view on p. 2-14 "
                 "and photographs of the type; drawn as dark panels"),
}

# ===================================================================================== doors and exits
DOORS = {
    "fwd_entry_left": {
        "station": Dim(5.03, "m", "B1", "p. 2-33: '16 FT 6 IN 5.03 M)' nose to main entry door no. 1"),
        "size": Dim((34 * _IN, 72 * _IN), "m", "B1", "p. 2-33: 'MAIN ENTRY DOOR 34 x 72 IN (0.86 x 1.83 M)'"),
    },
    "fwd_service_right": {
        "station": Dim(4.76, "m", "B1", "p. 2-36: '15 FT 4 IN (4.76 M)' nose to the forward service door"),
        "size": Dim((30 * _IN, 65 * _IN), "m", "B1", "p. 2-36: 'FORWARD SERVICE DOOR 30 x 65 IN (0.76 x 1.65 M)'"),
    },
    "aft_entry_left": {
        "station": Dim(31.88, "m", "B1", "p. 2-37: '-800: 104 FT 7 IN (31.88 M)' to the aft door centre line"),
        "size": Dim((30 * _IN, 72 * _IN), "m", "B1", "p. 2-37: 'AFT ENTRY DOOR (LEFT) 30 x 72 IN (0.76 x 1.83 M)'"),
    },
    "aft_service_right": {
        "station": Dim(31.88, "m", "B1", "p. 2-37: same station as the aft entry door"),
        "size": Dim((30 * _IN, 65 * _IN), "m", "B1", "p. 2-37: 'AFT SERVICE DOOR (RIGHT) 30 x 65 IN (0.76 x 1.65 M)'"),
    },
    "overwing_exits": {
        "body_stations": Dim((589.5, 627.5), "in", "B5", "'STA 589.5' and 'STA 627.5' on [B5], two exits a side"),
        "station": Dim((16.70, 17.67), "m", "B1+B5", "[B5]'s stations through the plug map (STA + 68 in between the "
                       "plugs); p. 2-14 shows them at 16.7 and 17.8 m by tracing"),
        "size": est((20 * _IN, 36 * _IN), "m", "the Type III exit minimum of 14 CFR 25.807 (20 x 36 in), recalled, not "
                    "re-fetched; the exits on p. 2-14 trace to about this size"),
    },
}

# ===================================================================================== windows
# Window centre stations, traced from [B6]'s to-scale seat map (fr-738.neutral.webp, 800 x 4213 px): every window is
# drawn there as a dark tick on the fuselage edge, and the ones a galley or lavatory covers as a faint outline. The
# map's scale is set piecewise by four anchors it also draws: door 1L (5.03 m, [B1] p. 2-33), the two overwing exit
# hatches (16.70 and 17.67 m, [B5]'s STA 589.5 and 627.5) and the aft doors (31.88 m, [B1] p. 2-37): 126.3 px/m ahead
# of the exits, 125.1 behind. Ticks are read to +-1 px (8 mm); the anchors (the doors' centres read by eye) put the
# absolute stations within about 3 cm. research/dimensions.md has the pixel rows and the calibration.
_WIN_RIGHT = (5.588, 6.102, 6.621, 7.129, 7.643, 8.154, 8.666, 9.186, 9.695, 10.284, 10.836, 11.386, 11.934, 12.478,
              13.03, 13.584, 14.13, 15.185, 15.671, 16.152, 16.7, 17.67, 18.263, 18.839, 19.394, 19.939, 20.481,
              21.028, 21.584, 22.121, 22.67, 23.194, 23.715, 24.231, 24.752, 25.277, 25.795, 26.308, 26.84, 27.357,
              27.871, 28.396, 28.913, 29.439, 29.95, 30.47)
WINDOWS = {
    "opening": Dim((10.5 * _IN, 14.375 * _IN), "m", "B4", "s. 1.7.1: 'The exterior cabin window by seat 14A measured "
                   "10 1/2 inches horizontally, 14 3/8 inches vertically, and 15 inches diagonally'"),
    "corner_radius": est(0.085, "m", "the opening's corners from photographs: about a third of the width"),
    "centre_above_floor": est(0.97, "m", "no published figure. Bounded by the overwing hatch, whose window sits at "
                              "the window line: traced on [B1] p. 2-14 (148.8 px/m at 1200 dpi) the hatch runs from "
                              "1.17 m to 2.08 m below the fuselage top, i.e. 0.41 to 1.32 m above the floor (2.95 m), "
                              "and photographs put its window in the hatch's upper half; centre 0.97 m puts the top "
                              "of the opening at 1.15 m, below a seated eye (1.20 m), as section 7.4 says"),
    "pitch_original": Dim(20.3 * _IN, "m", "B6", "mean pitch of the traced stations over the original fuselage "
                          "(5.6 to 9.7 m and 23.2 to 30.5 m): 20.0 to 20.9 in, mean 20.3 in"),
    "pitch_plug": Dim(21.6 * _IN, "m", "B6", "mean pitch of the traced stations through the stretch plugs (9.7 to "
                      "14.1 m and 17.7 to 22.7 m): 21.1 to 23.3 in, mean 21.6 in"),
    "right": Dim(_WIN_RIGHT, "m", "B6+B5+B1", "window centre stations, right side (46), traced from [B6] as above; "
                 "the first two (5.59, 6.10 m) and the last (30.47 m) are drawn as faint outlines, covered by the "
                 "galley and the aft lavatory in that airline's layout; the fuselage has them"),
    "left": Dim(tuple(p for p in _WIN_RIGHT if p >= 6.0 and abs(p - 13.584) > 0.01), "m", "B6+B5+B1",
                "window centre stations, left side (44), traced from [B6]: the right side's stations (both sides "
                "trace within 2 px of each other), less the first, which door 1L (wider and 0.27 m further aft than "
                "the right service door) takes, and less 13.58 m, a blank on this side"),
    "blanks_right": Dim((14.656,), "m", "B6+B7", "[B6] draws no window between 14.13 and 15.19 m on either side, a "
                        "gap of two pitches: the blank traced at 14.66 m, just ahead of the wing root (the "
                        "air-conditioning risers of [B7])"),
    "blanks_left": Dim((13.58, 14.656), "m", "B6+B7", "on the left [B6] also has no window at 13.58 m (13.03 to 14.13 m, "
                       "two pitches), the left-only blank of section 7.4 and [B7]"),
}

# ===================================================================================== cabin
# The cabin around a window seat: the sidewall and its window reveal, the shade, the bins' lower edge, and a generic
# single-class seat layout (section 7.4's table). Heights are above the cabin floor (FUSELAGE floor_z in body axes);
# stations are metres aft of the nose. models/aircraft/build_cabin.py builds cabin.glb from these, and
# models/aircraft/write_dimensions_js.py copies them to src/flight/aircraft/dimensions.js.
CABIN = {
    # the shell, [B1] p. 2-30 (six-abreast cross-section), traced at 300 dpi (8.38 px/in)
    "trim_radius": Dim(139.2 * _IN / 2, "m", "B1", "p. 2-30 'INTERIOR TRIM-TO-TRIM 139.2 IN (3.54 M)': the trim is "
                       "traced as a circle of half that about the fuselage's centre of max breadth from about 0.3 to "
                       "1.4 m above the floor (within 1.5 cm); below 0.3 m the dado panel stands about 3 cm inboard"),
    "trim_widest_above_floor": Dim(0.61, "m", "B1", "p. 2-30 traced: the trim and the skin are widest 24 in (0.61 m) "
                                   "above the floor line, matching FUSELAGE belly_to_max_breadth less the floor"),
    "dado_inset": Dim(0.03, "m", "B1", "p. 2-30 traced: at the floor the trim line stands 1.3 in (3 cm) inboard of "
                      "the circle"),
    "bin_lip_above_floor": Dim(62.2 * _IN, "m", "B1", "p. 2-30: '62.2 IN (1.58 M)' floor to the bin's lower lip at "
                               "the aisle side"),
    "bin_outboard_above_floor": Dim(66.0 * _IN, "m", "B1", "p. 2-30: '66 IN (1.68 M)' floor to the bin's underside "
                                    "where it meets the sidewall"),
    "bin_clearance": Dim(45.5 * _IN, "m", "B1", "p. 2-30: '45.5 IN (1.16 M)' between the two bins' lips"),
    "ceiling_above_floor": Dim(86.6 * _IN, "m", "B1", "p. 2-30: '86.6 IN (2.20 M)' floor to ceiling at the aisle"),
    # the window's inner frame (the trim's reveal) and shade: no source gives them
    "reveal_flare": est(0.035, "m", "the trim's opening is larger than the window by this much on every side, a "
                        "bevelled reveal, from photographs of the type's sidewall"),
    "frame_width": est(0.045, "m", "the moulded bezel round the reveal on the trim face, from photographs"),
    "frame_relief": est(0.008, "m", "how far the bezel stands proud of the trim, from photographs"),
    "inner_pane_inset": est(0.067, "m", "the non-structural inner pane [B4] sits this far outboard of the trim face, "
                            "at the outer end of the light plastic reveal liner, about 4.5 cm inside the skin "
                            "(photographs of the type's windows)"),
    "pane_spacing": est(0.012, "m", "between the three panes [B4]: no source gives the gaps"),
    "shade_travel": est(0.40, "m", "the shade slides from its pocket above the reveal down over the inner pane; "
                        "open, its handle shows at the top of the opening, so it travels the opening's height plus "
                        "the reveal's margin (photographs)"),
    "panel_half_length": est(0.235, "m", "the window bay drawn round each window, fore and aft of its centre: just "
                             "under half the shortest pitch (18.9 in), so neighbouring bays never overlap; the strip "
                             "between bays is plain trim, stretched to fit"),
    # the seat layout: a generic cabin, section 7.4's table
    "rows": est(30, "rows", "section 7.4: 30 rows, between the manufacturer's 175 and 184-seat layouts"),
    "pitch": est(31 * _IN, "m", "section 7.4: 31 in, between the manufacturer's 30 and 32 in layouts ([B5] uses 29 "
                 "and 30 in)"),
    "exit_pitch": Dim(38.0 * _IN, "m", "B5", "view C-C: '38.00\"' from the row ahead of the second exit to the row "
                      "behind it (section 7.4 gives both exit rows 38 in)"),
    "exit_rows": est((15, 16), "row", "section 7.4: the rows behind the two overwing exits"),
    "first_row_front": Dim(6.1, "m", "B5", "section 7.4: front of the first row's seat 6.1 m aft of the nose, as on "
                           "[B5] (row 1 at STA 350 to 372, 5.86 to 6.42 m)"),
    "seat_width": Dim(17.0 * _IN, "m", "B1", "p. 2-30: '17.0 IN (0.43 M) (TYPICAL)' between armrests"),
    "triple_width": Dim(59.0 * _IN, "m", "B1", "p. 2-30: '59 IN (1.50 M)' a triple seat"),
    "aisle": Dim(20.0 * _IN, "m", "B1", "p. 2-30: '20 IN (0.51 M)' the aisle at seat level"),
    # the seat itself: traced from [B5] view C-C (1:20, 10.56 px/in at 600 dpi), floor line WL 208.63
    "cushion_top": Dim(0.44, "m", "B5", "view C-C traced: the cushion's top at its front 17.2 in above the floor"),
    "armrest_top": Dim(0.62, "m", "B5", "view C-C traced: the armrest's top 24.3 in above the floor"),
    "back_top": Dim(1.14, "m", "B5", "view C-C traced: the seat back's top 45.0 in above the floor ([B1] p. 2-30 "
                    "traces 44.6 in)"),
    "back_thickness": Dim(0.10, "m", "B5", "view C-C traced: the seat back's shell about 3.8 in deep at mid height"),
    "cushion_depth": Dim(0.47, "m", "B5", "view C-C traced: seat front to the seat reference point (where the back "
                         "meets the cushion), 18.5 in"),
    "back_face": est(0.72, "m", "section 7.4's seat: the back's cushion face at head height, aft of the seat front "
                     "(the eye plus a head's depth); [B5]'s drawn seat is upright and gives about 0.55"),
    "eye_aft": est(0.55, "m", "section 7.4: eye 0.55 m aft of the seat front"),
    "eye_above_floor": est(1.20, "m", "section 7.4: seat surface 0.43 m plus a seated eye height of 0.77 m (between "
                           "the male and female means of the US Army's anthropometric survey)"),
    "tray_size": est((0.40, 0.25), "m", "the tray table stowed on the seat back ahead, width and height, from "
                     "photographs of economy seats"),
    "bulkhead_ahead": est(0.3, "m", "row 1: the wall ahead of the first row stands this far ahead of its seat front"),
}

# ===================================================================================== wing
WING = {
    "area": Dim(124.58, "m2", "B3", "techspecsdetailed: 'Gross Area (m²) ... 124.58' (NG)"),
    "mac": Dim(3.96, "m", "B3", "techspecsdetailed: 'M.A.C.(m) ... 3.96'"),
    "sweep_quarter_chord": Dim(25.02, "deg", "B3", "techspecsdetailed: '¼ Chord Sweep (º) ... 25.02'"),
    "dihedral": Dim(6.0, "deg", "B3", "techspecsdetailed and flightcontrols: 'Dihedral (º) 6'"),
    "incidence_root": Dim(1.0, "deg", "B3", "flightcontrols wing table: 'Incidence at root (º) 1' for the NG"),
    "twist_tip": est(-2.0, "deg", "washout at the tip relative to the root; the type's twist is not published"),
    "thickness_root": Dim(0.14, "ratio", "B3", "flightcontrols wing table: 'Thickness/chord - Root 14.00' "
                          "(published for the earlier wings; '?' for the NG, so used as the best figure)"),
    "thickness_kink": est(0.125, "ratio", "between the root and tip; [B3] gives 12.89% average for the classic"),
    "thickness_tip": Dim(0.115, "ratio", "B3", "flightcontrols wing table: 'Thickness/chord - Tip 11.50' (classic)"),
    "root_y": Dim(1.88, "m", "B1", "the wing meets the fuselage side at the half width (p. 2-29: 148 in)"),
    # semispan y, leading-edge station x: traced, p. 2-14 (glove sweep inboard of the kink, then 27 deg)
    "le": Dim(((1.88, 14.92), (5.53, 17.50), (17.16, 23.49)), "m", "B1",
              "traced plan view: LE x = 15.15 + 0.706 (y - 2.2) inboard, 18.01 + 0.514 (y - 6.5) outboard, "
              "crossing at y = 5.53 (section 6.5: 'about 15.0 m' at the body, kink 'about 5.6 m out')"),
    "te": Dim(((1.88, 21.48), (5.52, 21.48), (17.16, 24.85)), "m", "B1",
              "traced plan view: TE x = 21.48 inboard (unswept), 21.62 + 0.289 (y - 6) outboard; p. 2-13's bare "
              "tip prints LE 23.47 m and TE 24.99 m at y = 17.16"),
    "tip_le": Dim(23.47, "m", "B1", "p. 2-13 (737-800, no winglets): wingtip leading edge 23.47 m aft of the nose"),
    # lower-surface reference: z of the wing's flat lower surface line at y (front view)
    "lower_z_at_root": Dim(1.90, "m", "B1", "traced front view, p. 2-14: the wing's lower outline meets the body "
                           "1.49 m over the drawing's ground line; +0.41 m puts the drawn belly (1.02 m) on the "
                           "body-axis belly 1.43 m"),
    "lower_z_root_y": Dim(2.2, "m", "B1", "the buttock line where lower_z_at_root was read, traced front view"),
}

WINGLET = {
    "height": Dim(2.44, "m", "B1+B3", "[B1] p. 2-14 front view 'APPROX 8 FT (2.44 M)'; [B3] winglets: 'They are 8ft "
                  "2in tall and about 4 feet wide at the base, narrowing to approximately two feet at the tip'"),
    "root_chord": Dim(4 * _FT, "m", "B3", "winglets: 'about 4 feet wide at the base'"),
    "tip_chord": Dim(2 * _FT, "m", "B3", "winglets: 'narrowing to approximately two feet at the tip'"),
    "top_z_ground": Dim(6.76, "m", "B1", "p. 2-19 table, 737-800 with winglets: 'E WINGTIP 22 - 2 6.76' (OEW)"),
    "bottom_z_ground": Dim(4.32, "m", "B1", "p. 2-19: 'K BOTTOM OF WINGLET (APPROX) 14 - 2 4.32' (OEW)"),
    "le_root_station": Dim(23.88, "m", "B1", "p. 2-14: '78 FT 4 IN (23.88 M) (APPROX)' to the winglet's leading edge"),
    "last_point_station": Dim(26.01, "m", "B1", "p. 2-14: '85 FT 4 IN (26.01 M)' to the winglet's last point"),
    "blend_start_y": Dim(17.0, "m", "B1", "traced front view: the wing's outline starts to curve up at 17.0 m"),
    "cant_deg": Dim(19.0, "deg", "B1", "traced front view: the winglet leans out 0.9 m over its 2.6 m rise"),
}

# ===================================================================================== engines
ENGINE = {
    "y": Dim(4.83, "m", "B1", "p. 2-14: '15 FT 10 IN (4.83 M)' centre line to engine centre line"),
    "inlet_station": Dim(13.36, "m", "B1", "p. 2-14: '43 FT 10 IN (13.36 M)' nose to the inlet lip"),
    "fan_diameter": Dim(61 * _IN, "m", "B3", "techspecsdetailed: 'Fan tip diameter (in) ... 61' (CFM56-7)"),
    "nacelle_width": Dim(2.06, "m", "B3", "techspecsdetailed: 'Max Nacelle Width (m) ... 2.06'"),
    "nacelle_height": est(1.90, "m", "the CFM56-7 nacelle's flattened lower lip makes it lower than wide; "
                          "from the front view on p. 2-14 and photographs"),
    "bottom_z_ground": Dim(0.64, "m", "B1", "p. 2-19, 737-800W: 'D ENGINE 2 - 1 0.64' (OEW)"),
    "bottom_z": Dim(0.64 + (19.69 - 14.5) * math.tan(math.radians(0.811)), "m", "B1",
                    "p. 2-19's 0.64 m at the nacelle's lowest point (station about 14.5 m) in body axes"),
    "fan_cowl_end": est(15.00, "m", "fan cowl / thrust-reverser split line, from photographs (about 1.6 m behind "
                        "the lip)"),
    "sleeve_end": Dim(16.20, "m", "B1", "traced plan view: the fan nozzle (translating sleeve's trailing edge) at "
                      "16.2 m"),
    "core_nozzle": Dim(16.76, "m", "B1", "traced plan view: core nozzle exit at 16.76 m"),
    "plug_tip": Dim(17.30, "m", "B1", "traced plan view: exhaust plug tip at 17.30 m"),
    "sleeve_travel": est(0.62, "m", "aft travel of the translating sleeve that opens the cascades"),
    "lip_thickness": est(0.10, "m", "inlet lip, bare metal ring"),
    "pylon_top_le": est(15.20, "m", "the pylon meets the wing's lower surface a little aft of the leading edge"),
    "pylon_end": est(18.90, "m", "aft pylon fairing under the wing"),
    "pylon_width": est(0.42, "m", "pylon thickness"),
}

# ===================================================================================== tail
VERTICAL_TAIL = {
    "sweep_quarter_chord": Dim(35.0, "deg", "B3", "techspecsdetailed, fin: '¼ Chord Sweep (º) ... 35'"),
    "area": Dim(26.44, "m2", "B3", "techspecsdetailed: 'Fin Area (m²) ... 26.44'"),
    "fin_height": Dim(7.16, "m", "B3", "techspecsdetailed: 'Fin Height (m) ... 7.16'"),
    # drawing height (m over p. 2-14's ground line), LE x, TE x: traced side view
    "outline": Dim(((4.87, 28.75, 37.00), (5.5, 30.39, 37.15), (6.0, 31.70, 37.25), (6.5, 32.83, 37.35),
                    (7.0, 33.23, 37.46), (8.0, 33.97, 37.66), (10.0, 35.43, 38.06), (12.0, 36.89, 38.46),
                    (12.3, 37.14, 38.52), (12.55, 37.60, 38.45)), "m", "B1",
                   "traced side view, p. 2-14: dorsal fin to 6.3 m, then LE sweep 36 deg and TE 11 deg; heights in "
                   "the drawing's own frame (fin root on the drawn fuselage top at 4.87 m)"),
    "drawing_root_z": Dim(4.87, "m", "B1", "traced: the drawn fuselage top line under the fin"),
    "drawing_tip_z": Dim(12.6, "m", "B1", "traced: the drawn fin tip, 12.6 m over the drawing's ground line"),
    "thickness": est(0.11, "ratio", "fin section thickness"),
    "tip_station": Dim(38.3, "m", "B1", "traced side view: the middle of the fin tip's chord"),
}

HORIZONTAL_TAIL = {
    "span": Dim(14.35, "m", "B1+B3", "[B1] p. 2-14: '47 FT 1 IN (14.35 M)'; [B3] 'Span (m) 14.35'"),
    "dihedral": Dim(7.0, "deg", "B3", "techspecsdetailed, horizontal stabiliser: 'Dihedral (º) 7'"),
    "sweep_quarter_chord": Dim(30.0, "deg", "B3", "techspecsdetailed: '¼ Chord Sweep (º) 30'"),
    "area": Dim(32.78, "m2", "B3", "techspecsdetailed: 'Tailplane Area (m²) 32.78'"),
    "le": Dim(((0.0, 32.74), (7.0, 37.78), (7.175, 38.39)), "m", "B1",
              "traced plan view: LE x = 34.18 + 0.72 (y - 2) to the rounded tip"),
    "te": Dim(((0.0, 37.16), (7.175, 39.47)), "m", "B1", "traced plan view: TE x = 37.80 + 0.32 (y - 2); the tip's "
              "trailing edge is the overall length (39.47 m)"),
    "root_z": Dim(5.64 - (39.47 - 19.69) * math.tan(math.radians(0.811)) - 7.175 * math.tan(math.radians(7.0)) - 0.05,
                  "m", "B1+B3", "chord plane at the centre line: p. 2-19 'H STABILIZER 18 - 6 5.64' (OEW) at the tip, "
                  "in body axes, less the 7 deg dihedral over the semispan and half the tip's thickness"),
    "thickness": est(0.10, "ratio", "tailplane section thickness"),
}

# ===================================================================================== high-lift devices
FLAPS = {
    "span_ratio": Dim(0.599, "ratio", "B3", "techspecsdetailed: 'Flap Span/Wing Span 0.599' (NG)"),
    "area_ratio": Dim(0.300, "ratio", "B3", "techspecsdetailed: 'Flap Area/Wing Area 0.300' (NG)"),
    "type": Dim(2, "slots", "B3+B8", "[B3]: 'Are triple slotted (-3/4/500) / double slotted (-NG)'; [B8]: 'The TE "
                "devices consist of double slotted flaps inboard and outboard of each engine'"),
    "inboard_y": est((1.98, 6.02), "m", "inboard flap from the body fairing to the engine's TE kink; with the "
                     "outboard flap the two cover 0.60 of the semispan, as [B3]'s ratio says"),
    "outboard_y": est((6.12, 12.40), "m", "outboard flap to the aileron"),
    "chord_inboard": est(1.85, "m", "main + aft flap chord inboard (37% of the local chord at y = 4 m)"),
    "chord_outboard_ratio": est(0.31, "ratio", "flap chord as a fraction of the local chord outboard"),
    "aft_flap_ratio": est(0.32, "ratio", "the aft flap's share of the flap chord"),
    "travel": est(0.58, "ratio", "full aft travel along the tracks, as a fraction of the flap chord"),
    "track_slope": est(9.0, "deg", "tracks slope down this much from the wing chord, so travel also lowers the "
                       "flap"),
    # lever, main-flap angle (deg, TE down), travel fraction (0..1 of full travel), aft-flap extra angle (deg)
    "detents": est(((0, 0.0, 0.0, 0.0), (1, 1.0, 0.20, 0.0), (2, 2.0, 0.32, 0.0), (5, 5.0, 0.50, 0.0),
                    (10, 8.0, 0.66, 2.0), (15, 11.0, 0.80, 4.0), (25, 17.0, 0.92, 8.0), (30, 20.0, 1.0, 10.0),
                    (40, 25.0, 1.0, 15.0)),
                   "deg|ratio", "the lever numbers of [B8] ('1, 2, 5, 10, 15, 25, 30 or 40') read as the total "
                   "surface angle; most of the early detents is Fowler travel, the last ones are angle, from "
                   "photographs; to be tuned against footage"),
    "limit_speed_kt": Dim(((1, 250), (2, 250), (5, 250), (10, 210), (15, 200), (25, 190), (30, 175), (40, 162)),
                          "kt", "B3", "flightcontrols: 'the structural limit speed for the flaps is equal to the "
                          "placard speeds (175k F30, 162k F40) for the heaviest variant (737-800/900)'; the other "
                          "detents are section 7.3's table from the reposted crew documents, not re-checked here"),
    "max_altitude_ft": Dim(20000, "ft", "B8", "'flap extension above 20,000 feet should not be attempted'"),
    "fairings_y": est((3.60, 7.30, 9.85, 12.20), "m", "flap track fairings: one under the inboard flap, three "
                      "under the outboard flap (photographs of the type)"),
    "fairing_length": est(4.3, "m", "canoe fairing length, from the wing's trailing edge forward and aft; "
                          "compared with Commons photographs 'Boeing737-wing-Dublin.jpg' and 'A fully extended flap.jpg'"),
    "fairing_depth": est(0.58, "m", "canoe depth below the wing, from the same photographs"),
    "fairing_width": est(0.40, "m", "canoe width across, from the same photographs"),
}

SLATS = {
    "count": Dim(4, "per wing", "B8", "'LE devices consist of four flaps and eight slats: two flaps inboard and "
                 "four slats outboard of each engine'"),
    "panels": est(((6.12, 8.85), (8.90, 11.65), (11.70, 14.40), (14.45, 16.90)), "m",
                  "spanwise extent of slats 1-4 from the pylon to the tip, four equal panels"),
    "chord_ratio": est(0.16, "ratio", "slat chord as a fraction of the local chord"),
    # state (0 retracted, 1 extend, 2 full extend): rotation (deg, nose down), forward-down travel (m)
    "states": est(((0, 0.0, 0.0), (1, 15.0, 0.22), (2, 24.0, 0.34)), "deg|m",
                  "extend seals the slat to the wing at a moderate droop; full extend opens a slot, [B8]: 'Slats "
                  "extend to form a sealed or slotted leading edge depending on the TE flap setting'"),
    "schedule": Dim(((0, 0), (1, 1), (2, 1), (5, 1), (10, 2), (15, 2), (25, 2), (30, 2), (40, 2)), "lever|state",
                    "B8", "'When the FLAP lever is moved from the UP position to the 1, 2, or 5 position ... slats "
                    "extend to the extend position. When the FLAP lever is moved beyond the 5 position ... slats "
                    "extend to the full extended position.'"),
}

KRUEGERS = {
    "count": Dim(2, "per wing", "B8", "'two flaps inboard ... of each engine' ([B3]: 'There are four LE Krueger flaps, "
                 "two inboard of each engine')"),
    "panels": est(((2.30, 3.40), (3.45, 4.05)), "m", "spanwise extent of the two Krueger flaps between the body "
                  "and the inboard side of the nacelle"),
    "chord": est(0.55, "m", "Krueger panel chord"),
    "open_deg": est(115.0, "deg", "rotation about the hinge at the lower leading edge from stowed (flush under "
                    "the wing) to extended"),
    "schedule": Dim(((0, 0), (1, 1), (2, 1), (5, 1), (10, 1), (15, 1), (25, 1), (30, 1), (40, 1)), "lever|state",
                    "B8", "'LE ... flaps extend to the full extended position' at flaps 1, 2 and 5 and 'remain at "
                    "the full extended position' beyond 5; [B3]: 'They are either fully extended or retracted'"),
}

SPOILERS = {
    "flight_count": Dim(4, "per wing", "B8", "'Four flight spoilers are located on the upper surface of each wing'"),
    "ground_count": Dim(2, "per wing", "B8", "'Hydraulic system A powers all four ground spoilers, two on the upper "
                        "surface of each wing'"),
    # (inner y, outer y, kind): 1 innermost
    "panels": est(((2.05, 3.45, "ground"), (3.50, 5.95, "flight"), (6.20, 7.75, "flight"), (7.80, 9.35, "flight"),
                   (9.40, 10.95, "flight"), (11.00, 12.35, "ground")), "m",
                  "six panels a wing ahead of the flaps; the innermost and outermost taken as the ground spoilers"),
    "chord_ratio": est(0.16, "ratio", "spoiler chord as a fraction of the local chord"),
    "flight_max_deg": Dim(38.0, "deg", "B3", "flightcontrols: flight spoilers 'current 33/38 degrees' (60 with "
                          "the short-field option)"),
    "ground_max_deg": est(60.0, "deg", "section 7.3's figure for the ground panels"),
    "speedbrake_flight_detent": est(0.55, "ratio", "flight spoilers in the speed brake's flight detent, as a "
                                    "fraction of their maximum"),
}

AILERON = {
    "y": est((12.45, 15.95), "m", "aileron from the outboard flap to near the tip"),
    "chord_ratio": est(0.26, "ratio", "aileron chord as a fraction of the local chord"),
    "max_deg": Dim(20.0, "deg", "B3", "flightcontrols: 'The maximum aileron movement which can be achieved by the "
                   "pilot is about 20°'"),
}

# ===================================================================================== flex
FLEX = {
    "tip_deflection_1g": est(0.65, "m", "section 6.5: 0.5 to 0.8 m assumed for the tip in level flight"),
    "frequency_hz": Dim(2.5, "Hz", "B9", "section 6.5 reading of [B9]: wing bending near 2.4 to 2.7 Hz on a "
                        "737-100 (not re-read for this task)"),
}

# ===================================================================================== lights
# channels of the two baked attributes: _LIGHTS0 = (NAV, BEACON, STROBE, LANDING), _LIGHTS1 = (TAXI, TURNOFF,
# LOGO, WING), the order of section 5.5's bit field. One channel is shared by two lamp groups that light parts of
# the airframe far apart (LIGHT_BAKE "shared"): the TAXI channel carries the taxi light inboard of 8 m and the white
# aft position lights outboard of it, so the position lights' two colours have a channel each.
LIGHT_CHANNELS = ("NAV", "BEACON", "STROBE", "LANDING", "TAXI", "TURNOFF", "LOGO", "WING")


def _light(x, y, z, channel, colour, direction, cone_deg, note, beam, intensity=None, standoff=None):
    """A lamp: station, buttock line, height (the frames above), its group's channel, colour, aim (x aft, y right,
    z up), the cone the app's light point is drawn in, the photometry the bake uses (a LIGHT_BEAMS key) and which
    intensity of LIGHT_CANDELA its beam's 1.0 is (the group's, unless named). `standoff`: how far out of the skin
    the light's centre is, when not LIGHT_BAKE snap_offset (a beacon's dome)."""
    v = {"position": (x, y, z), "channel": channel, "colour": colour, "direction": direction, "cone_deg": cone_deg,
         "beam": beam, "intensity": intensity or channel}
    if standoff is not None:
        v["standoff"] = standoff
    return est(v, "m|deg", note)


LIGHTS = {
    "nav_left": _light(23.30, -17.10, 3.58, "NAV", "red", (0.0, -1.0, 0.0), 180.0,
                       "wingtip leading edge at the winglet root, left (red per 14 CFR 25.1385; position per [B8] as "
                       "section 7.8 reads it); its light covers 110 deg from ahead to outboard and also shines up and "
                       "back onto the winglet", "position_fwd"),
    "nav_right": _light(23.30, 17.10, 3.58, "NAV", "green", (0.0, 1.0, 0.0), 180.0,
                        "wingtip leading edge at the winglet root, right (green)", "position_fwd"),
    "nav_aft_left": _light(24.95, -17.05, 3.52, "NAV", "white", (1.0, 0.0, 0.0), 140.0,
                           "white position light on the wingtip trailing edge, left", "position_aft", "NAV_AFT"),
    "nav_aft_right": _light(24.95, 17.05, 3.52, "NAV", "white", (1.0, 0.0, 0.0), 140.0,
                            "white position light on the wingtip trailing edge, right", "position_aft", "NAV_AFT"),
    "strobe_left": _light(23.32, -16.90, 3.56, "STROBE", "white", (0.0, -1.0, 0.0), 180.0,
                          "anti-collision strobe beside the left position light", "strobe_tip"),
    "strobe_right": _light(23.32, 16.90, 3.56, "STROBE", "white", (0.0, 1.0, 0.0), 180.0,
                           "anti-collision strobe beside the right position light", "strobe_tip"),
    "strobe_tail": _light(38.02, 0.0, 4.75, "STROBE", "white", (1.0, 0.0, 0.0), 140.0,
                          "white strobe on the tail cone", "strobe_tail"),
    "beacon_top": _light(17.0, 0.0, 5.48, "BEACON", "red", (0.0, 0.0, 1.0), 180.0,
                         "red rotating beacon on the fuselage crown above the wing; its light comes from about "
                         "10 cm above the skin, the middle of a dome some 15 cm tall", "beacon", standoff=0.10),
    "beacon_bottom": _light(14.2, 0.0, 1.40, "BEACON", "red", (0.0, 0.0, -1.0), 180.0,
                            "red rotating beacon on the belly ahead of the wing, a dome like the top one's", "beacon",
                            standoff=0.10),
    "landing_left": _light(15.35, -2.55, 2.30, "LANDING", "white", (-1.0, -0.07, -0.05), 22.0,
                           "fixed landing light in the left wing root's leading edge, toed out 4 deg so the beam "
                           "clears the fuselage 0.7 m inboard of it (aimed dead ahead, its core grazed the whole "
                           "forward fuselage)", "landing"),
    "landing_right": _light(15.35, 2.55, 2.30, "LANDING", "white", (-1.0, 0.07, -0.05), 22.0,
                            "fixed landing light in the right wing root's leading edge, toed out 4 deg", "landing"),
    "turnoff_left": _light(15.05, -2.10, 2.25, "TURNOFF", "white", (-0.8, -0.6, -0.12), 40.0,
                           "runway turn-off light in the left wing root, aimed outward and down so its beam meets "
                           "the ground about 20 m out, beside the main gear's path", "turnoff"),
    "turnoff_right": _light(15.05, 2.10, 2.25, "TURNOFF", "white", (-0.8, 0.6, -0.12), 40.0,
                            "runway turn-off light in the right wing root, aimed outward and down", "turnoff"),
    "taxi": _light(3.95, 0.0, 1.20, "TAXI", "white", (-1.0, 0.0, -0.08), 30.0, "taxi light on the nose-gear strut",
                   "taxi"),
    "logo_left": _light(35.6, -1.6, 4.75, "LOGO", "white", (0.15, 0.45, 0.88), 40.0,
                        "logo light on the upper surface of the left tailplane, aimed at the fin", "logo"),
    "logo_right": _light(35.6, 1.6, 4.75, "LOGO", "white", (0.15, -0.45, 0.88), 40.0,
                         "logo light on the upper surface of the right tailplane, aimed at the fin", "logo"),
    "wing_left": _light(13.2, -1.86, 3.55, "WING", "white", (0.45, -0.89, -0.10), 30.0,
                        "wing-illumination light on the left fuselage side ahead of the wing, lighting the leading "
                        "edge and nacelle", "wing"),
    "wing_right": _light(13.2, 1.86, 3.55, "WING", "white", (0.45, 0.89, -0.10), 30.0,
                         "wing-illumination light on the right fuselage side ahead of the wing", "wing"),
}

# The photometry of each kind of lamp, relative to its peak (1.0 = LIGHT_CANDELA of the lamp's intensity), as tables
# of (degrees, ratio) interpolated linearly. "polar": by the angle from the lamp's aim. "sector": by the horizontal
# angle from dead ahead (positive toward the lamp's own wingtip, i.e. along its aim) times a factor by the elevation
# above or below the body's horizontal plane, the form 14 CFR 25.1391-25.1401 gives position and anti-collision light
# in. Beyond the last row a table holds its last ratio. Light into the structure the lamp sits on is removed by the
# bake's ray casting, not by these tables.
LIGHT_BEAMS = {
    "position_fwd": est({"kind": "sector",
                         "horizontal": ((-90, 0.025), (-10, 0.025), (-5, 0.1), (0, 1.0), (10, 1.0), (20, 0.6),
                                        (30, 0.3), (110, 0.2), (140, 0.15), (180, 0.1)),
                         "vertical": ((0, 1.0), (10, 0.85), (20, 0.6), (30, 0.45), (45, 0.35), (90, 0.3))},
                        "deg|ratio",
                        "forward position light. Ahead and outboard the regulation's shape (25.1391: 40, 30 and 5 cd "
                        "minimums in the 0-10, 10-20 and 20-110 deg sectors; 25.1395: at most 10% across the "
                        "centre line within 10 deg, 2.5% beyond). Up and back (the winglet above and behind the "
                        "lamp) the ratios are ESTIMATED from night photographs from the cabin, in which the winglet's "
                        "inner face glows the lamp's colour: a dome lens throws far more up than 25.1393's 5% minimum"),
    "position_aft": est({"kind": "sector",
                         "horizontal": ((-180, 1.0), (-110, 1.0), (-100, 0.1), (-90, 0.025), (90, 0.025),
                                        (100, 0.1), (110, 1.0), (180, 1.0)),
                         "vertical": ((0, 1.0), (5, 0.9), (10, 0.8), (15, 0.7), (20, 0.5), (30, 0.3), (40, 0.1),
                                      (90, 0.05))},
                        "deg|ratio", "aft position light: 25.1391(c), 20 cd minimum in the rear 140 deg (110-180 deg "
                        "from ahead, either side); 25.1395's overlap limits (a tenth of that within 10 deg past the "
                        "sector, a fortieth beyond) as the light toward the side; 25.1393's vertical ratios. No "
                        "upward lobe beyond the regulation's: night photographs show no white wash on the winglet"),
    "strobe_tip": est({"kind": "sector",
                       "horizontal": ((-90, 0.3), (-20, 0.3), (0, 1.0), (110, 1.0), (140, 0.5), (180, 0.3)),
                       "vertical": ((0, 1.0), (5, 1.0), (10, 0.9), (20, 0.5), (30, 0.35), (60, 0.3), (90, 0.3))},
                      "deg|ratio", "wingtip strobe: 25.1401(f) vertical ratios (1.0, 0.9, 0.5, 0.3, 0.1 at 0-5, 5-10, "
                      "10-20, 20-30, 30-90 deg) as minimums, the light above 30 deg and toward the fuselage "
                      "ESTIMATED from the flash seen on the winglet and the wing in cabin video"),
    "strobe_tail": est({"kind": "polar", "table": ((0, 1.0), (60, 1.0), (80, 0.5), (100, 0.1), (130, 0.0))},
                       "deg|ratio", "tail-cone strobe covering the rear 140 deg (25.1401(b) with the tip strobes); "
                       "fall-off ESTIMATED"),
    "beacon": est({"kind": "polar",
                   "table": ((0, 0.1), (55, 0.1), (65, 0.3), (75, 0.5), (82, 0.9), (90, 1.0), (98, 0.9), (105, 0.5),
                             (115, 0.3), (125, 0.1), (180, 0.0))},
                  "deg|ratio", "anti-collision beacon, by the angle from straight up (top) or down (belly): "
                  "25.1401(f)'s vertical ratios read from the horizontal plane, brightest along it; the dome stands "
                  "proud of the skin, so it also throws light a little past the horizontal (ESTIMATED), which is "
                  "what reaches the nacelles and the flap fairings from the belly"),
    "landing": est({"kind": "polar", "inboard_cut_deg": 6.0,
                    "table": ((0, 1.0), (4, 0.8), (7, 0.5), (11, 0.1), (20, 0.02), (35, 0.005), (60, 0.0015),
                              (90, 0.001), (100, 0.0))},
                   "deg|ratio", "landing light: a narrow beam (half intensity near 7 deg, ESTIMATED from sealed-beam "
                   "and LED landing-light data sheets) with a spill of lens and reflector-rim scatter, 0.1 to 0.5% "
                   "of the peak, that lights the inlet beside it (ESTIMATED). The lamp sits in a recess of the wing "
                   "root's fairing whose inboard wall cuts the beam 6 deg inboard of its aim (ESTIMATED): without "
                   "it the beam's core grazed the whole forward fuselage, which photographs of the type on "
                   "approach at night do not show"),
    "turnoff": est({"kind": "polar",
                    "table": ((0, 1.0), (10, 0.7), (20, 0.3), (30, 0.1), (45, 0.01), (70, 0.002), (90, 0.001),
                              (100, 0.0))}, "deg|ratio", "runway turn-off light: a wide flood; ESTIMATED"),
    "taxi": est({"kind": "polar",
                 "table": ((0, 1.0), (8, 0.7), (15, 0.3), (25, 0.05), (45, 0.005), (90, 0.001), (100, 0.0))},
                "deg|ratio", "taxi light: medium beam with a spill; ESTIMATED"),
    "logo": est({"kind": "polar",
                 "table": ((0, 1.0), (15, 0.6), (25, 0.2), (40, 0.02), (90, 0.001), (100, 0.0))},
                "deg|ratio", "logo light: a flood on the fin; ESTIMATED"),
    "wing": est({"kind": "polar",
                 "table": ((0, 1.0), (10, 0.75), (20, 0.35), (30, 0.12), (45, 0.03), (70, 0.005), (90, 0.001),
                           (100, 0.0))},
                "deg|ratio", "wing-illumination light: a flood along the leading edge whose skirt also lights the "
                "upper surface by the root; ESTIMATED"),
}

# Peak intensity of each lamp (its beam's 1.0), candela. src/flight/aircraft/lights.js CANDELA carries the same
# numbers (tests/unit/flight/lights.test.js holds them equal through rig.json).
LIGHT_CANDELA = {
    "NAV": est(100.0, "cd", "forward position lights: 25.1391 asks 40 cd at least within 10 deg of ahead; LED units "
               "give about twice that and more"),
    "NAV_AFT": est(40.0, "cd", "aft position lights: 25.1391(c) asks 20 cd at least"),
    "BEACON": est(1500.0, "cd", "peak of the beacon's pulse; with lights.js's 0.3 s half-sine pulse its effective "
                  "intensity (Blondel-Rey) is about 570 cd, over 25.1401(f)'s 400 cd minimum"),
    "STROBE": est(5000.0, "cd", "peak of the strobe's flash; with lights.js's 0.08 s pulse about 900 cd effective, "
                  "over 25.1401(f)'s 400 cd"),
    "LANDING": est(300000.0, "cd", "fixed landing light: sealed-beam and LED landing lights are rated a few hundred "
                   "thousand candela"),
    "TAXI": est(40000.0, "cd", "taxi light on the nose-gear strut: a sealed-beam taxi lamp's rating"),
    "TURNOFF": est(40000.0, "cd", "runway turn-off light: a wide-flood lamp of the taxi light's power"),
    "LOGO": est(5000.0, "cd", "logo light: a flood that lights the fin to a few hundred lux"),
    "WING": est(10000.0, "cd", "wing-illumination light: a flood that lights the leading edge 10 m out to tens "
                 "of lux, enough for the crew to inspect it for ice at night"),
}

LIGHT_BAKE = {
    "snap_offset": est(0.05, "m", "the build moves each lamp onto the nearest skin and this far out along its "
                       "normal, so a rough table position never ends up inside the structure"),
    "lens_radius": est(0.05, "m", "a lamp's emitting area: nearer than this the irradiance stops rising as 1/d^2 "
                       "(the falloff floor)"),
    "max_range": est(40.0, "m", "beyond this a lamp's contribution is dropped (the top beacon reaches the fin, 20 m "
                     "away; a wingtip lamp the fuselage, 15 m)"),
    "shared_outboard_of": est(8.0, "m", "the TAXI channel holds the taxi light inboard of this buttock line and the "
                              "white aft position lights outboard of it; neither lamp reaches the other's side"),
}

# ===================================================================================== budgets
BUDGET = {
    "airframe_tris": est(60000, "triangles", "a budget, not a dimension: section 6.5, 'airframe at most 60,000 "
                         "triangles'"),
    "shadow_tris": est(2000, "triangles", "section 10, F3.3: 'a 2,000-triangle shadow proxy'"),
    "glb_bytes": est(2_500_000, "bytes", "section 9.2: airframe, cabin and rig together 3.5 MB; 2.5 MB of that for "
                     "the airframe"),
}


# ===================================================================================== attitudes and speeds
# The reference attitudes and speeds the bake's lift model is fitted to (plan 03 section 7.3, F2.4;
# scripts/lib/attitude.py REFERENCE_ATTITUDES holds the same numbers with the conditions the table leaves open).
PERFORMANCE = {
    "reference_attitudes_60t": Dim(
        (("cruise FL350 M0.78, level", 0, 2.5), ("idle descent, M0.78 / 280 kt", 0, 0.0),
         ("level at manoeuvring speed, clean", 0, 5.0), ("level at manoeuvring speed, flaps 5", 5, 6.0),
         ("3 deg path at Vref + 5, flaps 30", 30, 2.4), ("3 deg path at Vref + 5, flaps 40", 40, 1.4)),
        "case|flap lever|deg", "B13", "section 7.3 'Pitch attitudes at 60 t: cruise at 35,000 ft 2.5; idle descent "
        "0; level at manoeuvring speed 5.0 clean and 6.0 with flaps 5; on a 3 path at reference speed + 5: 2.4 with "
        "flaps 30, 1.4 with flaps 40'"),
    "vref_kt": Dim(((55000, 128, 136), (60000, 135, 142), (65000, 141, 148)), "kg|kt flaps 40|kt flaps 30", "B13",
                   "section 7.3 'Reference speed, flaps 40 / 30: 128 / 136 kt at 55 t; 135 / 142 at 60 t; 141 / 148 at "
                   "65 t'"),
    "manoeuvring_additive_kt": Dim(((0, 70), (1, 50), (5, 30), (15, 20)), "flap lever|kt over Vref40", "B13",
                                   "section 7.3 'Flaps-40 reference speed + 70 kt clean, + 50 at flaps 1, + 30 at 5, "
                                   "+ 20 at 15'"),
    "manoeuvring_cruise_additive_kt": est(((2, 40), (10, 30), (25, 10)), "flap lever|kt over Vref40",
                                          "the detents section 7.3 does not table, between their neighbours"),
    "flare": Dim((20.0, 2.0, 3.0, 4.0, 7.0, 11.0), "ft|deg raise min|deg raise max|deg td min|deg td max|deg tail",
                 "B14", "section 7.3 'Begun at about 20 ft of wheel height by raising the nose 2 to 3; 4 to 8 s; "
                 "touchdown at 4 to 7; tail contact at 11'"),
    "idle_descent_fpm": Dim(((250, 1700, 2300), (280, 2200, 3100)), "kt|fpm clean|fpm speed brake", "B14",
                            "section 7.3 'idle rates 2,200 ft/min at Mach 0.78 or 280 kt (3,100 with the speed "
                            "brake) and 1,700 at 250 kt (2,300)'"),
    "gear_limit_kt": Dim(270, "kt", "B13", "section 7.3 'Gear limit speed, extension 270 kt'"),
    "flap_travel_s": est(40.0, "s", "section 7.3 'Surfaces then travel at a fixed rate (estimated: 40 s from up to "
                         "40)'"),
    "gear_travel_s": est(10.0, "s", "gear extension time, from footage of the type"),
    "derotate_s": est(5.0, "s", "main wheels to nose wheel on the runway; the flare table gives 4 to 8 s for the "
                      "flare, not the derotation"),
}


# ===================================================================================== helpers
def lerp(table, x: float, column: int = 1) -> float:
    """Piecewise-linear lookup in rows sorted by their first column; clamps at both ends."""
    rows = table.value if isinstance(table, Dim) else table
    if x <= rows[0][0]:
        return rows[0][column]
    for a, b in zip(rows, rows[1:]):
        if x <= b[0]:
            t = (x - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0.0
            return a[column] + (b[column] - a[column]) * t
    return rows[-1][column]


def wing_le(y: float) -> float:
    """Leading-edge station of the plain wing at semispan y (m)."""
    return lerp(WING["le"], abs(y))


def wing_te(y: float) -> float:
    return lerp(WING["te"], abs(y))


def wing_lower_z(y: float) -> float:
    """The wing's lower-surface reference line in body axes: through lower_z_at_root with the dihedral."""
    return float(WING["lower_z_at_root"]) + math.tan(math.radians(float(WING["dihedral"]))) * (
        abs(y) - float(WING["lower_z_root_y"]))


def body_station_to_x(station_in: float) -> float:
    """Boeing body station (inches, lettered plug stations not counted) to metres aft of the nose."""
    s, nose = float(station_in), float(STATIONS["nose_body_station"])
    if s > float(STATIONS["plug_aft_body_station"]):
        s += float(STATIONS["plug_aft_length"])
    if s > float(STATIONS["plug_fwd_body_station"]):
        s += float(STATIONS["plug_fwd_length"])
    return (s - nose) * _IN


def body_z_from_ground(height: float, station: float) -> float:
    """A height above the ground on the gear at empty weight, at station x, in body axes."""
    return height + (float(STATIONS["main_gear"]) - station) * math.tan(math.radians(-float(GROUND_ATTITUDE)))


def fin_z(drawing_z: float) -> float:
    """Height of a traced fin point in body axes: the drawn fin is 0.8 m taller than [B1]'s clearance table
    allows, so heights above the root are scaled to put the tip at TAIL_HEIGHT_TARGET on the gear."""
    root, tip = float(VERTICAL_TAIL["drawing_root_z"]), float(VERTICAL_TAIL["drawing_tip_z"])
    top = float(FUSELAGE["top_z"])
    tip_body = body_z_from_ground(float(TAIL_HEIGHT_TARGET), float(VERTICAL_TAIL["tip_station"]))
    return top + (drawing_z - root) * (tip_body - top) / (tip - root)
