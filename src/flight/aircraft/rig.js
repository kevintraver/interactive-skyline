// The airframe's rig (plan 03, section 7.8; F3.4): from an AircraftState's configuration channels to the pose of each
// moving part, by the tables of public/models/aircraft/rig.json, and the wing's flex. Pure: no scene objects, no time
// but what is passed in, so a scrub, a seek and a screenshot at a given time give the same airframe.
//
// rig.json (written by models/aircraft/build_airframe.py; read its `about`): for each part its node, parent, pivot and
// unit hinge axis, and per channel a table of rows { at, t, r }. At a channel value `at` the part is moved by `t`
// metres and turned by `r` degrees about its axis through its pivot, both in its parent's frame; between rows the
// value is linear. Every node's origin is its pivot and its rest rotation is identity, so a pose is simply
// position = rest + t and quaternion = (axis, r). The spoilers carry two tables (speed brake, ground spoilers): the
// larger angle wins, as the panels are driven by whichever command asks for more. Both wings have their own rows in
// the file, written from one table and mirrored, which the unit test checks.

const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => { const u = clamp01((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/** The channels a part's table can name, with their value at rest (missing from a state = at rest). */
export const CHANNELS = Object.freeze(['flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'aileron']);

/**
 * A table's pose at `v`: linear between rows, the end rows held beyond them, a non-number read as the first row.
 * @param {{ at: number, t: number[], r: number }[]} rows sorted by `at`
 * @param {number} v
 * @param {{ t: number[], r: number }} [out]
 */
export function sampleTable(rows, v, out = { t: [0, 0, 0], r: 0 }) {
  const n = rows.length;
  let a = rows[0], b = rows[0], u = 0;
  if (Number.isFinite(v) && v > rows[0].at) {
    if (v >= rows[n - 1].at) a = b = rows[n - 1];
    else {
      let i = 1;
      while (rows[i].at < v) i++;
      a = rows[i - 1]; b = rows[i];
      u = (v - a.at) / (b.at - a.at);
    }
  }
  if (u === 0) { out.t[0] = a.t[0]; out.t[1] = a.t[1]; out.t[2] = a.t[2]; out.r = a.r; return out; }
  for (let k = 0; k < 3; k++) out.t[k] = a.t[k] + (b.t[k] - a.t[k]) * u;
  out.r = a.r + (b.r - a.r) * u;
  return out;
}

const _scratch = { t: [0, 0, 0], r: 0 };

/**
 * One part's pose for a set of channel values: { t: metres in the parent's frame, r: degrees about the part's axis }.
 * With several tables the one asking for the larger angle wins (its translation comes with it).
 * @param {{ tables: Record<string, { at: number, t: number[], r: number }[]> }} part
 * @param {Record<string, number>} ch
 * @param {{ t: number[], r: number }} [out]
 */
export function partPose(part, ch, out = { t: [0, 0, 0], r: 0 }) {
  let first = true;
  for (const name in part.tables) {
    const p = first ? out : _scratch;
    sampleTable(part.tables[name], ch[name] ?? 0, p);
    if (!first && Math.abs(p.r) > Math.abs(out.r)) { out.t[0] = p.t[0]; out.t[1] = p.t[1]; out.t[2] = p.t[2]; out.r = p.r; }
    first = false;
  }
  return out;
}

/**
 * The rig's channels from an AircraftState: each at rest when the state has none; the slats from the flap schedule
 * when the state carries no slat channel (rig.json's `slatSchedule`, lever position to slat state).
 * @param {Partial<Record<string, number>>} state
 * @param {{ slatSchedule?: number[][] }} rig
 * @param {Record<string, number>} [out]
 */
export function channelsOf(state, rig, out = {}) {
  for (const c of CHANNELS) out[c] = Number.isFinite(state[c]) ? state[c] : 0;
  if (!Number.isFinite(state.slat) && rig.slatSchedule) out.slat = lerpRows(rig.slatSchedule, out.flap);
  return out;
}

/** Piecewise-linear lookup in sorted [x, y] rows, flat beyond the ends. */
function lerpRows(rows, x) {
  if (!(x > rows[0][0])) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) return rows[i - 1][1] + ((rows[i][1] - rows[i - 1][1]) * (x - rows[i - 1][0])) / (rows[i][0] - rows[i - 1][0]);
  }
  return rows[rows.length - 1][1];
}

const _ch = {};

/**
 * Every part's pose for a state, keyed by node name. Pass the same Map each frame: its entries are reused.
 * @param {{ parts: object[], slatSchedule?: number[][] }} rig
 * @param {Partial<Record<string, number>>} state
 * @param {Map<string, { t: number[], r: number }>} [out]
 */
export function rigPoses(rig, state, out = new Map()) {
  channelsOf(state, rig, _ch);
  for (const part of rig.parts) {
    let pose = out.get(part.node);
    if (!pose) { pose = { t: [0, 0, 0], r: 0 }; out.set(part.node, pose); }
    partPose(part, _ch, pose);
  }
  return out;
}

// ---------------------------------------------------------------- flex (section 7.8)

/**
 * The wing's bending shape along the span, 0 at the root and 1 at the tip: w(eta) = eta^2 (3 - eta) / 2, a cantilever
 * under a load growing toward the root (zero deflection and slope at the root, the tip at 1).
 */
export function flexShape(eta) {
  const e = eta <= 0 ? 0 : eta >= 1 ? 1 : eta;
  return (e * e * (3 - e)) / 2;
}

/** Fraction of the span from rig.flex.rootY to rig.flex.tipY at |x| metres from the centre line (0 inside the root). */
export function spanFraction(x, rig) {
  const { rootY, tipY } = rig.flex;
  return Math.min(1, Math.max(0, (Math.abs(x) - rootY) / (tipY - rootY)));
}

/** Speed at which the wing carries the whole weight on the runway (about the touchdown speed), m/s. */
const LIFT_SPEED = 70;
/** Share of the lift the ground spoilers dump (they leave the wing carrying almost nothing). */
const DUMP = 0.85;
/** Tip amplitude of the shake at full turbulence, metres (ESTIMATED, as rig.json's 1 g deflection is). */
const SHAKE_M = 0.05;

/**
 * Share of the weight the wing carries: all of it in the air; on the ground it falls with the square of the airspeed
 * and the ground spoilers dump most of what is left (why the tip visibly drops at touchdown).
 * @param {{ onGround?: boolean, ias?: number, groundSpoiler?: number }} state
 */
export function liftShare(state) {
  if (!state.onGround) return 1;
  const v = clamp01((state.ias || 0) / LIFT_SPEED);
  return v * v * (1 - DUMP * clamp01(state.groundSpoiler || 0));
}

/**
 * The wingtip's deflection above the model's shape (the wing on the ground, unloaded), metres: the 1 g deflection
 * times the load factor of a coordinated turn and the lift share, plus a small shake near the wing's first bending
 * frequency scaled by the turbulence, on presentation time `wallS` (off with reduced motion or `shake: false`).
 * @param {{ onGround?: boolean, roll?: number, ias?: number, groundSpoiler?: number, turbulence?: number }} state
 * @param {{ flex: { tipDeflection1g: number, frequencyHz: number } }} rig
 * @param {number} wallS presentation time, seconds
 * @param {{ reducedMotion?: boolean, shake?: boolean, side?: number }} [o] side: -1 left, +1 right (a phase offset)
 */
export function flexTip(state, rig, wallS, { reducedMotion = false, shake = true, side = 1 } = {}) {
  const lift = liftShare(state);
  const n = state.onGround ? 1 : 1 / Math.max(0.4, Math.cos(state.roll || 0));
  let tip = rig.flex.tipDeflection1g * n * lift;
  const turb = clamp01(state.turbulence || 0);
  if (shake && !reducedMotion && turb > 0 && lift > 0) {
    // the first bending mode, a slower gust and a third incommensurate tone: never periodic to the eye
    const f = rig.flex.frequencyHz, w = 2 * Math.PI * (Number.isFinite(wallS) ? wallS : 0), ph = side > 0 ? 0 : 1.7;
    const s = 0.6 * Math.sin(w * f + ph) + 0.25 * Math.sin(w * f * 1.618 + 1.3 + ph) + 0.4 * Math.sin(w * 0.31 + 0.5 + ph * 0.3);
    tip += SHAKE_M * turb * lift * s;
  }
  return tip;
}

/**
 * How far to turn the aircraft nose down about the main wheels so its nose wheel stands on the runway (radians, 0 or
 * negative): the model sits at rig.groundPitchDeg on its gear, while the track gives the body level once the nose is
 * down. A raised nose (the flare, the touchdown on the main wheels) is left alone, with a smooth blend over the first
 * degree so a derotation does not jump.
 * @param {{ onGround?: boolean, pitch?: number, gear?: number }} state  pitch in radians
 * @param {{ groundPitchDeg: number }} rig
 */
export function groundPitchCorrection(state, rig) {
  if (!state.onGround || !(state.gear > 0.5)) return 0;
  const g = rig.groundPitchDeg * DEG, p = state.pitch || 0;
  if (p <= 0) return g - p < 0 ? g - p : 0;
  const keep = smoothstep(0, 1 * DEG, p);
  return keep >= 1 ? 0 : g * (1 - keep);
}
