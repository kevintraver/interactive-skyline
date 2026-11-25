// A baked flight track (plan 03, sections 5.5 and 6.2): the JSON header and the raw little-endian Float32 channels of
// format skyline-flight/1, sampled at any time as an AircraftState. Pure: no scene state, nothing integrated from
// frame to frame, so scrubbing backwards and jumping give the same state as playing there.
//
// The file holds x and n (metres east and north of the city origin) and h (metres above sea level); the city's base
// and the curve drop are applied here, through frame.sceneY, so the file does not depend on them. Scene axes: x east,
// y up, z south.
//
// Units in the file: metres and m/s; hdg, pitch and roll in degrees (hdg clockwise from grid north); flap in lever
// units (0..40), slat 0..2, gear and the other surfaces 0..1; lights a bit field (LIGHT below); cabinLight and
// turbulence 0..1. Positions, speeds and angles are cubic Hermite between samples, with tangents from the neighbouring
// samples, so position and velocity are continuous; s and h use tangents limited to keep them monotonic between samples
// (Fritsch and Carlson), so s can be inverted and h never dips under a runway or a level-off. The one break is the
// vertical velocity at a touchdown that falls on a sample, where the wheels go from sinking to following the runway. Configuration channels are linear, the light bit field steps. Heading is unwrapped on load,
// so it interpolates the short way through north.
import { Quaternion, Vector3 } from 'three';
import { EARTH_R } from '../world/frame.js';
import { bodyQuaternion } from './kinematics.js';

export const FORMAT = 'skyline-flight/1';

/** Bits of the `lights` channel (section 5.5). */
export const LIGHT = Object.freeze({ NAV: 1, BEACON: 2, STROBE: 4, LANDING: 8, TAXI: 16, TURNOFF: 32, LOGO: 64, WING: 128 });

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
const HERMITE = ['x', 'n', 'h', 's', 'gs', 'vs', 'tas', 'ias', 'hdg', 'pitch', 'roll'];
const LINEAR = ['flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'cabinLight', 'turbulence'];
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** A blank AircraftState with its own vectors. */
export function createState() {
  return {
    t: 0, s: 0, position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), airVelocity: new Vector3(),
    heading: 0, pitch: 0, roll: 0, altMsl: 0, gs: 0, tas: 0, ias: 0, vs: 0,
    flap: 0, slat: 0, gear: 0, speedbrake: 0, groundSpoiler: 0, reverser: 0, lights: 0, cabinLight: 0, turbulence: 0,
    onGround: false,
  };
}

/** The channels of the binary as Float32Arrays, `samples` values each, channel after channel. */
function readChannels(header, buffer) {
  const bytes = ArrayBuffer.isView(buffer) ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
  const { channels, samples } = header;
  const want = channels.length * samples * 4;
  if (bytes.byteLength !== want) throw new Error(`track ${header.id}: binary size ${bytes.byteLength}, expected ${want} (${channels.length} channels x ${samples} samples)`);
  let all;
  if (LITTLE_ENDIAN) all = new Float32Array(bytes);
  else {
    const view = new DataView(bytes);
    all = new Float32Array(want / 4);
    for (let i = 0; i < all.length; i++) all[i] = view.getFloat32(i * 4, true);
  }
  const out = {};
  channels.forEach((name, k) => { out[name] = all.subarray(k * samples, (k + 1) * samples); });
  return out;
}

/** Tangents (per second) from the neighbouring samples; one-sided at the ends. */
function tangents(v, dt, monotone = false) {
  const n = v.length, m = new Float64Array(n);
  if (n < 2) return m;
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (v[i + 1] - v[i]) / dt;
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;
  if (monotone) {
    // Fritsch-Carlson: flat where the data is flat, and tangents no steeper than three times either secant
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i];
      if (a < 0) m[i] = 0;
      if (b < 0) m[i + 1] = 0;
      const r = a * a + b * b;
      if (r > 9) { const k = 3 / Math.sqrt(r); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
    }
  }
  return m;
}

/** Heading in degrees unwrapped so that no step between samples exceeds 180 degrees. */
function unwrapDegrees(v) {
  const out = new Float64Array(v.length);
  let offset = 0;
  for (let i = 0; i < v.length; i++) {
    if (i > 0) {
      const step = v[i] + offset - out[i - 1];
      if (Math.abs(step) > 180) offset -= 360 * Math.round(step / 360);
    }
    out[i] = v[i] + offset;
  }
  return out;
}

/** Wind (east, north) in m/s at a height, from the header's atmosphere rows [alt m, temp C, wind east, wind north]. */
function windAt(rows, altM) {
  if (!rows || !rows.length) return [0, 0];
  if (altM <= rows[0][0]) return [rows[0][2], rows[0][3]];
  for (let i = 1; i < rows.length; i++) {
    if (altM <= rows[i][0]) {
      const [a0, , e0, n0] = rows[i - 1], [a1, , e1, n1] = rows[i];
      const u = (altM - a0) / (a1 - a0);
      return [e0 + (e1 - e0) * u, n0 + (n1 - n0) * u];
    }
  }
  const last = rows[rows.length - 1];
  return [last[2], last[3]];
}

/**
 * A Track from its header (the parsed <id>.json) and its binary (<id>.bin).
 * @param {object} header
 * @param {ArrayBuffer | ArrayBufferView} buffer
 * @param {{ frame: { sceneY(h: number, x: number, y: number): number } }} o the city frame (src/world/frame.js)
 * @returns {import('./types.d.ts').Track}
 */
export function parseTrack(header, buffer, { frame } = {}) {
  if (header?.format !== FORMAT) throw new Error(`track: format ${header?.format}, expected ${FORMAT}`);
  if (!frame || typeof frame.sceneY !== 'function') throw new Error('track: a city frame (createFrame) is needed to place it');
  const dt = header.dt ?? 1;
  const raw = readChannels(header, buffer);
  const N = header.samples;
  if (N < 2) throw new Error(`track ${header.id}: needs at least two samples`);
  for (const c of ['x', 'n', 'h']) if (!raw[c]) throw new Error(`track ${header.id}: no ${c} channel`);
  const durationS = (N - 1) * dt;

  // s from the start of the track; computed from the positions if the file has none
  let s = raw.s;
  if (!s) {
    s = new Float64Array(N);
    for (let i = 1; i < N; i++) s[i] = s[i - 1] + Math.hypot(raw.x[i] - raw.x[i - 1], raw.n[i] - raw.n[i - 1]);
  }
  const s0 = s[0];
  const values = {};
  for (const c of HERMITE) if (raw[c]) values[c] = c === 'hdg' ? unwrapDegrees(raw[c]) : c === 's' ? Float64Array.from(s, (v) => v - s0) : raw[c];
  if (!values.s) values.s = Float64Array.from(s, (v) => v - s0);
  const slopes = {};
  // s must stay invertible, and h must not overshoot where it meets a flat (the runway at touchdown, a level-off):
  // plain neighbour tangents would carry the sink rate past the touchdown sample and put the wheels under the runway
  for (const c of Object.keys(values)) slopes[c] = tangents(values[c], dt, c === 's' || c === 'h');

  const recordedStartMs = Date.parse(header.recordedStart);
  const tdEvent = (header.events || []).find((e) => e.id === 'touchdown');
  const touchdownT = header.touchdown ? (Date.parse(header.touchdown) - recordedStartMs) / 1000 : tdEvent ? tdEvent.t : Infinity;
  // At touchdown the wheels' vertical velocity really does jump: from the sink rate to following the runway. When the
  // touchdown falls on a sample, h takes the slope of each side there (so a runway rising past the touchdown point is
  // followed from its first second, instead of the wheels sinking into it under a flat tangent).
  const kTd = Math.round(touchdownT / dt);
  const hBreak = values.h && kTd > 0 && kTd < N - 1 && Math.abs(touchdownT - kTd * dt) < 1e-6
    ? { before: (values.h[kTd] - values.h[kTd - 1]) / dt, after: (values.h[kTd + 1] - values.h[kTd]) / dt } : null;

  // where in the samples a time falls: index i of the interval and u in [0, 1]
  const at = { i: 0, u: 0 };
  const locate = (t) => {
    const tc = Number.isFinite(t) ? Math.min(Math.max(t, 0), durationS) : 0;
    const i = Math.min(Math.floor(tc / dt), N - 2);
    at.i = i;
    at.u = (tc - i * dt) / dt;
    return tc;
  };
  /** The tangents at both ends of the located interval. */
  const ends = (c) => {
    const m = slopes[c], { i } = at;
    let m0 = m[i], m1 = m[i + 1];
    if (c === 'h' && hBreak) {
      if (i === kTd) m0 = hBreak.after;
      if (i + 1 === kTd) m1 = hBreak.before;
    }
    return [m0, m1];
  };
  /** Hermite value of a channel at the located time. */
  const hv = (c) => {
    const v = values[c], { i, u } = at, [m0, m1] = ends(c);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v[i] + (u3 - 2 * u2 + u) * dt * m0 + (-2 * u3 + 3 * u2) * v[i + 1] + (u3 - u2) * dt * m1;
  };
  /** Its rate of change, per second. */
  const hd = (c) => {
    const v = values[c], { i, u } = at, [m0, m1] = ends(c);
    const u2 = u * u;
    return ((6 * u2 - 6 * u) * v[i] + (3 * u2 - 4 * u + 1) * dt * m0 + (-6 * u2 + 6 * u) * v[i + 1] + (3 * u2 - 2 * u) * dt * m1) / dt;
  };
  const lin = (c) => {
    const v = raw[c];
    if (!v) return 0;
    const { i, u } = at;
    return v[i] + (v[i + 1] - v[i]) * u;
  };
  const sAt = (t) => { locate(t); return hv('s'); };

  const events = (header.events || [])
    .map((e) => ({ t: e.t, s: Number.isFinite(e.s) ? e.s : sAt(e.t), id: e.id, label: e.label }))
    .sort((a, b) => a.t - b.t);

  const track = {
    meta: header,
    dt, samples: N, durationS, recordedStartMs, touchdownT,
    lengthM: values.s[N - 1],
    events,
    /** The raw values of one channel, as stored (heading in degrees, not unwrapped). */
    channel: (name) => raw[name] ?? null,
    sAt,
    /** Seconds from the start at which the aircraft has come s metres along the track (the first such time). */
    timeAtS(sq) {
      const v = values.s;
      if (!(sq > v[0])) return 0;
      if (sq >= v[N - 1]) return durationS;
      let lo = 0, hi = N - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (v[mid] < sq) lo = mid; else hi = mid; }
      // within the interval the monotone Hermite is inverted by bisection
      let a = lo * dt, b = hi * dt;
      for (let k = 0; k < 60 && b - a > 1e-9; k++) { const mid = (a + b) / 2; if (sAt(mid) < sq) a = mid; else b = mid; }
      return (a + b) / 2;
    },
    /**
     * The aircraft at `t` seconds from the start of the track, clamped to [0, durationS].
     * @param {number} t
     * @param {import('./types.d.ts').AircraftState} [out]
     */
    sample(t, out = createState()) {
      const tc = locate(t);
      const x = hv('x'), n = hv('n'), h = hv('h');
      const vx = hd('x'), vn = hd('n'), vh = hd('h');
      out.t = tc;
      out.s = hv('s');
      out.position.set(x, frame.sceneY(h, x, n), -n);
      // scene y also falls with the curve drop, (x vx + n vn) / R: level flight follows the curved datum
      out.velocity.set(vx, vh - (x * vx + n * vn) / EARTH_R, -vn);
      out.altMsl = h;
      out.heading = values.hdg ? ((((hv('hdg') * DEG) % TAU) + TAU) % TAU) : ((Math.atan2(vx, vn) % TAU) + TAU) % TAU;
      out.pitch = values.pitch ? hv('pitch') * DEG : 0;
      out.roll = values.roll ? hv('roll') * DEG : 0;
      out.gs = values.gs ? hv('gs') : Math.hypot(vx, vn);
      out.vs = values.vs ? hv('vs') : vh;
      out.tas = values.tas ? hv('tas') : out.gs;
      out.ias = values.ias ? hv('ias') : out.tas;
      const [we, wn] = windAt(header.atmosphere, h);
      out.airVelocity.set(out.velocity.x - we, out.velocity.y, out.velocity.z + wn);
      bodyQuaternion(out.position.x, out.position.z, out.heading, out.pitch, out.roll, out.quaternion);
      for (const c of LINEAR) out[c] = lin(c);
      out.lights = raw.lights ? raw.lights[at.u >= 1 ? at.i + 1 : at.i] : 0;
      out.onGround = tc >= touchdownT;
      return out;
    },
  };
  return track;
}

/**
 * Load <id>.json and the <id>.bin beside it.
 * @param {string} url the header's address
 * @param {{ frame: object, fetch?: typeof fetch }} o
 */
export async function loadTrack(url, { frame, fetch: get = globalThis.fetch } = {}) {
  const binUrl = url.replace(/\.json(\?.*)?$/, '.bin$1');
  const res = await get(url);
  if (!res.ok) throw new Error(`track: ${url} answered ${res.status}`);
  const header = await res.json();
  const bin = await get(binUrl);
  if (!bin.ok) throw new Error(`track: ${binUrl} answered ${bin.status}`);
  return parseTrack(header, await bin.arrayBuffer(), { frame });
}
