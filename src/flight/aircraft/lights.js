// The aircraft's own lights, the pure part (plan 03, sections 7.5 and 7.8; F3.8): which lamps are on, and how bright
// each group is at a moment. lightsDraw.js turns the levels into light on the skin and points in the sky.
//
// Two time bases (7.5). Which lamps are on is the flight's: the `lights` bit field of the flight file, at journey time.
// How a flashing lamp is lit right now is presentation time's (the wall clock while playing, frozen while paused), so
// at 8x the strobes still flash once a second, not eight times. The beacon and the strobes run at the 60 a minute of
// 7.8, staggered by half a period; the limiter keeps the sum at or under three flashes a second (WCAG 2.2, 2.3.1), and
// with reduced motion they burn steady and dim instead.
//
// Day and night need no rule here: the levels are in physical units downstream (candela, then cd/m^2 through the
// environment's exposure), so a lamp that lights a sunlit wing simply does not show, as in life.

import { LIGHT } from '../track.js';

/** The groups in the bit field's order (bit i = 1 << i), which is also the order of _LIGHTS0.xyzw, _LIGHTS1.xyzw. */
export const GROUPS = Object.freeze(['NAV', 'BEACON', 'STROBE', 'LANDING', 'TAXI', 'TURNOFF', 'LOGO', 'WING']);
const BEACON = GROUPS.indexOf('BEACON'), STROBE = GROUPS.indexOf('STROBE');

/** WCAG 2.2 success criterion 2.3.1: at most three flashes in any one second. */
export const MAX_FLASHES_PER_S = 3;
/** Under reduced motion the flashing lamps burn steady at this share of their peak. */
export const STEADY_DIM = 0.15;

/**
 * Peak intensity of each kind of lamp toward its axis, candela: the 1.0 of the lamp's photometry in the bake
 * (models/aircraft/spec.py LIGHT_CANDELA, written to rig.json lightBake.candela; tests/unit/flight/lights.test.js holds
 * the two equal but for the groups in TUNED below). Keys are the groups, plus NAV_AFT for the white aft position
 * lights, which switch with NAV.
 *   NAV       100     ESTIMATED: 14 CFR 25.1391 asks 40 cd at least within 10 deg of ahead; LED units give more
 *   NAV_AFT   40      ESTIMATED: 25.1391(c) asks 20 cd at least in the rear 140 deg
 *   BEACON    1100    the least peak that keeps 25.1401(f)'s 400 cd effective with FLASHERS' 0.3 s pulse (420 cd).
 *                     It was 1,500 (ESTIMATED), and the pulse flooded the upper wing red (F8.1, 25 Nov 2026)
 *   STROBE    5000    ESTIMATED peak; with the 0.08 s pulse about 900 cd effective (effectiveIntensity below)
 *   LANDING   300000  ESTIMATED: sealed-beam and LED landing lights are rated a few hundred thousand candela
 *   TAXI      40000   ESTIMATED: a sealed-beam taxi lamp
 *   TURNOFF   40000   ESTIMATED: a wide flood of the taxi light's power
 *   LOGO      5000    ESTIMATED: lights the fin to a few hundred lux
 *   WING      5000    ESTIMATED: lights the slats to 10 to 20 lux (grey at the night exposure), the nacelle's top 3 m
 *                     from the lamp to 160 lux at most (light grey, not white). It was 10,000: the nacelle drew white
 *                     (F8.1, 25 Nov 2026). The bake's beam puts twelve times more on the cowl than on the leading edge,
 *                     so no one figure lights the edge pale and keeps the cowl grey; the cowl decided
 */
export const CANDELA = Object.freeze({
  NAV: 100, NAV_AFT: 40, BEACON: 1100, STROBE: 5000, LANDING: 300000, TAXI: 40000, TURNOFF: 40000, LOGO: 5000, WING: 5000,
});
/**
 * The groups whose candela F8.1 changed from what the bake assumed (rig.json lightBake.candela, from
 * models/aircraft/spec.py LIGHT_CANDELA). The bake stores light per candela, so this is a run-time change; spec.py's
 * figures should follow when the lamps are next baked.
 */
export const TUNED = Object.freeze({ BEACON: Object.freeze({ baked: 1500 }), WING: Object.freeze({ baked: 10000 }) });

/**
 * Linear RGB, scaled to a luminance of 1 so that candela carries the brightness. Chromaticities of 14 CFR 25.1397:
 * aviation green and white lie inside the display's gamut and are met; aviation red (y <= 0.335, z <= 0.002) lies
 * outside it, so red is the display's red primary, the nearest it can show.
 */
const unitLuminance = (c) => { const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return Object.freeze(c.map((v) => v / y)); };
export const COLOURS = Object.freeze({
  red: unitLuminance([1, 0, 0]),
  green: unitLuminance([0, 1, 0.3]),
  white: unitLuminance([1, 0.97, 0.92]),
});

/**
 * Effective intensity of a flash (Blondel-Rey, the form 14 CFR 25.1401 and AC 20-74 rate anti-collision lights by):
 * I_e = integral(I dt) / (0.2 + t2 - t1), for FLASHERS' half-sine pulse of `widthS` seconds and `peak` candela.
 */
export function effectiveIntensity(peak, widthS) {
  return (peak * 2 * widthS) / Math.PI / (0.2 + widthS);
}

/**
 * Raise flashers' rates in proportion only so far that together they flash at most `max` times a second, and spread
 * their phases evenly so no two fire together.
 * @param {{ id: string, rateHz: number, widthS?: number }[]} list
 */
export function limitFlashers(list, max = MAX_FLASHES_PER_S) {
  const total = list.reduce((s, f) => s + f.rateHz, 0);
  const k = total > max ? max / total : 1;
  return list.map((f, i) => ({ ...f, rateHz: f.rateHz * k, phase: i / list.length }));
}

/** The flashers: beacon (a rotating-looking red pulse) and strobes (a short white flash), at 60 a minute each (7.8). */
export const FLASHERS = Object.freeze(limitFlashers([
  { id: 'STROBE', rateHz: 1, widthS: 0.08 },
  { id: 'BEACON', rateHz: 1, widthS: 0.3 },
]).map(Object.freeze));

/**
 * One flasher's level, 0..1, at presentation time `t` seconds: a half-sine pulse `widthS` long at the start of each
 * period, dark the rest.
 * @param {{ rateHz: number, phase: number, widthS: number }} f  @param {number} t
 */
export function flashLevel(f, t) {
  const cycles = t * f.rateHz + f.phase;
  const s = (cycles - Math.floor(cycles)) / f.rateHz;
  return s < f.widthS ? Math.sin((Math.PI * s) / f.widthS) : 0;
}

/**
 * Each group's level, 0..1, in GROUPS order: 0 when its bit is clear, 1 when a steady lamp is on, the flash when a
 * flashing one is (or STEADY_DIM under reduced motion).
 * @param {number} bits  the `lights` bit field
 * @param {number} wallS  presentation time, seconds
 * @param {{ reducedMotion?: boolean, journeyT?: number }} [o]  journeyT is accepted and ignored: flashes never follow it
 * @param {Float32Array | number[]} [out]
 */
export function lampLevels(bits, wallS, { reducedMotion = false } = {}, out = new Array(GROUPS.length)) {
  const t = Number.isFinite(wallS) ? wallS : 0;
  for (let i = 0; i < GROUPS.length; i++) out[i] = bits & (1 << i) ? 1 : 0;
  for (const f of FLASHERS) {
    const i = f.id === 'BEACON' ? BEACON : STROBE;
    if (out[i]) out[i] = reducedMotion ? STEADY_DIM : flashLevel(f, t);
  }
  return out;
}

const TEN_THOUSAND_FT = 10000 * 0.3048;

/**
 * The lights schedule of 7.8, for a flight file that carries no `lights` channel (the bake writes the bits itself):
 * position lights, beacon and strobes throughout; landing lights below 10,000 ft and on the runway; runway turn-off and
 * taxi lights with the gear down; logo and wing lights at night below 10,000 ft.
 * @param {{ altMsl: number, gear?: number, onGround?: boolean }} state
 * @param {{ night?: boolean }} [o]
 */
export function inferLights(state, { night = false } = {}) {
  let b = LIGHT.NAV | LIGHT.BEACON | LIGHT.STROBE;
  const low = state.onGround || state.altMsl < TEN_THOUSAND_FT;
  if (low) b |= LIGHT.LANDING;
  if (low && night) b |= LIGHT.LOGO | LIGHT.WING;
  if ((state.gear || 0) >= 0.5) b |= LIGHT.TAXI | LIGHT.TURNOFF;
  return b;
}

/**
 * The bits to draw: the flight file's when it has the channel (`hasChannel`, from the header), else the state's when
 * any is set, else the schedule.
 * @param {{ lights?: number, altMsl: number, gear?: number, onGround?: boolean }} state
 * @param {{ hasChannel?: boolean, night?: boolean }} [o]
 */
export function lightBits(state, { hasChannel = false, night = false } = {}) {
  if (hasChannel || state.lights) return state.lights | 0;
  return inferLights(state, { night });
}

/**
 * rig.json's lamps with what drawing them needs: { name, group (GROUPS index), position and unit direction (body
 * axes, metres), coneDeg, colour (linear RGB of unit luminance), candela (peak, on axis, by the lamp's intensity key) }.
 * @param {{ lights: Record<string, { position: number[], channel: string, colour: string, direction: number[], coneDeg: number, intensity?: string }> }} rig
 */
export function lampTable(rig) {
  return Object.entries(rig.lights).map(([name, l]) => {
    const n = Math.hypot(...l.direction) || 1;
    return {
      name, group: GROUPS.indexOf(l.channel), position: l.position.slice(), direction: l.direction.map((v) => v / n),
      coneDeg: l.coneDeg, colour: COLOURS[l.colour] ?? COLOURS.white, candela: CANDELA[l.intensity ?? l.channel],
    };
  });
}
