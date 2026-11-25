// The exposure while flying (plan 03, sections 7.7, 7.11, F5.6; the exposure pass of 25 Nov 2026). Pure: numbers in,
// numbers out, no three.js.
//
// Plan 01's prior (src/render/photometry.js) predicts the average luminance a viewer adapts to from the light where the
// camera is: L = 0.2 (E_key max(sin alt, 0) + E_sky + E_city) / pi. Its city term is a stand-in for a camera standing
// in the lit city: 1 lux of the city's light on itself and 1 lux of its emission wherever the street lights are on. A
// window seat is not there. At cruise the aircraft is 9 km up over dark desert with the valley 100 km off; on final it
// is over a carpet of lamps; and at dusk the Sun grazes a broken range of mountains. So while a journey is attached the
// prior's terms are replaced (src/flight/env.js hands this to plan 01's look, `setPriorTerms`):
//
//   city      the light the valley's and the towns' lamps actually send to the aircraft: the scalar illuminance at the
//             eye from every lamp cell, as the flight's lamp points draw it (src/drive/lights/sprites.js: a lamp's pool
//             and its neighbourhood's light seen from afar, albedo x ALL_LIGHT_FACTOR x lumens x down share / pi x cos
//             of the zenith angle toward the eye, faded in from 300 m to 2.5 km), through the air (extinction.js) and
//             the window's glass, times the lamps' lit share and the lights-out slider. Zero over dark desert by day.
//   floor     plus a constant ADAPT_FLOOR_LUX: the eye in a cabin at night does not adapt to the darkness outside. The
//             passenger sits in a lit or dimmed cabin, and the eye, which takes some 30 minutes to adapt fully to the
//             dark, keeps its mesopic state (CIE 191:2010 puts the mesopic range at 0.005 to 5 cd/m^2). 0.25 lux is a
//             prior luminance of 0.016 cd/m^2, the lower part of that range. An ESTIMATE, tuned by measuring the
//             displayed frame (tests/manual/flight-night-shots.mjs) against the targets of the pass: the towns read as
//             clusters from cruise and the dimmed cabin's shapes stay readable.
//   key       at a grazing Sun, the key is taken on lit terrain, not flat ground: max(sin alt, LIT_TERRAIN_SIN) with
//             the Sun near the horizon (faded out over GUARD_DEG below it, where the legacy key fades). Plan 01's
//             sin(alt) is the irradiance of flat ground; at 0.2 degrees it is 0.0035, while a slope facing the Sun takes
//             0.5 to 1 of the key: five to seven stops over, drawn as white blotches (1.6 to 4.3 % of the ground at
//             10,000 ft on lv-19-dusk). With 0.06 (sin 3.4 degrees) a desert slope of reflectance 0.3 facing the Sun at
//             45 degrees lands about 4 stops over the prior's average, inside AgX's shoulder (its white is some 6.5
//             stops over mid-grey). Measured on lv-19-dusk: no ground clipped at 18,000 and 10,000 ft, the exposure
//             0.6 and 1.4 EV lower there. 0.18 (sin 10.4 degrees, the first try) put it 1.9 and 2.75 EV lower, the
//             slopes peaking at 150 of 255 and the shade, the wing and the cabin dark: more than the clipping asked
//             for. An ESTIMATE, tuned. The guard fades out between 1 and 6 degrees (GUARD_FADE_DEG: measured, the
//             slopes clip only below about 2), so day, and a Sun 9.6 degrees up at cruise, are exactly unchanged.
//   ground    near the ground the camera is back where plan 01's stand-in was written: in the lit city, among walls,
//             signs and the airport's floodlights, which the pools seen edge-on no longer carry (their cos of the
//             zenith angle goes to 0). So a share GROUND_SHARE of plan 01's own city terms (which follow the street
//             lights' switch-on) comes back below GROUND_FADE_M above the ground, faded smoothly. ESTIMATES both,
//             set so that the runway is exposed between final and cruise.
//   sky       plan 01's ambient (starlight, airglow and the twilight sky, its clear-sky table) and the Moon as the key,
//             unchanged.
//
// Plan 01's city light (src/render/look.js cityLight: an ambient light of cityLux on everything drawn, the city's light
// on itself) is the same stand-in; with the night exposed for the window it lit the desert 100 km out and the wing at
// cruise a visible tan. While flying it carries the lamps' light at the aircraft instead (cityLightLux), and plan 01's
// own near the ground.
//
// The glass (GLASS_TRANSMISSION, what the three-sheet stack passes) is folded into the lamps' term only, the light this
// pass adds. Plan 01's other terms never knew the glass, and scaling them would move the day.
//
// Adaptation speed: none is added. The prior is continuous in the aircraft's position (the lamps' cells fade in over
// 2.2 km, so nothing steps) and changes slowly: on the night arrivals k falls 1.7 to 2.3 EV between 10,000 ft and base over
// some six minutes, eases back 0.3 to 0.6 EV over the next 90 s as the aircraft sinks below the pools' best angle, and
// moves under 0.2 EV more to the runway. Steps that small, either way, the eye follows in seconds (its fast neural and
// pupil adaptation; only a large drop into darkness needs the minutes of photochemical dark adaptation: Hood and
// Finkelstein 1986, Handbook of Perception and Human Performance, ch. 5, RECALLED, not re-read). A seek is a cut,
// where the exposure should be right at once. Plan 01's Camera mode keeps its own time constants (0.6 s and 3 s)
// around this prior.

/** What the window passes: 0.787, the pane's light over the outside's as measured in the app by the night-look pass
 * (24 Nov 2026); the stack at normal incidence (paneOptics stackOptics(1).T = 0.793) times the tint's luminance (0.986)
 * gives 0.782. */
export const GLASS_TRANSMISSION = 0.787;
/** The eye's adaptation floor while flying, lux in the prior's terms (ESTIMATE, see the header). */
export const ADAPT_FLOOR_LUX = 0.25;
/** The key on lit terrain at a grazing Sun: sin of the key's effective altitude (ESTIMATE, see the header). */
export const LIT_TERRAIN_SIN = 0.06;
/** The guard is full with the Sun on the horizon and gone this far below it (degrees). */
export const GUARD_DEG = 2;
/** Above the horizon the guard is full to the first altitude and gone by the second (degrees): measured, the slopes
 * clipped with the Sun at 0.2 and 1.7 degrees (1.6 to 4.3 % and 0.8 % of the ground) and not at 4.2 or above. */
export const GUARD_FADE_DEG = Object.freeze([1, 6]);
/** Share of plan 01's city terms (cityLux + emissionLux) the prior keeps on the ground (ESTIMATE, see the header). */
export const GROUND_SHARE = 0.25;
/** Height above the ground (m) by which that share has faded out. */
export const GROUND_FADE_M = 300;
/** Where a lamp's pool joins its point, m (src/flight/ground/lamps.js POOL_RANGE_M, the sprites' uGlowRange). */
export const POOL_RANGE_M = Object.freeze([300, 2500]);

const DEG = Math.PI / 180;
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * One lamp pack (src/drive/lights/pack.js decodeLampPack) merged into its own cells: the flux-weighted centre, the
 * mean mount height and the flux that goes down (lumens x (1 - uplight)), tunnel and bridge lamps left out (they send
 * nothing to the sky, as the drawn lamps do).
 * @param {{ count: number, nx: number, ny: number, cellStart: Uint32Array, x: Float64Array, y: Float64Array,
 *   lumens: Float32Array, mount: Float32Array, type: Uint8Array, enclosed: Uint8Array }} pack
 * @param {(type: number) => number} downShareOf the share of a type's flux below the horizontal
 * @returns {{ n: number, x: Float64Array, y: Float64Array, mount: Float32Array, flux: Float64Array }} map metres (x east, y north)
 */
export function mergeLampCells(pack, downShareOf = () => 1) {
  const nCells = pack.nx * pack.ny;
  const xs = [], ys = [], ms = [], fs = [];
  for (let c = 0; c < nCells; c++) {
    const a = pack.cellStart[c], b = pack.cellStart[c + 1];
    if (b <= a) continue;
    let f = 0, sx = 0, sy = 0, sm = 0;
    for (let i = a; i < b; i++) {
      if (pack.enclosed[i]) continue;
      const w = pack.lumens[i] * downShareOf(pack.type[i]);
      f += w; sx += w * pack.x[i]; sy += w * pack.y[i]; sm += w * pack.mount[i];
    }
    if (!(f > 0)) continue;
    xs.push(sx / f); ys.push(sy / f); ms.push(sm / f); fs.push(f);
  }
  return { n: fs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), mount: Float32Array.from(ms), flux: Float64Array.from(fs) };
}

/**
 * Merged cells placed in the scene: x, the ground's scene y under the cell (curve drop included) and z = -y.
 * @param {Array<ReturnType<typeof mergeLampCells>>} sets
 * @param {{ heightAt: (x: number, y: number) => number, base: number, curveDrop: (x: number, z: number) => number }} o
 * @returns {Float64Array} 4 per cell: x, groundY, z, flux
 */
export function placeLampCells(sets, { heightAt, base, curveDrop }) {
  const n = sets.reduce((a, s) => a + s.n, 0);
  const out = new Float64Array(4 * n);
  let k = 0;
  for (const s of sets) {
    for (let i = 0; i < s.n; i++, k += 4) {
      const x = s.x[i], y = s.y[i];
      out[k] = x; out[k + 1] = heightAt(x, y) - base - curveDrop(x, y); out[k + 2] = -y; out[k + 3] = s.flux[i];
    }
  }
  return out;
}

/**
 * The scalar illuminance (lux) at the eye from the lamps' pools, as the flight's lamp points draw them, before the
 * glass: sum over cells of albedo x flux / pi x cos(zenith toward the eye) x fade(d) x exp(-d / extinctionM) / d^2.
 * @param {Float64Array} cells placeLampCells()
 * @param {{ x: number, y: number, z: number }} eye scene metres
 * @param {{ extinctionM?: number, albedo?: number, range?: readonly number[], lit?: number, cityFactor?: number }} [o]
 *   albedo: the pools' effective reflectance (GROUND_ALBEDO x ALL_LIGHT_FACTOR in lamps.js); lit: the share of lamps
 *   on; cityFactor: the lights-out slider
 */
export function lampIlluminance(cells, eye, { extinctionM = 80000, albedo = 0.75, range = POOL_RANGE_M, lit = 1, cityFactor = 1 } = {}) {
  if (!cells || !(lit > 0) || !(cityFactor > 0)) return 0;
  const L = Math.max(1, extinctionM), r0 = range[0], r1 = range[1];
  let e = 0;
  for (let k = 0; k < cells.length; k += 4) {
    const dx = cells[k] - eye.x, dz = cells[k + 2] - eye.z, dy = eye.y - cells[k + 1];
    if (dy <= 0) continue;
    const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
    if (d <= r0) continue;
    e += (cells[k + 3] * (dy / d) * smooth01(r0, r1, d) * Math.exp(-d / L)) / d2;
  }
  return (e * albedo * lit * cityFactor) / Math.PI;
}

/**
 * The prior's terms while flying, from plan 01's (src/render/photometry.js physicalLights plus keyAltDeg).
 * @param {{ keyLux: number, keyAltDeg: number, ambientLux: number, cityLux?: number, emissionLux?: number }} terms
 * @param {{ lampLux?: number, heightAboveGroundM?: number, keyIsSun?: boolean, cityFactor?: number, glass?: number, floorLux?: number,
 *   litSin?: number, guardDeg?: number, guardFadeDeg?: readonly number[], groundShare?: number, groundFadeM?: number }} [o]
 *   lampLux: lampIlluminance() at the eye, without the lights-out slider; heightAboveGroundM: the eye's; keyIsSun:
 *   whether the key light is the Sun (the guard is for the Sun only); cityFactor: the lights-out slider
 * @returns {{ keyLux: number, keyAltDeg: number, ambientLux: number, cityLux: number, emissionLux: number, cityLightLux: number,
 *   lampLux: number, groundLux: number, floorLux: number }} lampLux after the glass and the slider
 */
export function flightPriorTerms(terms, { lampLux = 0, heightAboveGroundM = Infinity, keyIsSun = true, cityFactor = 1, glass = GLASS_TRANSMISSION,
  floorLux = ADAPT_FLOOR_LUX, litSin = LIT_TERRAIN_SIN, guardDeg = GUARD_DEG, guardFadeDeg = GUARD_FADE_DEG, groundShare = GROUND_SHARE,
  groundFadeM = GROUND_FADE_M } = {}) {
  let keyAltDeg = terms.keyAltDeg;
  if (keyIsSun && terms.keyLux > 0) {
    const below = Math.min(1, Math.max(0, (keyAltDeg + guardDeg) / guardDeg));
    const guard = litSin * below * (1 - smooth01(guardFadeDeg[0], guardFadeDeg[1], keyAltDeg));
    const s = Math.sin(keyAltDeg * DEG);
    if (guard > 0 && guard > s) keyAltDeg = Math.asin(guard) / DEG;
  }
  const raw = Math.max(0, lampLux || 0);
  const lamps = glass * raw * Math.max(0, cityFactor);
  const near = 1 - smooth01(0, groundFadeM, Math.max(0, heightAboveGroundM));
  const ground = groundShare * ((terms.cityLux || 0) + (terms.emissionLux || 0)) * near;
  // cityLightLux: plan 01's city light (an ambient light on everything drawn) becomes the lamps' light at the aircraft,
  // with plan 01's own near the ground (the look multiplies it by the lights-out slider itself). The last three are for
  // the probes (__skyline.look.current.priorTerms); photometry.js priorEv100 reads the first five.
  return { keyLux: terms.keyLux, keyAltDeg, ambientLux: terms.ambientLux, cityLux: lamps + ground + floorLux, emissionLux: 0,
    cityLightLux: raw + (terms.cityLux || 0) * near, lampLux: lamps, groundLux: ground, floorLux };
}
