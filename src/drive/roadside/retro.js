// Retroreflection: signs, lane lines and road studs lit by our own headlamps (plan 02, D5.2 and section 7.4).
// Pure: no three.js, no DOM.
//
// A retroreflector returns light toward its source in a narrow cone, so only our two headlamps matter. For one
// lamp, with E_perp its illuminance on a plane facing the lamp (lux), alpha the observation angle (lamp, surface,
// eye), beta the entrance angle (surface normal to the lamp) and nu the viewing angle (surface normal to the eye):
//
//   sheeting (R_A, cd lx^-1 m^-2):            L = ageing x R_A(alpha, beta) x E_perp / cos(nu)        [section 7.4]
//   pavement marking (R_L, cd m^-2 lx^-1):    L = ageing x R_L(alpha) x E_perp                         (R_L is defined
//                                             on luminance already, ASTM E1710 / EN 1436, so no 1 / cos nu)
//   road stud (R_I, cd lx^-1):                I = ageing x R_I(alpha, beta) x E_perp; luminance over its lens area.
//
// Shader mirror: bake retroCoefficient(type, alpha, beta) into a small 2-D table per type (alpha 0..2 deg on the
// u axis, beta 0..90 deg on v; it is smooth, so 32 x 16 texels and bilinear filtering hold the 2-D table well),
// compute alpha, beta and nu exactly as retroGeometry() does (three dot products and acos), take E_perp from the
// beam map as I / d^2 (beam.js), and add the luminance of both lamps. With the lamps off E_perp is 0, so is L.

import { DEFAULT_LAMPS, illuminancePerpendicular } from '../lights/beam.js';

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- coefficient tables
// Sheeting: ASTM D4956 Type XI minimum R_A for new sheeting, cd/lx/m^2, from Avery Dennison's OmniCube T-11000
// product bulletin, Table A (issued Sep 2025, read 2026-11-22) [plan 02, R10]; the alpha = 0.2, beta = -4 column
// matches FHWA's table as quoted by the plan's secondary source (580 / 435 / 58 / 87) [R10].
// Rows are entrance angle |beta|: the standard's -4 deg row stands for 0..4 deg.
// The alpha = 1.5 deg column and the beta = 40 deg row are DERIVED from the same bulletin's Table B (the European
// RA3 geometry), as ratios to its neighbouring column or row: R_A(1.5) / R_A(1.0) = 15/80 at +5 deg and 10/50 at
// +30 deg; R_A(40) / R_A(30) = 55/235 at 0.2 deg, 30/150 at 0.33 deg (used for 0.5) and 15/50 at 1.0 deg (used for
// 1.0 and 1.5). The beta = 60 row is ASSUMED to have fallen to zero (full-cube prisms stop returning light near
// there). The alpha = 2.0 column is ASSUMED at 0.35 of the 1.5 column (the 1.0-to-1.5 ratio, about 0.19 per half
// degree, slowed), so the return keeps falling for an eye far from the lamps at close range; beyond 2.0 it holds.
// alpha below 0.2 holds the 0.2 value (ASSUMED; conservative, real sheeting is brighter there).
const SHEET_ALPHA = [0.2, 0.5, 1.0, 1.5, 2.0];
const SHEET_BETA = [4, 30, 40, 60];
const ALPHA2 = 0.35; // R_A(2.0) / R_A(1.5), ASSUMED
const sheet = (m4, m30, m40) => [m4, m30, m40].map((r) => [...r, r[3] * ALPHA2]).concat([[0, 0, 0, 0, 0]]);
const WHITE = sheet([580, 420, 120, 120 * 15 / 80], [220, 150, 45, 45 * 10 / 50], [220 * 55 / 235, 150 * 30 / 150, 45 * 15 / 50, 9 * 15 / 50]);
const scaleRows = (rows, k) => rows.map((r) => r.map((x) => x * k));
// The colour columns of Table A are, within the bulletin's rounding, fixed fractions of white (yellow 0.75,
// green 0.10, red 0.15 at every tabulated angle); the derived cells use the same fractions.
const sheetTable = (frac, given) => {
  const t = scaleRows(WHITE, frac);
  given.forEach(([i, j, v]) => { t[i][j] = v; }); // exact Table A cells where they differ from the fraction
  return t;
};

// Pavement markings (lane lines with glass beads): R_L at the 30 m geometry of ASTM E1710 (alpha 1.05 deg,
// beta 88.76 deg from the normal), mcd/m^2/lx. ASSUMED new-marking values, white 250 and yellow 175: typical of
// beaded waterborne paint when new, and above the in-service minima the MUTCD's 2022 rule sets (50, or 100 at
// 70 mph and over) [plan 02, R5, Part 3] (section numbers and values recalled, not re-opened). The alpha curve is
// ASSUMED (beads return a wider cone than prisms, so it falls slowly); beta is near grazing for every marking a
// driver sees, and is ignored.
const MARK_ALPHA = [0.2, 0.5, 1.05, 2.29, 4.0];
const MARK_SHAPE = [1.6, 1.35, 1.0, 0.6, 0.3];

// Raised retroreflective pavement markers (road studs): ASTM D4280 minimum specific intensity R_I for new
// markers, white 3.0 cd/fc at alpha 0.2, beta 0 and 1.2 cd/fc at beta +-20 (0.279 and 0.112 cd/lx); yellow 60%
// and red 25% of white. Recalled, not re-opened (§); ASTM D4280 is paywalled. The alpha falloff beyond 0.2 deg and the
// beta rows past 20 deg are ASSUMED (prismatic, like sheeting but steeper).
const STUD_ALPHA = [0.2, 0.5, 1.0, 2.0];
const STUD_BETA = [0, 20, 45, 60];
const STUD_WHITE = [
  [0.279, 0.279 * 0.45, 0.279 * 0.15, 0.279 * 0.03],
  [0.112, 0.112 * 0.45, 0.112 * 0.15, 0.112 * 0.03],
  [0.014, 0.014 * 0.45, 0.014 * 0.15, 0.014 * 0.03],
  [0, 0, 0, 0],
];
/** ASSUMED reflective face of a stud: 100 mm x 13 mm, the lens of a typical 4 in marker. */
export const STUD_LENS_AREA_M2 = 0.1 * 0.013;

/**
 * Types: kind 'sheeting' (R_A, cd/lx/m^2), 'marking' (R_L, cd/m^2/lx) or 'stud' (R_I, cd/lx).
 * alpha and beta in degrees; table[i][j] is at beta[i], alpha[j].
 */
export const RETRO_TYPES = Object.freeze({
  white: { kind: 'sheeting', alpha: SHEET_ALPHA, beta: SHEET_BETA, table: WHITE },
  yellow: { kind: 'sheeting', alpha: SHEET_ALPHA, beta: SHEET_BETA, table: sheetTable(0.75, [[1, 0, 165], [1, 1, 110], [1, 2, 34], [0, 1, 315], [0, 2, 90]]) },
  green: { kind: 'sheeting', alpha: SHEET_ALPHA, beta: SHEET_BETA, table: sheetTable(0.1, [[0, 0, 58], [0, 1, 42], [0, 2, 12], [1, 0, 22], [1, 1, 15], [1, 2, 5]]) },
  red: { kind: 'sheeting', alpha: SHEET_ALPHA, beta: SHEET_BETA, table: sheetTable(0.15, [[0, 0, 87], [0, 1, 63], [0, 2, 18], [1, 0, 33], [1, 1, 23], [1, 2, 7]]) },
  markingWhite: { kind: 'marking', alpha: MARK_ALPHA, beta: [0, 90], table: [MARK_SHAPE.map((k) => 0.25 * k), MARK_SHAPE.map((k) => 0.25 * k)] },
  markingYellow: { kind: 'marking', alpha: MARK_ALPHA, beta: [0, 90], table: [MARK_SHAPE.map((k) => 0.175 * k), MARK_SHAPE.map((k) => 0.175 * k)] },
  studWhite: { kind: 'stud', alpha: STUD_ALPHA, beta: STUD_BETA, table: STUD_WHITE },
  studYellow: { kind: 'stud', alpha: STUD_ALPHA, beta: STUD_BETA, table: scaleRows(STUD_WHITE, 0.6) },
  studRed: { kind: 'stud', alpha: STUD_ALPHA, beta: STUD_BETA, table: scaleRows(STUD_WHITE, 0.25) },
});

/** Index and fraction of x in an ascending axis, clamped to its ends. */
function locate(axis, x) {
  const n = axis.length;
  if (!(x > axis[0])) return [0, 0];
  if (x >= axis[n - 1]) return [n - 2, 1];
  let i = 0;
  while (x > axis[i + 1]) i++;
  return [i, (x - axis[i]) / (axis[i + 1] - axis[i])];
}

/** Along alpha in log space (the falloff is close to exponential), plain linear when a value is zero. */
function lerpAlpha(row, i, f) {
  const a = row[i], b = row[i + 1];
  if (a > 0 && b > 0) return a * (b / a) ** f;
  return a + (b - a) * f;
}

/**
 * The tabulated coefficient of a type at (alpha, |beta|), interpolated: log-linear in alpha, linear in beta,
 * clamped at the table's ends. Units by kind: R_A cd/lx/m^2, R_L cd/m^2/lx, R_I cd/lx.
 */
export function retroCoefficient(type, alphaDeg, betaDeg) {
  const t = typeof type === 'string' ? RETRO_TYPES[type] : type;
  if (!t) throw new Error(`retro: unknown type ${type}`);
  const [j, fa] = locate(t.alpha, alphaDeg);
  const [i, fb] = locate(t.beta, Math.abs(betaDeg));
  const lo = lerpAlpha(t.table[i], j, fa);
  const hi = lerpAlpha(t.table[i + 1], j, fa);
  return lo + (hi - lo) * fb;
}

/**
 * Luminance of a retroreflective surface lit by one lamp, cd/m^2 (section 7.4).
 * @param {{ type: string, illuminancePerp: number, alphaDeg: number, betaDeg: number, viewAngleDeg?: number,
 *           ageing?: number, areaM2?: number }} o
 *   illuminancePerp: lux on a plane facing the lamp; ageing: 0.4..1 for in-service sheeting (1 = new);
 *   areaM2: for studs, the lens area the intensity is spread over (default STUD_LENS_AREA_M2)
 * @returns {number} cd/m^2; exactly 0 when illuminancePerp is 0 or the surface faces away from the eye
 */
export function retroLuminance({ type, illuminancePerp, alphaDeg, betaDeg, viewAngleDeg = 0, ageing = 1, areaM2 }) {
  if (!(illuminancePerp > 0)) return 0;
  const t = RETRO_TYPES[type];
  if (!t) throw new Error(`retro: unknown type ${type}`);
  const cosNu = Math.cos(viewAngleDeg * RAD);
  if (!(cosNu > 0)) return 0;
  const r = ageing * retroCoefficient(t, alphaDeg, betaDeg);
  if (t.kind === 'marking') return r * illuminancePerp;
  const c = Math.max(cosNu, 0.05); // grazing views: keep finite (the table has fallen to zero there anyway)
  if (t.kind === 'stud') return (r * illuminancePerp) / ((areaM2 || STUD_LENS_AREA_M2) * c);
  return (r * illuminancePerp) / c;
}

/** Intensity (cd) a retroreflector of a given area (sheeting, marking) or a stud sends back toward the eye. */
export function retroIntensity({ type, illuminancePerp, alphaDeg, betaDeg, viewAngleDeg = 0, ageing = 1, areaM2 = 1 }) {
  const t = RETRO_TYPES[type];
  if (!t) throw new Error(`retro: unknown type ${type}`);
  if (!(illuminancePerp > 0)) return 0;
  const r = ageing * retroCoefficient(t, alphaDeg, betaDeg);
  if (t.kind === 'stud') return r * illuminancePerp;
  if (t.kind === 'sheeting') return r * illuminancePerp * areaM2;
  return r * illuminancePerp * areaM2 * Math.max(Math.cos(viewAngleDeg * RAD), 0);
}

const v3 = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (len(a) * len(b))))) / RAD;

/**
 * Angles of section 7.4 for one lamp. Positions in any one frame, metres; normal need not be unit length.
 * @returns {{ alphaDeg: number, betaDeg: number, viewAngleDeg: number, dLamp: number, dEye: number }}
 *   alpha: lamp-surface-eye; beta: normal to lamp; nu (viewAngleDeg): normal to eye
 */
export function retroGeometry(lamp, eye, point, normal) {
  const p = v3(point), n = v3(normal);
  const toLamp = sub(v3(lamp), p), toEye = sub(v3(eye), p);
  return {
    alphaDeg: angle(toLamp, toEye),
    betaDeg: angle(n, toLamp),
    viewAngleDeg: angle(n, toEye),
    dLamp: len(toLamp),
    dEye: len(toEye),
  };
}

/**
 * Luminance (cd/m^2) of a retroreflective surface lit by our headlamps through a beam map, summed over lamps.
 * Positions in the car frame of beam.js (x right, y up, z forward, metres). map null (lamps off) gives exactly 0.
 * @param {{ type: string, map: object|null, lamps?: Array, eye: object|number[], point: object|number[],
 *           normal: object|number[], aim?: object, ageing?: number }} o
 */
export function retroFromHeadlamps({ type, map, lamps = DEFAULT_LAMPS, eye, point, normal, aim, ageing = 1 }) {
  if (!map) return 0;
  let l = 0;
  for (const lamp of lamps) {
    const g = retroGeometry(lamp, eye, point, normal);
    if (g.betaDeg >= 90) continue; // lamp behind the surface
    const e = illuminancePerpendicular(map, lamp, point, aim);
    l += retroLuminance({ type, illuminancePerp: e, alphaDeg: g.alphaDeg, betaDeg: g.betaDeg, viewAngleDeg: g.viewAngleDeg, ageing });
  }
  return l;
}
