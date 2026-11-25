// The orbit (plan 03, sections 4.6 and 7.12; task F7.1): instead of a recorded arrival, the aircraft circles a point
// of the city on a generated path, and the passenger watches the Strip turn below the wing. Pure: no scene state, no
// DOM; the same parameters give the same track.
//
// The track has the members of a parsed flight (track.js parseTrack: sample, durationS, lengthM, events, meta, sAt,
// timeAtS, channel ...) so the session, the journey and the debug hooks read it as they read a recording, plus the
// orbit's own: its parameters, the phase angle, the lap time and the bank.
//
// Speed comes from the altitude (7.12: the FAA's maximum holding speeds, capped at the cruise Mach), true airspeed from
// the standard atmosphere. The aircraft flies a ground circle of radius r around the centre at constant height; with no
// wind the bank is atan(V^2 / (g r)) all the way round, and with a wind the ground speed and the bank vary, steepest
// downwind (the turn around a point of 7.12). Heading is the direction of the air velocity, bank the coordinated-turn
// bank for its turn rate, pitch the flight-path angle plus the angle of attack from lift (7.3's model, constants fitted
// to the reference attitudes as scripts/lib/attitude.py fits them). Configuration: clean, or flaps 1 below 210 KIAS.
//
// The path is built from segments, each a path in polar form about a centre that may move: P = C + rho u(theta), with
// the centre, the radius, the height, the airspeed and the wind each blended from their state at the segment's start
// to the new orbit's values at rest, and theta integrated so that the airspeed through the air is exactly the blended
// one. A steady circle is a segment with nothing to blend. The blends keep position, velocity and acceleration (hence
// heading and bank) continuous, so a change (radius, altitude, centre, side looked to, speed, wind) never jumps: the
// new track starts on the old one at that moment. Of two ways onto the new circle (about the centre circled now, or
// about the new one after following the old path until it heads that way) the quicker is taken; a reversal of
// direction is first an S-turn onto a circle through the aircraft that turns the other way. Every transition is the
// shortest found that keeps the bank, roll rate and climb rate inside ORBIT's limits.
//
// Units: metres, seconds, m/s. Positions are x east and n north of the city origin, h above sea level, as in the
// flight file; sample() places them in scene axes through the city frame as parseTrack does. Angles in the state are
// radians; parameters given in degrees say so in their names.
import { EARTH_R } from '../world/frame.js';
import { standardAtmosphere } from './env.js';
import { G, bodyQuaternion } from './kinematics.js';
import { createState, LIGHT } from './track.js';

const FT = 0.3048;
const KT = 1852 / 3600;
const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------------------------------- the numbers

/** Limits and defaults; where each comes from is in the comment beside it. */
export const ORBIT = Object.freeze({
  /** ft above sea level (4.6); the airport is at 2,183 ft. */
  altFt: Object.freeze({ min: 4500, max: 41000, marks: Object.freeze([5000, 10000, 18000, 35000]) }),
  /** m: the largest radius (4.6); the smallest follows from the bank limit at the altitude's speed. */
  radiusMaxM: 60000,
  /** deg: the bank limit, a normal autopilot limit (7.12). */
  bankMaxDeg: 25,
  /** The speed schedule (7.12, the FAA maximum holding speeds [N10]): KIAS up to each altitude in ft. */
  schedule: Object.freeze([[6000, 200], [14000, 230], [Infinity, 265]]),
  /** The cruise Mach that caps the schedule (7.3's cruise reference, M0.78 at 35,000 ft). */
  cruiseMach: 0.78,
  /** Flaps 1 below this indicated airspeed, clean above (7.12). */
  flapsBelowKt: 210,
  /** kg: the default weight (7.3). */
  weightKg: 62000,
  /** Laps of the steady circle in a track (ESTIMATED: the mode wraps the phase, so this only bounds durationS). */
  turns: 3,
  /** deg/s: the roll rate of the roll-in from straight flight (ESTIMATED; attitude.py limits roll rate to 5). */
  rollRateDegS: 3,
  /** ft/min: the steepest climb or descent of an altitude change (ESTIMATED, a gentle cabin-friendly rate). */
  climbFpm: 1500,
  /** deg: the steepest bank allowed during a change (ESTIMATED: the limit plus a small allowance for the swing of a transition). */
  changeBankDeg: 27,
  /** s: the shortest change (ESTIMATED). */
  changeMinS: 20,
  /** s: a change whose flown transition would take longer is made as a cut instead (the decision of 25 Nov 2026:
   * airliner rates make a preset jump take up to 46 minutes); presets always cut. */
  flownMaxS: 60,
});

/** Presets (4.6): altitudes from the plan; radii ESTIMATED (Overhead from 7.12's comfortable 10 deg at 35,000 ft is 31
 * km; The valley from the 4.10 link, 9 km at 12,000 ft; The Strip a 5 km circle, about 20 deg of bank). */
export const PRESETS = Object.freeze({
  overhead: Object.freeze({ label: 'Overhead', altFt: 35000, radiusKm: 31 }),
  valley: Object.freeze({ label: 'The valley', altFt: 12000, radiusKm: 9 }),
  strip: Object.freeze({ label: 'The Strip', altFt: 6500, radiusKm: 5 }),
});

// ---------------------------------------------------------------------------------------------------- air data

const P0 = 101325, A0 = Math.sqrt(1.4 * 287.05287 * 288.15);

/** True airspeed (m/s) for a calibrated airspeed (m/s) at a height (m), standard atmosphere (attitude.py's formula). */
export function tasFromCas(cas, altM) {
  const air = standardAtmosphere(altM);
  const qc = P0 * ((1 + 0.2 * (cas / A0) ** 2) ** 3.5 - 1);
  const mach = Math.sqrt(5 * ((qc / (air.pressureHPa * 100) + 1) ** (2 / 7) - 1));
  return mach * air.soundMs;
}

/** Calibrated airspeed (m/s) for a true airspeed (m/s) at a height (m), standard atmosphere. */
export function casFromTas(tas, altM) {
  const air = standardAtmosphere(altM);
  const mach = tas / air.soundMs;
  const qc = air.pressureHPa * 100 * ((1 + 0.2 * mach * mach) ** 3.5 - 1);
  return A0 * Math.sqrt(5 * ((qc / P0 + 1) ** (2 / 7) - 1));
}

/**
 * The orbit's speed at a height (7.12): indicated from the schedule, true from the standard atmosphere, capped at the
 * cruise Mach. `iasKt` overrides the schedule (still capped).
 * @returns {{ iasKt: number, ias: number, tas: number, mach: number }}
 */
export function orbitSpeed(altM, iasKt) {
  const ft = altM / FT;
  const want = Number.isFinite(iasKt) ? iasKt : ORBIT.schedule.find(([top]) => ft <= top)[1];
  const air = standardAtmosphere(altM);
  let tas = tasFromCas(want * KT, altM);
  let ias = want * KT;
  if (tas / air.soundMs > ORBIT.cruiseMach) {
    tas = ORBIT.cruiseMach * air.soundMs;
    ias = casFromTas(tas, altM);
  }
  return { iasKt: ias / KT, ias, tas, mach: tas / air.soundMs };
}

/** The smallest radius (m) the bank limit allows at a height, with the wind's speed (m/s) added downwind. */
export function minRadiusM(altM, windMs = 0, iasKt) {
  const v = orbitSpeed(altM, iasKt).tas + Math.abs(windMs);
  return (v * v) / (G * Math.tan(ORBIT.bankMaxDeg * DEG));
}

// ---------------------------------------------------------------------------------------------------- the lift model

/** m^2: the wing's reference area (spec.py WING["area"], attitude.py WING_AREA). */
const WING_AREA = 124.58;
/** Lever position -> main-flap surface angle in degrees (attitude.py _DETENT_ANGLE, spec.py FLAPS, ESTIMATED there). */
const DETENT_ANGLE = [[0, 0], [1, 1], [2, 2], [5, 5], [10, 8], [15, 11], [25, 17], [30, 20], [40, 25]];
const lerpRows = (rows, x) => {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) if (x <= rows[i][0]) return rows[i - 1][1] + ((rows[i][1] - rows[i - 1][1]) * (x - rows[i - 1][0])) / (rows[i][0] - rows[i - 1][0]);
  return rows[rows.length - 1][1];
};

/** Lift coefficient for weight W (kg) at load factor n, true airspeed (m/s), height (m) and air path angle (rad). */
const liftCoefficient = (weightKg, n, tas, altM, gamma = 0) =>
  (n * weightKg * G * Math.cos(gamma)) / (0.5 * standardAtmosphere(altM).densityKgM3 * tas * tas * WING_AREA);

/**
 * The lift model's constants, fitted at load from 7.3's reference attitudes at 60 t exactly as attitude.py fit_lift
 * does: the slope from the two clean references, each flap setting's alpha0 from its own reference. The orbit uses
 * clean and flaps 1 (between clean and flaps 5 by the surface angle, as the bake interpolates).
 */
export const LIFT = (() => {
  const W = 60000, V40 = 135;
  const refs = [
    { flap: 0, cl: liftCoefficient(W, 1, 0.78 * standardAtmosphere(35000 * FT).soundMs, 35000 * FT), pitch: 2.5 },
    { flap: 0, cl: liftCoefficient(W, 1, tasFromCas((V40 + 70) * KT, 5000 * FT), 5000 * FT), pitch: 5.0 },
    { flap: 5, cl: liftCoefficient(W, 1, tasFromCas((V40 + 30) * KT, 4000 * FT), 4000 * FT), pitch: 6.0 },
  ];
  const clAlpha = (refs[1].cl - refs[0].cl) / (refs[1].pitch - refs[0].pitch);
  const a0 = { 0: refs[0].pitch - refs[0].cl / clAlpha, 5: refs[2].pitch - refs[2].cl / clAlpha };
  const s5 = lerpRows(DETENT_ANGLE, 5);
  const alpha0 = (flap) => a0[0] + ((a0[5] - a0[0]) * Math.min(1, Math.max(0, lerpRows(DETENT_ANGLE, flap) / s5)));
  return Object.freeze({ clAlpha, alpha0 });
})();

/**
 * Pitch attitude (deg, nose up positive): the air path angle plus the angle of attack from lift (7.3).
 * @param {{ tas: number, altM: number, flap?: number, n?: number, gamma?: number, weightKg?: number }} o
 *   gamma is the air path angle in radians; n the load factor (1 / cos(bank) in a level turn)
 */
export function pitchDeg({ tas, altM, flap = 0, n = 1, gamma = 0, weightKg = ORBIT.weightKg }) {
  const cl = liftCoefficient(weightKg, n, Math.max(tas, 1), altM, gamma);
  return gamma / DEG + LIFT.alpha0(flap) + cl / LIFT.clAlpha;
}

// ---------------------------------------------------------------------------------------------------- parameters

/** The city origin (Las Vegas Boulevard at Flamingo Road, on the Strip). The mode passes stripCentre(towers) instead. */
export const DEFAULT_CENTER = Object.freeze({ x: 0, n: 0 });
/** m: how far from the city origin a centre may be (ESTIMATED: inside the valley grid, x -60..70 km, y -64..50 km). */
const CENTER_MAX_M = 50000;
/** The default orbit: The valley preset (ESTIMATED: the plan names no default; the 4.10 link flies this one). */
const DEFAULTS = { altFt: PRESETS.valley.altFt, radiusKm: PRESETS.valley.radiusKm, phaseDeg: 0 };

/** The middle of a set of towers ({ x, n } each, as data/flights/lv/strip.json has them): the Strip's centre. */
export function stripCentre(towers) {
  if (!towers?.length) return { ...DEFAULT_CENTER };
  let x = 0, n = 0;
  for (const t of towers) { x += t.x; n += t.n; }
  return { x: x / towers.length, n: n / towers.length };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const finite = (v, d) => (Number.isFinite(v) ? v : d);
const mod = (a, m) => ((a % m) + m) % m;

/** 'left' or 'right' from a seat id ('22F') or a side. */
function sideOf(seat, seatSide) {
  if (seatSide === 'left' || seatSide === 'right') return seatSide;
  const m = /^\s*\d{1,2}\s*([A-Fa-f])\s*$/.exec(String(seat ?? ''));
  if (m) return 'ABCabc'.includes(m[1]) ? 'left' : 'right';
  return 'right';
}

/**
 * The orbit's parameters, completed and held inside the limits. The direction follows the seat (7.12: clockwise for a
 * right-hand seat, so it looks into the turn; anticlockwise for a left-hand one), reversed by `outward`; an explicit
 * `direction` wins. The radius is held between the bank limit's smallest at this altitude, speed and wind, and 60 km.
 * @param {object} o
 * @param {{ x: number, n: number }} [o.center] metres east and north of the city origin
 * @param {number} [o.altFt] ft above sea level, 4,500 to 41,000
 * @param {number} [o.radiusKm]
 * @param {number} [o.phaseDeg] the bearing from the centre to the aircraft where the circle starts, clockwise from north
 * @param {string} [o.seat] '22F'; or o.seatSide 'left' | 'right'
 * @param {boolean} [o.outward] look out of the circle (at the mountains) instead of into it
 * @param {'cw'|'ccw'} [o.direction]
 * @param {number|null} [o.iasKt] an indicated airspeed instead of the schedule's, held to 150..340 kt (ESTIMATED: the
 *   type's clean manoeuvring speed to its VMO), still capped at the cruise Mach
 * @param {{ east: number, north: number }} [o.wind] m/s toward grid east and north, one wind for the whole orbit
 * @param {boolean} [o.rollIn] begin on a straight line tangent to the circle and roll into the turn (default true)
 * @param {number} [o.turns] laps of the steady circle in the track
 * @param {number} [o.sunAltDeg] the Sun's height for the lights and cabin light (default 30, day); see applySun
 * @param {number} [o.startMs] the simulation time at t = 0 (the track's recordedStartMs)
 * @param {number} [o.weightKg]
 */
export function orbitParams(o = {}) {
  const altFt = clamp(finite(o.altFt, DEFAULTS.altFt), ORBIT.altFt.min, ORBIT.altFt.max);
  const altM = altFt * FT;
  const wind = { east: finite(o.wind?.east, 0), north: finite(o.wind?.north, 0) };
  const iasKt = Number.isFinite(o.iasKt) ? clamp(o.iasKt, 150, 340) : null;
  const speed = orbitSpeed(altM, iasKt ?? undefined);
  const minR = minRadiusM(altM, Math.hypot(wind.east, wind.north), iasKt ?? undefined);
  const radiusM = clamp(finite(o.radiusKm, DEFAULTS.radiusKm) * 1000, Math.min(minR, ORBIT.radiusMaxM), ORBIT.radiusMaxM);
  const c = o.center ?? DEFAULT_CENTER;
  const center = { x: clamp(finite(c.x, 0), -CENTER_MAX_M, CENTER_MAX_M), n: clamp(finite(c.n, 0), -CENTER_MAX_M, CENTER_MAX_M) };
  const seatSide = sideOf(o.seat, o.seatSide);
  const outward = !!o.outward;
  const directionSet = o.direction === 'cw' || o.direction === 'ccw';
  const direction = directionSet ? o.direction : (seatSide === 'right') !== outward ? 'cw' : 'ccw';
  return {
    center, altFt, radiusKm: radiusM / 1000, phaseDeg: mod(finite(o.phaseDeg, DEFAULTS.phaseDeg), 360),
    seat: o.seat ?? null, seatSide, outward, direction, directionSet, iasKt, wind,
    rollIn: o.rollIn !== false, turns: Math.max(1, Math.round(finite(o.turns, ORBIT.turns))),
    city: typeof o.city === 'string' ? o.city : 'lv', sunAltDeg: finite(o.sunAltDeg, 30), startMs: finite(o.startMs, Date.UTC(2026, 10, 14, 1, 0, 0)),
    weightKg: finite(o.weightKg, ORBIT.weightKg),
    // derived, for the panel
    minRadiusKm: minR / 1000, iasKtFlown: speed.iasKt, tasKt: speed.tas / KT, mach: speed.mach,
  };
}

// ---------------------------------------------------------------------------------------------------- quintic blends

/**
 * A blend from value p0, rate v0 and acceleration a0 at 0 to p1 at rest at T, held at p1 after T (and for T = 0).
 * The move from p0 to p1 is a quintic smoothstep over T; the starting rate and acceleration are worked off over the
 * first `lead` seconds (lead <= T) by the quintic Hermite terms that carry them, which end with zero value, rate and
 * acceleration. With lead = T this is the plain quintic Hermite; a shorter lead keeps a long transition from carrying
 * the old turn's acceleration (a0 T^2) far from where it started. Returns [value, rate, acceleration] at tau.
 */
function quintic(p0, v0, a0, p1, T, lead = T) {
  if (!(T > 0)) return (tau, out = [0, 0, 0]) => { out[0] = p1; out[1] = 0; out[2] = 0; return out; };
  const L = Math.min(Math.max(lead, 1e-6), T), dv = L * v0, da = L * L * a0, dp = p1 - p0;
  return (tau, out = [0, 0, 0]) => {
    if (tau >= T) { out[0] = p1; out[1] = 0; out[2] = 0; return out; }
    const u = Math.max(0, tau / T), u2 = u * u;
    // the move: 10u^3 - 15u^4 + 6u^5
    out[0] = p0 + dp * u2 * u * (10 - 15 * u + 6 * u2);
    out[1] = (dp * 30 * u2 * (1 - 2 * u + u2)) / T;
    out[2] = (dp * 60 * u * (1 - 3 * u + 2 * u2)) / (T * T);
    if (tau < L && (v0 !== 0 || a0 !== 0)) {
      const w = tau / L, w2 = w * w, w3 = w2 * w, w4 = w3 * w, w5 = w4 * w;
      out[0] += dv * (w - 6 * w3 + 8 * w4 - 3 * w5) + da * (w2 - 3 * w3 + 3 * w4 - w5) / 2;
      out[1] += (dv * (1 - 18 * w2 + 32 * w3 - 15 * w4) + (da * (2 * w - 9 * w2 + 12 * w3 - 5 * w4)) / 2) / L;
      out[2] += (dv * (-36 * w + 96 * w2 - 60 * w3) + (da * (2 - 18 * w + 36 * w2 - 20 * w3)) / 2) / (L * L);
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------------- one segment

// A segment is a path in polar form about a centre that may move: P = C + rho u(theta), u = (sin theta, cos theta) in
// (east, north), with C, rho, the height h, the horizontal airspeed V and the wind w each a quintic blend from the
// state at the segment's start to the new orbit's values at rest. theta is not blended: its rate is whatever keeps the
// airspeed exactly V, |P' - w| = V, on the branch that turns in the segment's direction, and it is integrated (RK4,
// half-second steps) into a table that sample() interpolates with the exact rates. A steady circle is a segment with
// nothing to blend; its table covers one lap and repeats.

const CH = ['cx', 'cn', 'rho', 'h', 'V', 'we', 'wn'];
const STEP_S = 0.5;
/** s: the coarser step of the trial transitions the search throws away. */
const TRIAL_STEP_S = 2;

/** The blended channels at tau, as [value, rate, acceleration] each. */
function channelsAt(seg, tau, k) {
  for (const c of CH) seg.curve[c](tau, k[c]);
  return k;
}
const newK = () => Object.fromEntries(CH.map((c) => [c, [0, 0, 0]]));

/**
 * The rate of theta at (tau, theta): rho theta' = -k_t + dir sqrt(V^2 - k_r^2), k = C' + rho' u - w. NaN when no
 * direction of flight at airspeed V gives this motion (the centre or radius moving too fast).
 */
function thetaRate(seg, tau, theta, k) {
  channelsAt(seg, tau, k);
  const su = Math.sin(theta), cu = Math.cos(theta);
  const ke = k.cx[1] + k.rho[1] * su - k.we[0], kn = k.cn[1] + k.rho[1] * cu - k.wn[0];
  const kr = ke * su + kn * cu, kt = ke * cu - kn * su;
  const V = k.V[0], disc = V * V - kr * kr;
  if (!(disc > 0)) return NaN;
  return (-kt + seg.dir * Math.sqrt(disc)) / k.rho[0];
}

/** The full kinematic state of a segment at tau with this theta (horizontal vectors as [east, north]). */
function kinematics(seg, tau, theta, k, out) {
  const w = thetaRate(seg, tau, theta, k); // fills k
  const su = Math.sin(theta), cu = Math.cos(theta);
  const rho = k.rho[0], r1 = k.rho[1], r2 = k.rho[2];
  // ground velocity
  const ve = k.cx[1] + r1 * su + rho * w * cu, vn = k.cn[1] + r1 * cu - rho * w * su;
  const ae = ve - k.we[0], an = vn - k.wn[0]; // air velocity, |a| = V
  // theta'' from the constraint a . (P'' - w') = V V'
  const Re = k.cx[2] + r2 * su + 2 * r1 * w * cu - rho * w * w * su - k.we[1];
  const Rn = k.cn[2] + r2 * cu - 2 * r1 * w * su - rho * w * w * cu - k.wn[1];
  const aPerp = ae * cu - an * su; // a . u_perp
  const V = k.V[0];
  const w2 = (V * k.V[1] - (ae * Re + an * Rn)) / (rho * aPerp);
  const Ae = Re + rho * w2 * cu, An = Rn - rho * w2 * su; // air acceleration
  out.theta = theta; out.thetaRate = w;
  out.x = k.cx[0] + rho * su; out.n = k.cn[0] + rho * cu;
  out.ve = ve; out.vn = vn; out.ae = ae; out.an = an; out.Ae = Ae; out.An = An;
  out.Pe2 = Ae + k.we[1]; out.Pn2 = An + k.wn[1];
  out.h = k.h[0]; out.vh = k.h[1]; out.ah = k.h[2];
  out.V = V; out.V1 = k.V[1]; out.V2 = k.V[2];
  out.cx = k.cx; out.cn = k.cn; out.rho = k.rho; out.we = k.we; out.wn = k.wn; out.hk = k.h; out.Vk = k.V;
  const turn = V > 0 ? (an * Ae - ae * An) / (V * V) : 0; // air heading rate, clockwise positive
  out.psi = mod(Math.atan2(ae, an), TAU);
  out.psiRate = turn;
  out.bank = Math.atan2(V * turn, G + out.ah);
  out.load = Math.hypot(V * turn, G + out.ah) / G;
  out.gamma = Math.atan2(out.vh, V);
  return out;
}

/** RK4 for theta and s together over [0, T] in n steps; tables of theta, theta', s and s'. */
function integrate(seg, theta0, T, n, k) {
  const dt = T / n;
  const th = new Float64Array(n + 1), om = new Float64Array(n + 1), s = new Float64Array(n + 1), sp = new Float64Array(n + 1);
  const kin = {};
  const f = (tau, theta) => thetaRate(seg, tau, theta, k);
  const speed = (tau, theta) => { kinematics(seg, tau, theta, k, kin); return Math.hypot(kin.ve, kin.vn); };
  th[0] = theta0; om[0] = f(0, theta0); sp[0] = speed(0, theta0);
  for (let i = 0; i < n; i++) {
    const t = i * dt, y = th[i];
    const k1 = om[i], k2 = f(t + dt / 2, y + (dt / 2) * k1), k3 = f(t + dt / 2, y + (dt / 2) * k2), k4 = f(t + dt, y + dt * k3);
    th[i + 1] = y + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    om[i + 1] = f(t + dt, th[i + 1]);
    const s1 = sp[i], s2 = speed(t + dt / 2, y + (dt / 2) * k1), s3 = speed(t + dt / 2, y + (dt / 2) * k2);
    sp[i + 1] = speed(t + dt, th[i + 1]);
    s[i + 1] = s[i] + (dt / 6) * (s1 + 2 * s2 + 2 * s3 + sp[i + 1]);
    if (!Number.isFinite(th[i + 1])) return null;
  }
  return { dt, n, th, om, s, sp };
}

/** Cubic Hermite of a tabled quantity with its exact rates. */
function hermite(v, d, dt, i, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v[i] + (u3 - 2 * u2 + u) * dt * d[i] + (-2 * u3 + 3 * u2) * v[i + 1] + (u3 - u2) * dt * d[i + 1];
}

/**
 * A segment from a start state to an end state over T seconds (T = 0: a steady circle).
 * @param {object} start [value, rate, acceleration] for each channel, theta0, and dir (+1 clockwise, -1 anticlockwise)
 * @param {object} end the end values: cx cn rho h V we wn
 * @param {object} [leads] seconds over which each channel's starting rate and acceleration are worked off (all: default)
 */
function makeSegment(start, end, T, dir, leads = {}, step = STEP_S) {
  const seg = { T, dir, curve: {}, end };
  for (const c of CH) seg.curve[c] = quintic(start[c][0], start[c][1], start[c][2], end[c], T, leads[c] ?? T);
  const k = newK();
  if (T > 0) {
    seg.table = integrate(seg, start.theta, T, Math.max(4, Math.ceil(T / step)), k);
    if (!seg.table) return null;
    seg.durationS = T;
  } else {
    // one lap: find its time with a first pass, then table it so that the last node falls on the lap exactly
    const w0 = thetaRate(seg, 0, start.theta, k);
    if (!Number.isFinite(w0) || dir * w0 <= 0) return null;
    let guess = TAU / Math.abs(w0);
    for (let pass = 0; pass < 3; pass++) {
      const n = Math.max(16, Math.ceil(guess / STEP_S));
      const tab = integrate(seg, start.theta, guess, n, k);
      const turned = dir * (tab.th[n] - start.theta);
      seg.table = tab;
      if (Math.abs(turned - TAU) < 1e-12) break;
      guess -= (turned - TAU) / Math.abs(tab.om[n]);
    }
    seg.lapS = seg.table.dt * seg.table.n;
    seg.lapM = seg.table.s[seg.table.n];
    seg.periodic = true;
  }
  seg.theta0 = start.theta;
  return seg;
}

/** theta and s of a segment at tau (laps repeated for a steady circle). */
function locateIn(seg, tau) {
  const tab = seg.table;
  let lap = 0, tl = Math.max(0, tau);
  if (seg.periodic) { lap = Math.floor(tl / seg.lapS); tl -= lap * seg.lapS; }
  else tl = Math.min(tl, seg.T);
  const i = Math.min(tab.n - 1, Math.floor(tl / tab.dt)), u = (tl - i * tab.dt) / tab.dt;
  return {
    theta: hermite(tab.th, tab.om, tab.dt, i, u) + (seg.periodic ? seg.dir * TAU * lap : 0),
    s: hermite(tab.s, tab.sp, tab.dt, i, u) + (seg.periodic ? seg.lapM * lap : 0),
  };
}

/** The state at the start of a segment about centre C (moving with C', C'') from a kinematic state. */
function polarAbout(kin, C, dir) {
  const qe = kin.x - C.cx[0], qn = kin.n - C.cn[0];
  const rho = Math.hypot(qe, qn), su = qe / rho, cu = qn / rho;
  const q1e = kin.ve - C.cx[1], q1n = kin.vn - C.cn[1];
  const q2e = kin.Pe2 - C.cx[2], q2n = kin.Pn2 - C.cn[2];
  const r1 = q1e * su + q1n * cu, rw = q1e * cu - q1n * su; // rho', rho theta'
  const r2 = q2e * su + q2n * cu + (rw * rw) / rho;
  return {
    cx: [...C.cx], cn: [...C.cn], rho: [rho, r1, r2], h: [...kin.hk], V: [...kin.Vk], we: [...kin.we], wn: [...kin.wn],
    theta: Math.atan2(su, cu), dir, rhoThetaRate: rw,
  };
}

/** True when a start state moves about its centre in the sense of dir (the branch thetaRate takes). */
function consistent(start, dir) {
  const held = (c) => (tau, o) => { o[0] = start[c][0]; o[1] = start[c][1]; o[2] = start[c][2]; return o; };
  const seg = { dir, curve: Object.fromEntries(CH.map((c) => [c, held(c)])) };
  const w = thetaRate(seg, 0, start.theta, newK());
  return Number.isFinite(w) && Math.abs(w * start.rho[0] - start.rhoThetaRate) < 1e-6 * Math.max(1, start.V[0]);
}

// ---------------------------------------------------------------------------------------------------- transitions

const QUINTIC_PEAK = 1.875; // the largest rate of a quintic blend, in units of (change / T)
/**
 * The acceleration (m/s^2) each channel's lead-in may use to work off its starting rate (ESTIMATED): the Hermite rate
 * term peaks at about 5.8 v0 / lead. Sideways, 2 m/s^2 is about 12 degrees of extra bank; along the path and
 * vertically, a gentle 0.5.
 */
const BUDGET = { cx: 2, cn: 2, rho: 2, we: 2, wn: 2, h: 0.5, V: 0.5 };
/** Seconds of lead-in per channel to work off its starting rate, at least `least`. */
function leadsFor(st, least) {
  const out = {};
  for (const c of CH) out[c] = Math.max(least, (5.8 * Math.abs(st[c][1])) / BUDGET[c]);
  return out;
}

/** True when a transition keeps to the limits: bank, roll rate and climb rate. */
function withinLimits(seg) {
  const k = newK(), kin = {}, tab = seg.table;
  let prev = null;
  for (let i = 0; i <= tab.n; i++) {
    kinematics(seg, i * tab.dt, tab.th[i], k, kin);
    if (!Number.isFinite(kin.bank)) return false;
    if (Math.abs(kin.bank) > ORBIT.changeBankDeg * DEG) return false;
    if (Math.abs(kin.vh) > (ORBIT.climbFpm * FT) / 60 * 1.02) return false;
    if (prev !== null && Math.abs(kin.bank - prev) / tab.dt > ORBIT.rollRateDegS * DEG * 1.02) return false;
    prev = kin.bank;
  }
  return true;
}

/**
 * The shortest transition (by steps of 25%) from startFor(T) to `end` that keeps to the limits.
 * @param {(T: number) => object} startFor the start state for a transition of T seconds
 */
function transition(startFor, end, dir, bankFrom, bankTo) {
  const s0 = startFor(ORBIT.changeMinS);
  const dh = Math.abs(end.h - s0.h[0]), dr = Math.abs(end.rho - s0.rho[0]), dc = Math.hypot(end.cx - s0.cx[0], end.cn - s0.cn[0]);
  const V = Math.min(end.V, s0.V[0]);
  let T = Math.max(ORBIT.changeMinS,
    (QUINTIC_PEAK * dh) / ((ORBIT.climbFpm * FT) / 60),
    (QUINTIC_PEAK * (dr + dc)) / (0.6 * V),
    (QUINTIC_PEAK * Math.abs(bankTo - bankFrom)) / (ORBIT.rollRateDegS * DEG));
  // the lead-ins: each channel works off its starting rate no faster than its acceleration budget allows; how fast
  // its starting acceleration can be worked off depends on the geometry, so 1, 2, 4 and 8 roll times are tried and
  // the limits decide
  const least = Math.max(ORBIT.changeMinS, (QUINTIC_PEAK * Math.abs(bankTo - bankFrom)) / (ORBIT.rollRateDegS * DEG));
  const vLeads = leadsFor(startFor(T), least);
  T = Math.max(T, ...Object.values(vLeads));
  let best = null;
  for (let attempt = 0; attempt < 16; attempt++, T *= 1.25) {
    const st = startFor(T);
    for (const scale of [1, 2, 4, 8]) {
      const leads = Object.fromEntries(CH.map((c) => [c, Math.min(T, Math.max(vLeads[c], st[c][2] !== 0 ? least * scale : 0))]));
      const trial = makeSegment(st, end, T, dir, leads, TRIAL_STEP_S);
      if (!trial || (!withinLimits(trial) && best)) continue;
      const seg = makeSegment(st, end, T, dir, leads);
      if (!seg) continue;
      best = seg;
      if (withinLimits(seg)) return seg;
    }
  }
  if (!best) throw new Error('orbit: no transition reaches the new circle');
  best.overLimit = true;
  return best;
}

/** The new orbit's values at rest. */
const endOf = (p) => ({ cx: p.center.x, cn: p.center.n, rho: p.radiusKm * 1000, h: p.altFt * FT, V: orbitSpeed(p.altFt * FT, p.iasKt ?? undefined).tas, we: p.wind.east, wn: p.wind.north });
/** A state at rest on the new orbit at theta. */
const restOn = (end, theta, dir) => ({ ...Object.fromEntries(CH.map((c) => [c, [end[c], 0, 0]])), theta, dir });
const dirOf = (p) => (p.direction === 'cw' ? 1 : -1);

// ---------------------------------------------------------------------------------------------------- lights

/** The light bits in flight at a height (7.8, as config_schedule.py sets them): position, beacon and strobes always;
 * landing lights below 10,000 ft; wing and logo lights at night (the Sun below the horizon) below 10,000 ft. */
export function lightsAt(altM, sunAltDeg) {
  let bits = LIGHT.NAV | LIGHT.BEACON | LIGHT.STROBE;
  if (altM < 10000 * FT) {
    bits |= LIGHT.LANDING;
    if (sunAltDeg < 0) bits |= LIGHT.WING | LIGHT.LOGO;
  }
  return bits;
}
/** The cabin light (7.3): dimmed to 0.3 below 10,000 ft when the Sun is more than 6 degrees down, otherwise 1. */
export const cabinLightAt = (altM, sunAltDeg) => (altM < 10000 * FT && sunAltDeg < -6 ? 0.3 : 1);
/** Flaps 1 below 210 KIAS, clean above (7.12), moving over 4 kt around it so the channel never steps. */
const flapAt = (iasKt) => clamp((ORBIT.flapsBelowKt + 2 - iasKt) / 4, 0, 1);

/**
 * Set a sampled state's lights and cabin light for the Sun's height now. The orbit is not tied to the clock (7.12):
 * scrubbing the hour changes the light, not the track, so the session calls this each frame with the Sun it draws.
 * @param {import('./types.d.ts').AircraftState} state  @param {number} sunAltDeg
 */
export function applySun(state, sunAltDeg) {
  state.lights = lightsAt(state.altMsl, sunAltDeg);
  state.cabinLight = cabinLightAt(state.altMsl, sunAltDeg);
  return state;
}

// ---------------------------------------------------------------------------------------------------- the track

/** The channels a recorded flight carries (section 6.2), all of which the orbit fills. */
export const CHANNELS = Object.freeze(['x', 'n', 'h', 's', 'gs', 'vs', 'tas', 'ias', 'hdg', 'pitch', 'roll',
  'flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'lights', 'cabinLight', 'turbulence']);
const ORBIT_FORMAT = 'skyline-orbit/1';
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const isoTime = (ms) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/**
 * A track from its segments: the transitions in order, then the steady circle for `turns` laps.
 * @param {{ seg: object }[]} parts  @param {object} p the orbit's parameters  @param {object} frame
 */
function assemble(parts, p, frame) {
  let t = 0, s = 0;
  for (const part of parts) {
    part.t0 = t; part.s0 = s;
    const { seg } = part;
    if (part.follow) {
      // the old track flown on unchanged until the aircraft leaves it (changeOrbit's wait)
      part.sFrom = part.follow.kinAt(part.from, {}).s;
      part.lengthM = part.follow.kinAt(part.from + part.lengthS, {}).s - part.sFrom;
    } else if (seg.periodic) { part.lengthS = seg.lapS * p.turns; part.lengthM = seg.lapM * p.turns; }
    else { part.lengthS = seg.T; part.lengthM = seg.table.s[seg.table.n]; }
    t += part.lengthS; s += part.lengthM;
  }
  const steady = parts[parts.length - 1];
  const durationS = t, lengthM = s, joinT = steady.t0, lapS = steady.seg.lapS;
  const k = newK(), kin = {};

  /** The segment and local time at track time t (not clamped: past the end the circle goes on). */
  const partAt = (tq) => {
    for (let i = parts.length - 1; i > 0; i--) if (tq >= parts[i].t0) return parts[i];
    return parts[0];
  };
  const kinAt = (tq, out = {}) => {
    const part = partAt(tq), tau = tq - part.t0;
    if (part.follow) {
      part.follow.kinAt(part.from + tau, out);
      out.s = part.s0 + out.s - part.sFrom;
    } else {
      const loc = locateIn(part.seg, tau);
      kinematics(part.seg, tau, loc.theta, k, out);
      out.s = part.s0 + loc.s;
    }
    return out;
  };
  const clampT = (tq) => (Number.isFinite(tq) ? Math.min(Math.max(tq, 0), durationS) : 0);
  const sAt = (tq) => {
    const tc = clampT(tq), part = partAt(tc);
    return part.follow ? kinAt(tc, {}).s : part.s0 + locateIn(part.seg, tc - part.t0).s;
  };

  const events = [
    ...(joinT > 0 ? [{ t: 0, id: p.rollIn ? 'rollIn' : 'change', label: p.rollIn ? 'Rolling into the turn' : 'Changing the orbit' }] : []),
    { t: joinT, id: 'join', label: 'On the circle' },
    ...Array.from({ length: p.turns - 1 }, (_, i) => ({ t: joinT + (i + 1) * lapS, id: `lap${i + 2}`, label: `Lap ${i + 2}` })),
  ].map((e) => ({ ...e, s: sAt(e.t) })).sort((a, b) => a.t - b.t);

  const dt = 1, samples = Math.floor(durationS / dt) + 1;
  const label = `Orbit, ${group.format(p.altFt)} ft, ${Math.round(p.radiusKm * 10) / 10} km`;
  const steadyBank = Math.abs(kinAt(joinT).bank);
  const cache = new Map();
  const meta = {
    format: ORBIT_FORMAT, kind: 'orbit', id: 'orbit', city: p.city, airport: '', runway: '', aircraftType: 'B738', label,
    recordedStart: isoTime(p.startMs), dt, samples, channels: [...CHANNELS],
    provenance: Object.fromEntries(CHANNELS.map((c) => [c, 'synthetic'])), reconstructed: [],
    events: events.map(({ t: et, s: es, id, label: l }) => ({ t: et, s: es, id, label: l })),
    atmosphere: [[p.altFt * FT, standardAtmosphere(p.altFt * FT).tempC, p.wind.east, p.wind.north]],
    badges: { light: p.sunAltDeg < -6 ? 'night' : p.sunAltDeg < 6 ? 'dusk' : 'day', weather: 'clear', from: '', stripSide: p.direction === 'cw' ? 'right' : 'left' },
    qa: {}, source: { archive: 'generated', licence: 'none: generated in the app (src/flight/orbit.js)' },
    orbit: p,
  };

  const track = {
    meta, dt, samples, durationS, lengthM, recordedStartMs: p.startMs, touchdownT: Infinity, events,
    /** The orbit's parameters (orbitParams), as flown. */
    orbit: p,
    /** Seconds from the start at which the steady circle begins, and the time of one lap of it. */
    joinT, lapS,
    /** deg: the bank on the steady circle (with a wind, its largest). */
    bankDeg: steadyBank / DEG,
    /** True when a transition could not be kept inside the limits (it is the gentlest found). */
    overLimit: parts.some((q) => q.seg?.overLimit),
    sAt,
    timeAtS(sq) {
      if (!(sq > 0)) return 0;
      if (sq >= lengthM) return durationS;
      let a = 0, b = durationS;
      for (let i = 0; i < 80 && b - a > 1e-9; i++) { const m = (a + b) / 2; if (sAt(m) < sq) a = m; else b = m; }
      return (a + b) / 2;
    },
    /** The raw values of one channel at the track's dt, as a file would store them (hdg in degrees, wrapped). */
    channel(name) {
      if (!CHANNELS.includes(name)) return null;
      if (!cache.has(name)) {
        const out = new Float32Array(samples), st = createState();
        const deg = { hdg: 'heading', pitch: 'pitch', roll: 'roll' }, file = { x: null, n: null, h: 'altMsl' };
        for (let i = 0; i < samples; i++) {
          track.sample(i * dt, st);
          out[i] = name === 'x' ? st.position.x : name === 'n' ? -st.position.z : name in deg ? st[deg[name]] / DEG : st[file[name] ?? name];
        }
        cache.set(name, out);
      }
      return cache.get(name);
    },
    /** deg in [0, 360): the bearing from the (current) centre to the aircraft at t. */
    phaseAt(tq) { return mod(kinAt(clampT(tq), kin).theta / DEG, 360); },
    /** The first time on the steady circle at which the phase is phaseDeg. */
    timeAtPhase(phaseDeg) {
      const seg = steady.seg, dir = seg.dir;
      const target = seg.theta0 + dir * mod(dir * (phaseDeg * DEG - seg.theta0), TAU);
      let a = 0, b = seg.lapS;
      for (let i = 0; i < 80 && b - a > 1e-9; i++) { const m = (a + b) / 2; if (dir * (locateIn(seg, m).theta - target) < 0) a = m; else b = m; }
      return joinT + (a + b) / 2;
    },
    /** A time past the end brought back onto the steady circle by whole laps (the mode's phase runs forever). */
    wrap(tq) { return tq <= durationS ? Math.max(0, tq) : joinT + mod(tq - joinT, lapS); },
    /** The load factor (g) at t. */
    loadFactorAt(tq) { return kinAt(clampT(tq), kin).load; },
    /** For changeOrbit: the full kinematic state at t, not clamped, and the city frame the track is placed in. */
    kinAt,
    frame,
    /**
     * The aircraft at `t` seconds from the start of the track, clamped to [0, durationS].
     * @param {number} tq @param {import('./types.d.ts').AircraftState} [out]
     */
    sample(tq, out = createState()) {
      const tc = clampT(tq);
      const q = kinAt(tc, kin);
      const { x, n, h } = q;
      out.t = tc;
      out.s = q.s;
      out.position.set(x, frame.sceneY(h, x, n), -n);
      out.velocity.set(q.ve, q.vh - (x * q.ve + n * q.vn) / EARTH_R, -q.vn);
      out.airVelocity.set(q.ae, out.velocity.y, -q.an);
      out.altMsl = h;
      out.heading = q.psi;
      out.roll = q.bank;
      out.gs = Math.hypot(q.ve, q.vn);
      out.vs = q.vh;
      out.tas = Math.hypot(q.V, q.vh);
      out.ias = casFromTas(out.tas, h);
      out.flap = flapAt(out.ias / KT);
      out.slat = Math.min(1, out.flap);
      out.pitch = pitchDeg({ tas: out.tas, altM: h, flap: out.flap, n: q.load, gamma: q.gamma, weightKg: p.weightKg }) * DEG;
      bodyQuaternion(out.position.x, out.position.z, out.heading, out.pitch, out.roll, out.quaternion);
      out.gear = 0; out.speedbrake = 0; out.groundSpoiler = 0; out.reverser = 0; out.turbulence = 0;
      out.lights = lightsAt(h, p.sunAltDeg);
      out.cabinLight = cabinLightAt(h, p.sunAltDeg);
      out.onGround = false;
      return out;
    },
  };
  return track;
}

/**
 * A generated orbit with the members of a parsed flight track (track.js parseTrack) and the orbit's own.
 * @param {Parameters<typeof orbitParams>[0]} o
 * @param {{ frame: { sceneY(h: number, x: number, y: number): number } }} opts the city frame (src/world/frame.js)
 */
export function createOrbitTrack(o = {}, { frame } = {}) {
  if (!frame || typeof frame.sceneY !== 'function') throw new Error('orbit: a city frame (createFrame) is needed to place it');
  const p = orbitParams(o);
  const end = endOf(p), dir = dirOf(p);
  let theta = p.phaseDeg * DEG;
  const parts = [];
  if (p.rollIn) {
    // a straight line tangent to the circle, rolled out of into the turn; the tangent point is moved until the
    // aircraft joins the circle at the phase asked for
    let seg = null;
    for (let pass = 0; pass < 4; pass++) {
      const onCircle = makeSegment(restOn(end, theta, dir), end, 0, dir);
      const kJ = {};
      kinematics(onCircle, 0, theta, newK(), kJ);
      const vg = Math.hypot(kJ.ve, kJ.vn), ue = kJ.ve / vg, un = kJ.vn / vg;
      const startFor = (T) => {
        const d = (vg * T) / 2;
        const line = { x: kJ.x - ue * d, n: kJ.n - un * d, ve: kJ.ve, vn: kJ.vn, Pe2: 0, Pn2: 0, hk: [end.h, 0, 0], Vk: [end.V, 0, 0], we: [end.we, 0, 0], wn: [end.wn, 0, 0] };
        return polarAbout(line, { cx: [end.cx, 0, 0], cn: [end.cn, 0, 0] }, dir);
      };
      seg = seg ? makeSegment(startFor(seg.T), end, seg.T, dir) : transition(startFor, end, dir, 0, kJ.bank);
      const joined = locateIn(seg, seg.T).theta;
      const miss = Math.atan2(Math.sin(joined - p.phaseDeg * DEG), Math.cos(joined - p.phaseDeg * DEG));
      if (Math.abs(miss) < 1e-9) break;
      theta -= miss;
    }
    parts.push({ seg });
    theta = locateIn(seg, seg.T).theta;
  }
  parts.push({ seg: makeSegment(restOn(end, theta, dir), end, 0, dir) });
  return assemble(parts, p, frame);
}

// ---------------------------------------------------------------------------------------------------- the controls

/**
 * The input for orbitParams after a change at track time tNow: the old parameters with the change over them. The side
 * and the direction are stored as derived; a new seat or the outward switch derives them again, unless a direction
 * was chosen (now, or before and nothing it depends on changed).
 */
function mergeChange(old, change, tNow) {
  const merged = { ...old, ...change, rollIn: false, startMs: old.startMs + Math.max(0, tNow) * 1000 };
  const touchesSide = 'seat' in change || 'seatSide' in change || 'outward' in change;
  if ('seat' in change && !('seatSide' in change)) delete merged.seatSide;
  if (!('direction' in change) && (!old.directionSet || touchesSide)) delete merged.direction;
  return merged;
}

/**
 * The parts that take the aircraft from `from` at t0 onto the circle `end`, or null when it goes round the wrong way
 * for every centre tried (a reversal). Two ways are tried and the quicker taken: (A) about the centre the aircraft
 * circles now, that centre then moving to the new one; (B) about the new centre, leaving the old path at the first
 * moment the aircraft goes round the new centre the new way and closes on its circle (a far "Orbit this" would
 * otherwise spiral there).
 */
function onto(from, t0, end, dir, p, frame) {
  const kin = from.kinAt(t0, {});
  const bankTo = dir * Math.atan((end.V * end.V) / (G * end.rho));
  const tries = [];
  const a = polarAbout(kin, { cx: [...kin.cx], cn: [...kin.cn] }, dir);
  if (consistent(a, dir)) tries.push({ wait: 0, start: a, bank: kin.bank });
  if (Math.hypot(end.cx - kin.cx[0], end.cn - kin.cn[0]) > 1) {
    const target = { cx: [end.cx, 0, 0], cn: [end.cn, 0, 0] };
    const look = Math.max(from.lapS, 60), steps = 48;
    for (let i = 0; i <= steps; i++) {
      const wait = (look * i) / steps, kq = from.kinAt(t0 + wait, {});
      const b = polarAbout(kq, target, dir);
      if (b.rho[0] > 0.25 * end.rho && consistent(b, dir) && (end.rho - b.rho[0]) * b.rho[1] >= 0) { tries.push({ wait, start: b, bank: kq.bank }); break; }
    }
  }
  let best = null;
  for (const tr of tries) {
    let seg = null;
    try { seg = transition(() => tr.start, end, dir, tr.bank, bankTo); } catch { continue; }
    const score = tr.wait + seg.T + (seg.overLimit ? 1e9 : 0);
    if (!best || score < best.score) best = { ...tr, seg, score };
  }
  if (!best) return null;
  const parts = [];
  if (best.wait > 0) parts.push({ follow: from, from: t0, lengthS: best.wait });
  parts.push({ seg: best.seg });
  parts.push({ seg: makeSegment(restOn(end, locateIn(best.seg, best.seg.T).theta, dir), end, 0, dir) });
  return parts;
}

/**
 * Change the orbit at track time tNow (4.6's controls: radius, altitude, direction or the side looked to, speed, the
 * centre). Returns the new parameters (held inside the limits) and a track whose t = 0 is the aircraft at tNow on the
 * old one, with the same position, velocity and acceleration (so heading and bank), then a transition onto the new
 * circle. A reversal of direction is an S-turn onto the circle of the new radius through the aircraft, turning the
 * other way, and then a move of that circle's centre onto the new one. Works from any moment, a transition included.
 * @param {ReturnType<typeof createOrbitTrack>} track  @param {number} tNow seconds on that track (past its end is fine)
 * @param {Partial<Parameters<typeof orbitParams>[0]>} change
 * @param {{ frame?: object }} [opts] the city frame; by default the one the track was made with
 */
export function changeOrbit(track, tNow, change = {}, { frame = track.frame } = {}) {
  const p = orbitParams(mergeChange(track.orbit, change, tNow));
  const end = endOf(p), dir = dirOf(p);
  const t0 = Math.max(0, tNow);
  let parts = onto(track, t0, end, dir, p, frame);
  if (!parts) {
    // a reversal: the S-turn onto the circle of the new radius that touches the path here and turns the new way,
    // holding height, speed and wind; from that circle, the same two ways onto the new one
    const kin = track.kinAt(t0, {});
    const vg = Math.hypot(kin.ve, kin.vn), ue = kin.ve / vg, un = kin.vn / vg;
    // its radius: the new one, or a quarter more than the smallest the bank limit allows here, for the S-turn's swing
    const vMax = kin.Vk[0] + Math.hypot(kin.we[0], kin.wn[0]);
    const r = Math.max(end.rho, (1.25 * vMax * vMax) / (G * Math.tan(ORBIT.bankMaxDeg * DEG)));
    const mx = kin.x + r * dir * un, mn = kin.n - r * dir * ue;
    const about = { cx: [mx, 0, 0], cn: [mn, 0, 0] };
    const hold = { cx: mx, cn: mn, rho: r, h: kin.hk[0], V: kin.Vk[0], we: kin.we[0], wn: kin.wn[0] };
    const sTurn = transition(() => polarAbout(kin, about, dir), hold, dir, kin.bank, -kin.bank);
    const mirror = makeSegment(restOn(hold, locateIn(sTurn, sTurn.T).theta, dir), hold, 0, dir);
    const via = assemble([{ seg: sTurn }, { seg: mirror }], { ...p, turns: 1 }, frame);
    const rest = onto(via, sTurn.T, end, dir, p, frame);
    if (!rest) throw new Error('orbit: no transition reaches the new circle');
    parts = [{ seg: sTurn }, ...rest.map((q) => (q.follow ? { ...q, follow: via } : q))];
  }
  const next = assemble(parts, p, frame);
  next.orbit.phaseDeg = next.phaseAt(next.joinT);
  return { params: next.orbit, track: next };
}

// ---------------------------------------------------------------------------------------------------- cuts

/** True when two parameter sets fly the same circle the same way (the seat may differ, on the same side). */
function sameOrbit(a, b) {
  return Math.hypot(a.center.x - b.center.x, a.center.n - b.center.n) < 1e-6 && a.altFt === b.altFt
    && Math.abs(a.radiusKm - b.radiusKm) < 1e-9 && a.direction === b.direction && a.iasKt === b.iasKt
    && Math.hypot(a.wind.east - b.wind.east, a.wind.north - b.wind.north) < 1e-6;
}

/**
 * A quick lower bound (s) on how long changeOrbit would take to put the aircraft on the new circle, without flying it:
 * the longest of the shortest change, the climb at ORBIT.climbFpm, the roll to the new bank at ORBIT.rollRateDegS and
 * the move sideways (radius and centre, about the centre circled now or about the new one, whichever is less) at
 * 0.6 V, each stretched by the quintic blend's peak rate as transition() does before its first trial. A reversal of
 * direction adds the S-turn's move of the circle by two radii. The exact duration is the flown track's joinT.
 * @param {ReturnType<typeof createOrbitTrack>} track  @param {number} tNow  @param {object} change a change for changeOrbit
 */
export function estimateChangeS(track, tNow, change = {}) {
  return estimateFor(track, tNow, orbitParams(mergeChange(track.orbit, change, tNow)));
}
/** estimateChangeS for the new parameters already completed (orbitParams). */
function estimateFor(track, tNow, p) {
  const kin = track.kinAt(Math.max(0, tNow), {});
  const end = endOf(p), dir = dirOf(p);
  const V = Math.min(end.V, kin.Vk[0]);
  const rhoNow = Math.hypot(kin.x - kin.cx[0], kin.n - kin.cn[0]);
  const aboutOld = Math.abs(end.rho - rhoNow) + Math.hypot(end.cx - kin.cx[0], end.cn - kin.cn[0]);
  const aboutNew = Math.abs(end.rho - Math.hypot(kin.x - end.cx, kin.n - end.cn));
  const reversal = p.direction !== track.orbit.direction;
  const sideways = Math.min(aboutOld, aboutNew) + (reversal ? 2 * end.rho : 0);
  const bankTo = dir * Math.atan((end.V * end.V) / (G * end.rho));
  return Math.max(ORBIT.changeMinS,
    (QUINTIC_PEAK * Math.abs(end.h - kin.h)) / ((ORBIT.climbFpm * FT) / 60),
    (QUINTIC_PEAK * sideways) / (0.6 * V),
    (QUINTIC_PEAK * Math.abs(bankTo - kin.bank)) / (ORBIT.rollRateDegS * DEG));
}

/**
 * The change made as a cut: the new orbit already established on its circle, at the bearing from its centre nearest
 * the aircraft at tNow (no roll-in), its clock going on from that moment. The mode hides the jump under its fade.
 */
export function cutOrbit(track, tNow, change = {}, { frame = track.frame } = {}) {
  const merged = mergeChange(track.orbit, change, tNow);
  const p = orbitParams(merged);
  const kin = track.kinAt(Math.max(0, tNow), {});
  const phaseDeg = mod(Math.atan2(kin.x - p.center.x, kin.n - p.center.n) / DEG, 360);
  const next = createOrbitTrack({ ...merged, phaseDeg, rollIn: false }, { frame });
  return { params: next.orbit, track: next };
}

/**
 * A change to the orbit, flown when it is short and cut when it is long (the decision of 25 Nov 2026). The quick
 * estimate decides first; when it allows flying, the change is flown and its real duration (the new track's joinT)
 * decides. `cut: true` (a preset) always cuts. A change that leaves the circle as it is (another seat on the same side)
 * returns the track unchanged.
 * @returns {{ params: object, track: object, cut: boolean, unchanged?: boolean, flownS?: number, estimateS: number }}
 */
export function planChange(track, tNow, change = {}, { cut = false, maxFlownS = ORBIT.flownMaxS, frame = track.frame } = {}) {
  const p = orbitParams(mergeChange(track.orbit, change, tNow));
  if (sameOrbit(p, track.orbit)) return { params: track.orbit, track, cut: false, unchanged: true, estimateS: 0 };
  const estimateS = estimateFor(track, tNow, p);
  if (cut || estimateS > maxFlownS) return { ...cutOrbit(track, tNow, change, { frame }), cut: true, estimateS };
  const flown = changeOrbit(track, tNow, change, { frame });
  const flownS = flown.track.joinT;
  if (flownS > maxFlownS) return { ...cutOrbit(track, tNow, change, { frame }), cut: true, estimateS, flownS };
  return { ...flown, cut: false, estimateS, flownS };
}
