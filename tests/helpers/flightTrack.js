// A synthetic airliner arrival in the baked format (skyline-flight/1, plan 03, section 6.2), for developing and testing
// the flight before a real track is baked. Physically plausible, not recorded: a cruise, a descent with a level-off at
// 10,000 ft and another at the intercept altitude, a coordinated turn onto final while descending, a 3 degree glide
// path, a flare, touchdown and a braked rollout, with the flap, slat, gear, spoiler, reverser and light channels a
// 737-800 would show (the numbers of section 7.3). No wind, so heading equals track and ground speed is true airspeed
// times the cosine of the path angle.
//
// Built backwards from touchdown: the path is a function of u, metres along it from the landing threshold (negative
// before it), integrated in 2 m steps; time comes from the speed schedule; the result is sampled at 1 Hz. Everything
// here is a test helper: it may integrate, the app may not.
import { standardAtmosphere } from '../../src/flight/env.js';
import { G } from '../../src/flight/kinematics.js';
import { FORMAT, LIGHT } from '../../src/flight/track.js';

/**
 * Runway 19R at Las Vegas in the app frame: the landing threshold, the true heading and the elevation of the threshold,
 * and how the runway rises past it, from FAA NASR (cycle of 29 Oct 2026) as public/data/lv/airport.json has them. The
 * runway climbs 1.04% to the south (26.7 m over the 2,560 m between the 19R threshold and the 1L displaced threshold),
 * so the 665 m field elevation is the far end, not the touchdown zone.
 */
export const LAS_19R = Object.freeze({ threshold: Object.freeze({ x: 1373, y: -1885 }), headingDeg: 205, elevationM: 636.57,
  runwaySlope: (663.28 - 636.57) / (2738.9 - 178.71), runway: '19R' });

export const CHANNELS = ['x', 'n', 'h', 's', 'gs', 'vs', 'tas', 'ias', 'hdg', 'pitch', 'roll',
  'flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'lights', 'cabinLight', 'turbulence'];

const DEG = Math.PI / 180;
const KT = 1852 / 3600;
const FT = 0.3048;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => { const u = clamp01((v - a) / (b - a)); return u * u * (3 - 2 * u); };
/** Piecewise-linear lookup in sorted [x, y] rows, held flat beyond the ends. */
const lerpRows = (rows, x) => {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) if (x <= rows[i][0]) return rows[i - 1][1] + ((rows[i][1] - rows[i - 1][1]) * (x - rows[i - 1][0])) / (rows[i][0] - rows[i - 1][0]);
  return rows[rows.length - 1][1];
};

/** Angle of attack (deg) at an indicated airspeed (m/s) and flap position: lift at a constant 62 t, fitted to 7.3's
 * reference attitudes (2.5 deg at cruise, 5 deg level clean at manoeuvring speed, 2.4 deg on a 3 degree path with flaps 30). */
const FLAP_SHIFT = [[0, 0], [1, 0.3], [5, 0.8], [15, 2.5], [30, 4.4], [40, 6]];
const alphaDeg = (ias, flap) => Math.min(12, Math.max(0, -0.872 + 55255 / (ias * ias) - lerpRows(FLAP_SHIFT, flap)));

/**
 * @param {object} [o] every number has a default for a runway 19R arrival at Las Vegas
 * @returns {{ header: object, buffer: ArrayBuffer, channels: Record<string, Float32Array> }}
 */
export function syntheticArrival(o = {}) {
  const {
    threshold = LAS_19R.threshold, headingDeg = LAS_19R.headingDeg, elevationM: elev = LAS_19R.elevationM, runwaySlope = LAS_19R.runwaySlope ?? 0, runway = LAS_19R.runway,
    id = 'synthetic-19', city = 'lv', airport = 'KLAS', touchdownMs = Date.UTC(2025, 2, 15, 19, 42, 17),
    durationS = 1620, rolloutS = 60, dt = 1,
    turnDeg = -90, turnRadiusM = 2500, rampM = 400, finalM = 6000,
    glideDeg = 3, tchM = 15, touchdownPastM = 400, flareStartM = 9, touchdownSinkMs = 0.7,
    interceptM = 1400, levelAtInterceptM = 11000, tenM = 10000 * FT, levelAtTenM = 10000, cruiseM = 35000 * FT, descentDeg = 3,
  } = o;
  const psiR = headingDeg * DEG, tanG = Math.tan(glideDeg * DEG), tanD = Math.tan(descentDeg * DEG);
  const dirOf = (psi) => [Math.sin(psi), Math.cos(psi)];

  // ---- the vertical profile, in D = metres before the threshold along the path
  const Dg = (interceptM - elev - tchM) / tanG, D1 = Dg + levelAtInterceptM, D2 = D1 + (tenM - interceptM) / tanD;
  const D3 = D2 + levelAtTenM, D4 = D3 + (cruiseM - tenM) / tanD;
  const hRaw = (D) => (D <= Dg ? elev + tchM + D * tanG : D <= D1 ? interceptM : D <= D2 ? interceptM + (D - D1) * tanD
    : D <= D3 ? tenM : D <= D4 ? tenM + (D - D3) * tanD : cruiseM);
  // corners rounded by a 2 km moving average, so the vertical speed is continuous (straight parts are unchanged)
  const hSmooth = (D) => { let sum = 0; for (let k = 0; k <= 40; k++) sum += hRaw(D - 1000 + k * 50); return sum / 41; };

  // ---- speeds: indicated airspeed scheduled along the path; true airspeed from it, capped at Mach 0.78
  const turnLen = Math.abs(turnDeg * DEG) * turnRadiusM + rampM;
  const IAS = [[-touchdownPastM, 69.5], [0, 72], [5800, 72], [finalM + turnLen + 1000, 87.5], [Dg + 0.6 * (D1 - Dg), 108],
    [D1, 250 * KT], [D2 + 1500, 250 * KT], [D3, 280 * KT]]; // 250 kt before the rounded corner takes it below 10,000 ft
  const tasAt = (D, h) => { const a = standardAtmosphere(h); return Math.min(lerpRows(IAS, D) / Math.sqrt(a.sigma), 0.78 * a.soundMs); };
  const iasOf = (tas, h) => tas * Math.sqrt(standardAtmosphere(h).sigma);

  // ---- the runway surface past the threshold (rising along the landing direction when runwaySlope > 0)
  const surface = (u) => elev + runwaySlope * Math.max(0, u);
  // ---- the flare: a cubic in distance of the wheels' height above that surface, from flareStartM to touchdown,
  // matching the glide path at its start and the touchdown sink rate (towards the surface) at its end
  const closing = tanG + runwaySlope; // how fast the glide path closes on the surface, per metre, past the threshold
  const xf = (tchM - flareStartM) / closing, L = touchdownPastM - xf;
  const gsTd = tasAt(-touchdownPastM, elev);
  const m1 = -touchdownSinkMs / gsTd;
  const flare = (xi) => { const u = xi / L, u2 = u * u, u3 = u2 * u; return (2 * u3 - 3 * u2 + 1) * flareStartM + (u3 - 2 * u2 + u) * L * -closing + (u3 - u2) * L * m1; };
  const height = (u) => (u >= touchdownPastM ? surface(u) : u > xf ? surface(u) + flare(u - xf) : hSmooth(-u));

  // ---- the lateral path: straight final on the runway heading, a turn with curvature ramped in and out (so the bank
  // is continuous), and a straight inbound leg before it
  const kappa0 = Math.sign(turnDeg) / turnRadiusM;
  const uB = -finalM, uA = uB - turnLen;
  const kappa = (u) => (u <= uA || u >= uB ? 0 : kappa0 * Math.min(1, (u - uA) / rampM, (uB - u) / rampM));

  // ---- integrate backwards from touchdown in 2 m steps: position, heading, time
  const tStart = rolloutS - durationS; // seconds, touchdown = 0
  const DU = 2;
  const grid = { u: [], x: [], n: [], psi: [], t: [] };
  let u = touchdownPastM, psi = psiR, t = 0;
  let [x, n] = [threshold.x + u * dirOf(psiR)[0], threshold.y + u * dirOf(psiR)[1]];
  const gsAt = (uu) => {
    const h = height(uu), slope = (height(uu + 1) - height(uu - 1)) / 2;
    return tasAt(-uu, h) * Math.cos(Math.atan(slope));
  };
  for (;;) {
    grid.u.push(u); grid.x.push(x); grid.n.push(n); grid.psi.push(psi); grid.t.push(t);
    if (t < tStart - 2 * dt) break;
    if (u < -1e6) throw new Error('synthetic arrival: the flight would start more than 1,000 km out');
    const um = u - DU / 2;
    const psiMid = psi - kappa(um) * (DU / 2);
    const [dx, dn] = dirOf(psiMid);
    x -= dx * DU; n -= dn * DU;
    psi -= kappa(um) * DU;
    t -= DU / gsAt(um);
    u -= DU;
  }
  for (const k of Object.keys(grid)) grid[k].reverse();
  /** u at an airborne time (t <= 0), from the grid. */
  const uAtTime = (tq) => {
    const T = grid.t;
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= tq) lo = mid; else hi = mid; }
    const f = (tq - T[lo]) / (T[hi] - T[lo] || 1);
    return { k: lo, f, u: grid.u[lo] + (grid.u[hi] - grid.u[lo]) * f };
  };
  const gridAt = (key, k, f) => grid[key][k] + (grid[key][k + 1] - grid[key][k]) * f;
  const timeAtU = (uq) => { let k = 0; while (k < grid.u.length - 1 && grid.u[k + 1] < uq) k++; return grid.t[k] + (grid.t[k + 1] - grid.t[k]) * ((uq - grid.u[k]) / (grid.u[k + 1] - grid.u[k])); };

  // ---- the rollout: 2 m/s^2 (autobrake 2 to 3) to 12 m/s, then 0.1 m/s^2
  const A1 = 2, A2 = 0.1, VTAXI = 12;
  const t1 = (gsTd - VTAXI) / A1, t60 = (gsTd - 60 * KT) / A1;
  const rollV = (tq) => (tq < t1 ? gsTd - A1 * tq : Math.max(0, VTAXI - A2 * (tq - t1)));
  const rollS = (tq) => (tq < t1 ? gsTd * tq - (A1 * tq * tq) / 2 : gsTd * t1 - (A1 * t1 * t1) / 2 + VTAXI * (tq - t1) - (A2 * (tq - t1) ** 2) / 2);

  // ---- configuration: lever commands at points on the path, surfaces travelling at one lever unit a second
  const flapCmds = [[20000, 1], [Dg, 5], [9000, 15], [7000, 30]].map(([D, f]) => [timeAtU(-D), f]);
  const tGear = timeAtU(-9000);
  const flapAt = (tq) => {
    let p = 0, target = 0, tc = -Infinity;
    const move = (to, span) => { const d = to - p; return p + Math.sign(d) * Math.min(Math.abs(d), Math.max(0, span)); };
    for (const [tk, f] of flapCmds) { if (tk > tq) break; p = move(target, tk - tc); target = f; tc = tk; }
    return move(target, tq - tc);
  };
  const slatOf = (f) => (f <= 1 ? f : f <= 5 ? 1 : Math.min(2, 1 + (f - 5) / 5));
  const tdPitch = (() => { const st = airborne(-1e-3); return st.pitch; })();

  /** The state at an airborne time t <= 0: position, height, speeds and attitude. */
  function airborne(tq) {
    const { k, f, u: uq } = uAtTime(tq);
    const h = height(uq), slope = (height(uq + 0.5) - height(uq - 0.5)) / 1;
    const gamma = Math.atan(slope);
    const tas = tasAt(-uq, h), gs = tas * Math.cos(gamma), ias = iasOf(tas, h);
    const flap = flapAt(tq);
    return {
      x: gridAt('x', k, f), n: gridAt('n', k, f), h, u: uq, gs, tas, ias, vs: gs * slope, psi: gridAt('psi', k, f),
      pitch: gamma / DEG + alphaDeg(ias, flap), roll: Math.atan((tas * tas * kappa(uq)) / G) / DEG, flap,
    };
  }
  /** Any time from touchdown (negative before it). */
  function stateAt(tq) {
    if (tq < 0) return airborne(tq);
    const along = touchdownPastM + rollS(tq), [dx, dn] = dirOf(psiR), gs = rollV(tq);
    return { x: threshold.x + along * dx, n: threshold.y + along * dn, h: surface(along), u: along, gs, tas: gs, ias: iasOf(gs, elev), vs: gs * runwaySlope, psi: psiR,
      pitch: tdPitch * (1 - smoothstep(1, 6, tq)), roll: 0, flap: flapAt(tq) };
  }

  // ---- sample at dt
  const N = Math.round(durationS / dt) + 1;
  const ch = Object.fromEntries(CHANNELS.map((c) => [c, new Float32Array(N)]));
  const uFirst = stateAt(tStart).u;
  for (let i = 0; i < N; i++) {
    const tq = tStart + i * dt, st = stateAt(tq);
    const gear = clamp01((tq - tGear) / 10);
    let lights = LIGHT.NAV | LIGHT.BEACON | LIGHT.STROBE;
    if (st.h < tenM || tq >= 0) lights |= LIGHT.LANDING | LIGHT.TURNOFF | LIGHT.LOGO;
    if (gear > 0.5) lights |= LIGHT.TAXI;
    const row = {
      x: st.x, n: st.n, h: st.h, s: st.u - uFirst, gs: st.gs, vs: st.vs, tas: st.tas, ias: st.ias,
      hdg: ((st.psi / DEG) % 360 + 360) % 360, pitch: st.pitch, roll: st.roll,
      flap: st.flap, slat: slatOf(st.flap), gear, speedbrake: 0,
      groundSpoiler: tq >= 0 ? clamp01((tq - 0.5) / 1) : 0,
      reverser: tq >= 0 ? clamp01((tq - 2) / 2) * (1 - clamp01((tq - t60) / 3)) : 0,
      lights, cabinLight: 1, turbulence: lerpRows([[elev + 300, 0.1], [1500, 0.25], [3000, 0.25], [4000, 0.1]], st.h),
    };
    for (const c of CHANNELS) ch[c][i] = row[c];
  }

  // ---- events, in seconds from the start of the track
  const crossing = (level) => { for (let i = 1; i < N; i++) if (ch.h[i - 1] > level && ch.h[i] <= level) return i * dt; return null; };
  const rel = (tq) => tq - tStart;
  const events = [
    rel(timeAtU(-D4)) > 0 ? { t: 0, id: 'cruise', label: `Cruise, ${Math.round(cruiseM / FT / 1000) * 1000} ft`.replace(/(\d)(\d{3}) ft/, '$1,$2 ft') } : null,
    { t: rel(timeAtU(-D4)), id: 'tod', label: 'Top of descent' },
    { t: crossing(18000 * FT), id: 'fl180', label: '18,000 ft' },
    { t: crossing(tenM), id: '10000', label: '10,000 ft' },
    { t: rel(tGear), id: 'gear', label: 'Gear down' },
    { t: crossing(elev + 1000 * FT), id: 'ft1000', label: '1,000 ft' },
    { t: rel(timeAtU(0)), id: 'threshold', label: `Runway ${runway} threshold` },
    { t: rel(0), id: 'touchdown', label: 'Touchdown' },
  ].filter((e) => e && e.t !== null && e.t >= 0 && e.t <= durationS);

  const data = new Float32Array(CHANNELS.length * N);
  CHANNELS.forEach((c, k) => data.set(ch[c], k * N));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const header = {
    format: FORMAT,
    id, city, airport, runway, aircraftType: 'B738',
    recordedStart: iso(touchdownMs + tStart * 1000), touchdown: iso(touchdownMs),
    dt, samples: N, channels: CHANNELS,
    provenance: Object.fromEntries(CHANNELS.map((c) => [c, 'synthetic'])),
    reconstructed: [{ from: 0, to: durationS, what: 'synthetic: generated by tests/helpers/flightTrack.js, nothing recorded' }],
    events,
    atmosphere: [elev, 1500, 3000, 6000, 9000, 12000].map((a) => [a, Math.round(standardAtmosphere(a).tempC * 10) / 10, 0, 0]),
    badges: { light: 'day', weather: 'clear', from: 'east', stripSide: 'right' },
    qa: {
      glidePathDeg: Math.round((Math.atan((height(-3000) - height(-1000)) / 2000) / DEG) * 100) / 100,
      crossingHeightM: Math.round((height(0) - elev) * 10) / 10,
      touchdownPastThresholdM: touchdownPastM, altitudeOffsetM: 0, datum: 'synthetic',
    },
    source: { archive: 'synthetic', generator: 'tests/helpers/flightTrack.js', licence: 'none needed: generated, not recorded' },
  };
  return { header, buffer: data.buffer, channels: ch };
}
