// The aircraft's published dimensions in one place (plan 03, sections 6.5 and 7.4), for the code-built v0 airframe,
// the cabin and the seat layout. Pure numbers, no three.js. Sources are the plan's references (section 13): [B1] the
// manufacturer's airport-planning document, [B2] the type certificate data, [B3] the 737 technical site, [B4] the NTSB
// report with the window, [B5] a third-party cabin drawing. "Scaled" means scaled from [B1]'s drawings, as the plan
// does. ESTIMATED marks a number this file chose because no source gives it; models/aircraft/spec.py (F3.1) is the
// authority once it exists, and these should be checked against it then.
//
// Stations are metres aft of the nose. Heights are metres above the ground with the aircraft empty on its wheels.
// Spanwise offsets ("out") are metres from the centre line unless the name says otherwise.

export const IN = 0.0254;
export const FT = 0.3048;

export const FUSELAGE = Object.freeze({
  length: 38.02, // [B1]
  lengthOverall: 39.47, // [B1] (to the tail cone's tip past the fuselage, with the fin)
  width: 3.76, // [B1], [B3]
  height: 4.01, // [B1], [B3]
  top: 5.56, // height of the fuselage top [B1]
  // The cross-section as an upper half circle of the half-width and a lower half ellipse down to the belly
  // (ESTIMATED shape; the width, height and top are published). Centre of the upper circle:
  get axisY() { return this.top - this.width / 2; }, // 3.68
  cabinWidth: 3.54, // between the trim panels [B1]
  /** Inner trim panel as a circle about the same axis: half the cabin width (ESTIMATED: the trim is a cylinder). */
  get trimRadius() { return this.cabinWidth / 2; }, // 1.77
  floorAtWing: 2.9, // floor height at the wing, plan 7.4 (from [B1]: door sill 2.74 m forward, the floor rising aft)
  /** Nose taper ends and tail taper starts (ESTIMATED from [B1]'s side view). */
  noseEnd: 6.5,
  tailStart: 27.5,
  tailTipY: 4.75, // ESTIMATED: the tail cone's tip, swept up
  noseTipY: 3.2, // ESTIMATED: the nose tip, below the axis
});

export const GEAR = Object.freeze({
  noseStation: 4.09, // [B1]
  wheelbase: 15.60, // [B1]
  track: 5.72, // [B1]
  /** The body origin (section 5.5): the main gear's contact point on the centre line. */
  get mainStation() { return this.noseStation + this.wheelbase; }, // 19.69
});

export const WING = Object.freeze({
  span: 34.32, // without winglets [B1]
  spanWinglets: 35.79, // [B1]
  area: 124.58, // [B3]
  sweepQuarter: 25.02, // degrees [B2], [B3]
  dihedral: 6, // degrees [B2], [B3]
  /** Root at the fuselage side (out = half the fuselage width). */
  rootLE: 15.0, rootTE: 21.4, // scaled from [B1]
  /** The trailing-edge kink, 5.6 m out from the fuselage side (plan 6.5 "at the kink 5.6 m out"; measured from the
   * centre line the inboard trailing edge would have to sweep forward, which the type's does not). Chord 3.6 m. */
  kinkFromSide: 5.6, kinkChord: 3.6, // scaled from [B1]
  tipLE: 23.47, tipTE: 24.99, // [B1], printed dimensions
  tipY: 3.91, // bare wingtip height [B1]
  /** Thickness over chord at the root, kink and tip (ESTIMATED, typical of the type's sections). */
  thickness: [0.15, 0.12, 0.10],
});

export const WINGLET = Object.freeze({
  height: 8 * FT, // "8 ft tall" [B1], [B3]
  baseChord: 4 * FT, // "about 4 ft wide at its base" [B3]
  lastPoint: 26.01, // the winglet's last point, metres aft of the nose [B1]
  topY: 6.76, // winglet top height [B1]
  /** The blend: a circular arc of this radius from the wing's dihedral to the panel's angle (ESTIMATED radius). The
   * panel's angle and length are solved so the tip lands on the published span with winglets and the published
   * height: 85 degrees from horizontal and 2.314 m with a 0.6 m blend (tests/unit/flight/airframe.test.js holds it). */
  blendRadius: 0.6,
  panelAngle: 85, // degrees from horizontal (solved, see above)
  panelLength: 2.314, // m (solved)
  tipChord: 0.6, // ESTIMATED
});

export const ENGINE = Object.freeze({
  out: 4.83, // centre line from the aircraft's [B1]
  inlet: 13.36, // inlet station [B1]
  fan: 61 * IN, // fan diameter [B3]
  width: 2.06, // nacelle width [B3]
  length: 4.2, // ESTIMATED: inlet lip to the fan nozzle
  bottomY: 0.64, // the nacelle's lowest point above the ground, empty [B1] p. 2-19 (as models/aircraft/spec.py has it)
  flatten: 0.85, // ESTIMATED: the lower half's height over its half-width (the flattened lower cowl)
  /** Centre-line height: the flattened bottom put on the published clearance. */
  get axisY() { return this.bottomY + (this.width / 2) * this.flatten; },
});

export const TAIL = Object.freeze({
  height: 12.55, // fin top above the ground [B1]
  // the tailplane and fin planforms are ESTIMATED from [B1]'s three-view (not needed from the cabin)
  stabSpan: 14.35, stabRootLE: 31.6, stabRootChord: 4.1, stabTipChord: 1.3, stabSweepLE: 33, stabY: 4.55, stabDihedral: 7,
  finRootLE: 29.6, finRootChord: 6.3, finTipChord: 2.0, finSweepLE: 37, finRootY: 5.3,
});

export const WINDOW = Object.freeze({
  width: 10.5 * IN, // 267 mm [B4]
  height: 14.4 * IN, // 366 mm [B4]
  /** Corner radius of the opening: ESTIMATED (no source gives it; about a third of the width, as photographs show). */
  cornerRadius: 0.085,
  /** Centre of the opening above the floor: ESTIMATED in the plan (7.4) until F3.1 measures it. */
  centreAboveFloor: 0.97,
  /** Inner trim face to the outer skin: the depth of the reveal (ESTIMATED: trim radius to skin radius). */
  get revealDepth() { return FUSELAGE.width / 2 - FUSELAGE.trimRadius; },
});

/** Seat layout of a generic single-class cabin (plan 7.4's table). */
export const CABIN = Object.freeze({
  rows: 30,
  firstRowFront: 6.1, // front of the first row's seat, as a published 189-seat layout [B5]
  pitch: 31 * IN,
  exitPitch: 38 * IN, // the two rows at the overwing exits
  exitRows: [15, 16], // rows behind the exits ("the exits are ahead of rows 15 and 16", plan 7.4)
  seatWidth: 17 * IN, // the manufacturer's cabin cross-section
  tripleWidth: 59 * IN,
  aisle: 20 * IN,
  eyeAft: 0.55, // eye aft of the seat front
  eyeAboveFloor: 1.2, // seat surface 0.43 m (scaled) + seated eye height 0.77 m (US Army survey means)
  seatHeight: 0.43, // scaled from the cross-section drawing, not published
  overwingExits: [16.70, 17.67], // [B5]
  // The seat itself, ESTIMATED (an economy seat as drawn in the manufacturer's cross-section, not published):
  backFace: 0.72, // the seat back's cushion face at head height, aft of the seat front: the eye plus a head's depth
  backThickness: 0.08,
  backTop: 1.12, // top of the seat back above the floor
  cushionDepth: 0.48,
  bulkheadAhead: 0.3, // row 1: the wall ahead of the first row, this far ahead of its seat front
});

/** Body z of a station (metres aft of the nose): the origin is the main gear contact point, nose toward -z. */
export const bodyZ = (station) => station - GEAR.mainStation;
/** Station of a body z. */
export const stationOf = (z) => z + GEAR.mainStation;
