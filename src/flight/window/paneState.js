// The pane's condition over a journey (plan 03, sections 7.5 and 7.7; F5.3): frost on the inner face of the outer pane,
// condensation between the panes, and water and mist on the outer face, as functions of journey time.
//
// Journey time drives all of it (7.5): it is the flight's, like position and attitude. The model is integrated once
// over the whole journey when the track loads (and again on rebuild(), when the weather changes), in whole-second
// steps, and at(t) interpolates between the two seconds around t. So the pane at any instant is the same whether the
// journey got there by playing, by scrubbing backwards or by a seek: nothing is accumulated frame by frame.
//
// The model (7.7's "two-line model", with what it leaves open filled in and marked ESTIMATED):
//   - The face's temperature relaxes (time constant PANE.tauS) toward an equilibrium between the cabin and the
//     outside recovery temperature T_r = T_s (1 + r (gamma - 1) / 2 M^2), r = 0.9, weighted by the thermal resistances
//     on either side: the outer pane and the outside boundary layer (whose coefficient grows with mass flux) against
//     two air gaps, the middle and inner panes and the cabin's own boundary layer.
//     Plan 7.7 writes the factor as 0.18 r M^2; 0.18 is already (gamma - 1) / 2 x r, so r is applied once here.
//   - Frost grows while the face is below the frost point of the cabin air that reaches the gap through the breather
//     hole (-6 C: 24 C at 12 % relative humidity), faster the colder, toward full cover; it sublimes between the frost
//     point and 0 C, and melts above 0 C into a film that clears in a minute or two.
//   - Condensation (fog) forms when the face is above 0 C but below the dew point of the gap's air, which rises as
//     the cabin takes in moister air low down; it evaporates once the face is warmer than that dew point. Melt water
//     joins it.
//   - Water on the outer face: rain wets the pane within seconds toward a level set by the rain rate; once the rain
//     stops it dries over a minute in flight and a few minutes standing still. Inside cloud the pane mists over.
//   - A recording that starts at cruise starts with the frost of the cold soak before it: the first second's
//     conditions held for PANE.soakS seconds, through the same equations.
//
// Honest limit (7.7): no published account of how cabin-window frost grows and retreats was found; the rates are
// estimates to be tuned against window-seat footage, and the About text says so.

import { standardAtmosphere } from '../env.js';

const GAMMA = 1.4, R_AIR = 287.05287, K0 = 273.15;

/** The model's constants. Sourced where the plan gives them; ESTIMATED otherwise. */
export const PANE = Object.freeze({
  /** Cabin air temperature, C (7.7, from surveys of airliner cabins [B12]). */
  cabinC: 24,
  /** Frost point of cabin air at 24 C and 12 % relative humidity, C (7.7). */
  frostPointC: -6,
  /** Time constant of the face's temperature, s (7.7: "about 3 minutes"). */
  tauS: 180,
  /** Recovery factor of the boundary layer on the skin (7.7). */
  recovery: 0.9,
  /** Thermal resistances, m^2 K / W. ESTIMATED: acrylic conducts 0.19 W/m K; the outer pane about 9.5 mm thick; each
   * air gap about 5 W/m^2 K across (natural convection and radiation); the cabin's side about 8 W/m^2 K. */
  outerPaneR: 0.05,
  innerR: 0.585,
  /** Outside film coefficient h = a + b (rho V)^0.8, W/m^2 K (ESTIMATED: forced convection on the skin, about 220 at
   * cruise and on approach, 12 standing still). */
  hStill: 12, hFlux: 6,
  /** Seconds of the cold soak before a recording that starts at cruise (ESTIMATED: an hour at cruise). */
  soakS: 3600,
  /** Frost growth: e-folding time toward full cover at full undercooling, s; full undercooling this far below the
   * frost point, C (ESTIMATED). */
  growS: 2400, growSpanC: 8,
  /** Sublimation between the frost point and 0 C: full cover gone in this many seconds at 0 C (ESTIMATED). */
  sublimeS: 600,
  /** Melting above 0 C: full cover gone in this many seconds per degree above 0 (ESTIMATED: "clears in a minute or two"). */
  meltS: 60,
  /** Share of the melted frost that stays as a film between the panes. */
  meltFilm: 0.6,
  /** Dew point of the gap's air, C: at cruise (cabin air, 12 %) and low down (ESTIMATED: the packs bring in outside
   * air and the cabin's humidity rises to 30 to 40 % near the ground), between these heights above sea level, m. */
  dewHighC: -7, dewLowC: 4, dewHighM: 6000, dewLowM: 1500,
  /** Condensation rates, per degree of undercooling or overheating per second (ESTIMATED). */
  condenseK: 1 / 900, evaporateK: 1 / 120,
  /** Rain: the level the pane wets to is rate / (rate + wetHalfMmH); approached with wetTauS; dried with dryTauS
   * standing still and dryFastTauS at speed (ESTIMATED). */
  wetHalfMmH: 2, wetTauS: 6, dryTauS: 300, dryFastTauS: 45,
  /** Mist inside cloud: forms with mistTauS, dries as the water does (ESTIMATED). */
  mistTauS: 8,
});

/** Recovery temperature, C, for a static temperature (C) and Mach number. */
export function recoveryTempC(tempC, mach, r = PANE.recovery) {
  const ts = tempC + K0;
  return ts * (1 + r * ((GAMMA - 1) / 2) * mach * mach) - K0;
}

/**
 * Where the inner face of the outer pane settles, C, for the air outside: { tempC, tas (m/s), densityKgM3 }.
 * The resistance network: outside film + outer pane on one side, PANE.innerR to the cabin on the other.
 */
export function faceEquilibriumC({ tempC, tas = 0, densityKgM3 = 1.2 }, cabinC = PANE.cabinC) {
  const a = Math.sqrt(GAMMA * R_AIR * (tempC + K0));
  const mach = Math.max(0, tas) / a;
  const tr = recoveryTempC(tempC, mach);
  const h = PANE.hStill + PANE.hFlux * Math.pow(Math.max(0, densityKgM3 * tas), 0.8);
  const rOut = 1 / h + PANE.outerPaneR;
  return tr + (cabinC - tr) * (rOut / (rOut + PANE.innerR));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const u = clamp01((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/** Dew point of the gap's air at a height above sea level, C. */
export function gapDewPointC(altMsl) {
  return PANE.dewLowC + (PANE.dewHighC - PANE.dewLowC) * smooth(PANE.dewLowM, PANE.dewHighM, altMsl);
}

/** Temperature (C) at a height from the header's atmosphere rows [alt m, temp C, ...]; the standard day without them. */
function headerTempC(rows, altM) {
  if (!Array.isArray(rows) || rows.length < 2) return standardAtmosphere(altM).tempC;
  if (altM <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (altM <= rows[i][0]) { const u = (altM - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]); return rows[i - 1][1] + (rows[i][1] - rows[i - 1][1]) * u; }
  }
  return rows[rows.length - 1][1];
}

/** The default air: the flight file's atmosphere (or the standard day), dry and clear. */
export function headerAir(track) {
  const rows = track.meta?.atmosphere;
  return (s) => ({ tempC: headerTempC(rows, s.altMsl), rainRateMmH: 0, inCloud: false });
}

/** One step of the model, dt seconds, with the air `a` and the aircraft `s`. Mutates and returns `p`. */
function step(p, s, a, dt) {
  const alt = s.altMsl ?? 0;
  const tas = Math.max(0, s.tas ?? 0);
  const rho = Number.isFinite(a.densityKgM3) ? a.densityKgM3 : standardAtmosphere(alt).densityKgM3;
  const teq = faceEquilibriumC({ tempC: a.tempC, tas, densityKgM3: rho });
  p.tFaceC += (teq - p.tFaceC) * (1 - Math.exp(-dt / PANE.tauS));
  const T = p.tFaceC;

  // frost
  let melted = 0;
  if (T < PANE.frostPointC) {
    const drive = clamp01((PANE.frostPointC - T) / PANE.growSpanC);
    p.frost += (1 - p.frost) * (1 - Math.exp((-dt * drive) / PANE.growS));
  } else if (T < 0) {
    const k = (T - PANE.frostPointC) / -PANE.frostPointC; // 0 at the frost point, 1 at 0 C
    p.frost = Math.max(0, p.frost - (dt * k) / PANE.sublimeS);
  } else {
    const before = p.frost;
    p.frost = Math.max(0, p.frost - (dt * Math.max(T, 0.25)) / PANE.meltS);
    melted = before - p.frost;
  }

  // condensation between the panes
  const dew = gapDewPointC(alt);
  if (T > 0 && T < dew) p.fog = Math.min(1, p.fog + dt * (dew - T) * PANE.condenseK);
  else if (T >= dew) p.fog = Math.max(0, p.fog - dt * (T - dew) * PANE.evaporateK);
  p.fog = Math.min(1, p.fog + melted * PANE.meltFilm);

  // water on the outer face
  const rain = Math.max(0, a.rainRateMmH || 0);
  const dryTau = PANE.dryTauS + (PANE.dryFastTauS - PANE.dryTauS) * smooth(0, 70, tas);
  if (rain > 0) {
    const level = rain / (rain + PANE.wetHalfMmH);
    p.wet += (level - p.wet) * (1 - Math.exp(-dt / PANE.wetTauS));
  } else p.wet *= Math.exp(-dt / dryTau);
  if (a.inCloud) p.mist += (1 - p.mist) * (1 - Math.exp(-dt / PANE.mistTauS));
  else p.mist *= Math.exp(-dt / dryTau);
  if (p.wet < 1e-4) p.wet = 0;
  if (p.mist < 1e-4) p.mist = 0;
  if (p.fog < 1e-6) p.fog = 0;
  if (p.frost < 1e-6) p.frost = 0;
  p.rainRateMmH = rain;
  p.inCloud = !!a.inCloud;
  return p;
}

const FIELDS = ['tFaceC', 'frost', 'fog', 'wet', 'mist', 'rainRateMmH'];

/**
 * The pane over a journey.
 * @param {{ durationS: number, sample(t: number, out?: object): object, meta?: object }} track
 * @param {{ airAt?: (state: object) => { tempC: number, rainRateMmH?: number, inCloud?: boolean, densityKgM3?: number },
 *   cabinC?: number }} [o]  airAt: the air at the aircraft (the session passes the environment's at(position));
 *   without it, the flight file's atmosphere, dry and clear
 * @returns {{ at(t: number, out?: object): { t: number, tFaceC: number, frost: number, fog: number, wet: number,
 *   mist: number, rainRateMmH: number, inCloud: boolean }, rebuild(airAt?: Function): void, durationS: number }}
 */
export function createPaneState(track, { airAt = null } = {}) {
  const N = Math.max(1, Math.ceil(track.durationS)) + 1;
  const cols = Object.fromEntries(FIELDS.map((f) => [f, new Float64Array(N)]));
  const cloud = new Uint8Array(N);
  let air = airAt ?? headerAir(track);

  function build() {
    const s = track.sample(0);
    const a0 = air({ ...s, t: 0 });
    const p = { tFaceC: faceEquilibriumC({ tempC: a0.tempC, tas: s.tas ?? 0, densityKgM3: a0.densityKgM3 ?? standardAtmosphere(s.altMsl ?? 0).densityKgM3 }),
      frost: 0, fog: 0, wet: 0, mist: 0, rainRateMmH: 0, inCloud: false };
    // the soak before the recording: its first second's conditions, dry (rain before the recording is not known)
    const dryA0 = { ...a0, rainRateMmH: 0, inCloud: false };
    for (let k = 0; k < PANE.soakS; k += 10) step(p, s, dryA0, 10);
    for (let i = 0; i < N; i++) {
      const t = Math.min(i, track.durationS);
      track.sample(t, s);
      s.t = t;
      if (i > 0) step(p, s, air(s), 1);
      else { p.rainRateMmH = Math.max(0, a0.rainRateMmH || 0); p.inCloud = !!a0.inCloud; }
      for (const f of FIELDS) cols[f][i] = p[f];
      cloud[i] = p.inCloud ? 1 : 0;
    }
  }
  build();

  return {
    durationS: track.durationS,
    at(t, out = {}) {
      const x = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), N - 1);
      const i = Math.min(Math.floor(x), N - 2 < 0 ? 0 : N - 2);
      const u = N > 1 ? x - i : 0;
      out.t = x;
      for (const f of FIELDS) { const c = cols[f]; out[f] = u === 0 ? c[i] : c[i] + (c[Math.min(i + 1, N - 1)] - c[i]) * u; }
      // rain and cloud are the second's own, not blended (a rain rate that is on or off)
      const k = u < 0.5 ? i : Math.min(i + 1, N - 1);
      out.rainRateMmH = cols.rainRateMmH[k];
      out.inCloud = cloud[k] === 1;
      return out;
    },
    /** Integrate again with other air (the weather changed, or a debug override). */
    rebuild(next) { if (next) air = next; build(); },
  };
}
