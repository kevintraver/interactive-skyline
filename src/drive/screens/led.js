// The LED skins' content program mirrored in JavaScript, for the screens registry: the colour a point of an LED
// surface shows at a moment, and the mean over a surface from a fixed set of samples. The program is plan 01's (in TSL,
// src/render/materials/buildingMaterial.js, buildingNodes, the landmark variant; and in GLSL for its classic renderer,
// src/render/legacy/materials.js, ledGlow, until its phase 3), and this copy is held to it by
// tests/unit/screens/led.test.js, so a change there fails the test until the mirror follows. It is not changed here.
//
// The shader works in float32; every step here is rounded to float32 (Math.fround) the same way, so the
// lattice hashes agree with the GPU's wherever the GPU rounds as IEEE single precision does (it may fuse a
// multiply and an add, so single points can differ; means over hundreds of points agree to well under 1%).
//
// ledColor is the pattern at level 1 (colour x pulse). What the skin emits is that times ledScale: cd/m^2, plan 01's
// ledCdM2(switchOn.signs) (1,200 cd/m^2 by day, dimmed to 3 % at night), as the building material draws it.

import { ledCdM2 } from '../../render/photometry.js';

const f = Math.fround;
const TAU = f(6.2832);
const fract = (x) => f(x - Math.floor(x));

/** nightHash(vec2 p) of night.js, in float32. */
export function nightHash(px, py) {
  let x = fract(f(px * f(123.34))), y = fract(f(py * f(456.21)));
  const d = f(f(x * f(x + f(45.32))) + f(y * f(y + f(45.32))));
  x = f(x + d); y = f(y + d);
  return fract(f(x * y));
}

const ledHash = (x, y, z) => nightHash(f(x + f(z * f(7.13))), f(y + f(z * f(3.71))));
const mix = (a, b, t) => f(a + f(f(b - a) * t));

/** ledNoise(vec3 p) of night.js: value noise on the unit lattice, smoothstep-faded. */
export function ledNoise(px, py, pz) {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let fx = f(px - ix), fy = f(py - iy), fz = f(pz - iz);
  fx = f(f(fx * fx) * f(3 - f(2 * fx)));
  fy = f(f(fy * fy) * f(3 - f(2 * fy)));
  fz = f(f(fz * fz) * f(3 - f(2 * fz)));
  const a = mix(ledHash(ix, iy, iz), ledHash(ix + 1, iy, iz), fx);
  const b = mix(ledHash(ix, iy + 1, iz), ledHash(ix + 1, iy + 1, iz), fx);
  const c = mix(ledHash(ix, iy, iz + 1), ledHash(ix + 1, iy, iz + 1), fx);
  const d = mix(ledHash(ix, iy + 1, iz + 1), ledHash(ix + 1, iy + 1, iz + 1), fx);
  return mix(mix(a, b, fy), mix(c, d, fy), fz);
}

/**
 * What multiplies the pattern (ledColor, ledMean): cd/m^2 (see the header).
 * @param {{ signs?: number }} o  signs: the shared switchOn.signs uniform
 */
export function ledScale({ signs = 0 } = {}) {
  return ledCdM2(Math.min(1, Math.max(0, signs)));
}

/**
 * ledGlow() of night.js for one point with vLed = 1 and level 1: writes [r, g, b] into `out`.
 * @param {number} x @param {number} y @param {number} z  the point in the model's own coordinates (vNightPos)
 * @param {number} t content seconds (clock.js)
 */
export function ledColor(x, y, z, t, out = [0, 0, 0]) {
  t = f(t);
  const n = ledNoise(f(x * f(0.022)), f(f(y * f(0.022)) + f(f(-0.11) * t)), f(f(z * f(0.022)) + f(f(0.05) * t)));
  const band = f(f(f(f(y * f(0.018)) + f(f(x * f(0.009)) + f(z * f(0.006)))) - f(f(0.05) * t)) + f(f(0.7) * n));
  const pulse = f(0.65 + f(0.35 * f(Math.sin(f(TAU * f(f(2 * band) - f(f(0.07) * t)))))));
  out[0] = f(f(0.55 + f(0.45 * f(Math.cos(f(TAU * band))))) * pulse);
  out[1] = f(f(0.55 + f(0.45 * f(Math.cos(f(TAU * f(band + f(0.33))))))) * pulse);
  out[2] = f(f(0.55 + f(0.45 * f(Math.cos(f(TAU * f(band + f(0.67))))))) * pulse);
  return out;
}

const tmp = [0, 0, 0];
/**
 * Mean colour (level 1) over a surface given as sample points with weights (area shares summing to 1):
 * samples = Float32Array [x, y, z, w, x, y, z, w, ...]. Writes [r, g, b] into `out`.
 */
export function ledMean(samples, t, out = [0, 0, 0]) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < samples.length; i += 4) {
    ledColor(samples[i], samples[i + 1], samples[i + 2], t, tmp);
    const w = samples[i + 3];
    r += tmp[0] * w; g += tmp[1] * w; b += tmp[2] * w;
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

/**
 * Area-weighted samples of the faces of a non-indexed geometry whose `led` attribute is set: one sample per
 * face (its centroid) for up to `max` faces, else a deterministic stratified pick by cumulative area.
 * @param {Float32Array|number[]} pos positions, 9 numbers per triangle  @param {Float32Array|number[]} led one per vertex
 */
export function ledSamples(pos, led, max = 256) {
  const faces = [];
  let total = 0;
  for (let v = 0; v + 2 < led.length; v += 3) {
    if (!(led[v] > 0)) continue;
    const o = v * 3;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    if (!(area > 0)) continue;
    faces.push([o, area]);
    total += area;
  }
  if (!faces.length) return { samples: new Float32Array(0), area: 0, centre: [0, 0, 0] };
  const pick = [];
  if (faces.length <= max) for (const [o, a] of faces) pick.push([o, a / total]);
  else {
    // stratified: the face under each of `max` evenly spaced points of the cumulative area
    let acc = 0, k = 0;
    for (const [o, a] of faces) {
      acc += a;
      while (k < max && (k + 0.5) / max * total <= acc) { pick.push([o, 1 / max]); k++; }
    }
  }
  const samples = new Float32Array(pick.length * 4);
  const centre = [0, 0, 0];
  pick.forEach(([o, w], i) => {
    for (let c = 0; c < 3; c++) {
      samples[i * 4 + c] = (pos[o + c] + pos[o + 3 + c] + pos[o + 6 + c]) / 3;
      centre[c] += samples[i * 4 + c] * w;
    }
    samples[i * 4 + 3] = w;
  });
  return { samples, area: total, centre };
}


/**
 * The mean colour of an LED surface as a pure function of content time, cheap enough for every frame: the mean is
 * worked out exactly (ledMean over all the samples) at grid times k x step and interpolated linearly between them
 * (the program's mean moves at about 0.1 Hz, so a 1 s grid loses nothing visible). Grid points are filled ahead of
 * the clock a slice of samples per frame (advance), in the same order as a whole computation would take them, so a
 * value never depends on how it was filled; a point that is needed and not ready is filled at once (after a seek).
 * @param {Float32Array} samples ledSamples(...).samples  @param {{ step?: number, keep?: number }} [opts]
 */
export function createLedMeanCache(samples, { step = 1, keep = 8 } = {}) {
  const n = samples.length / 4;
  const done = new Map(); // k -> [r, g, b]
  let job = null; // { k, i, r, g, b }
  const tmp3 = [0, 0, 0];
  function run(j, upTo) {
    const t = j.k * step;
    for (; j.i < upTo; j.i++) {
      const o = j.i * 4;
      ledColor(samples[o], samples[o + 1], samples[o + 2], t, tmp3);
      const w = samples[o + 3];
      j.r += tmp3[0] * w; j.g += tmp3[1] * w; j.b += tmp3[2] * w;
    }
    if (j.i >= n) {
      done.set(j.k, [j.r, j.g, j.b]);
      while (done.size > keep) done.delete(done.keys().next().value);
      return true;
    }
    return false;
  }
  function point(k) {
    let v = done.get(k);
    if (v) return v;
    const j = job && job.k === k ? job : { k, i: 0, r: 0, g: 0, b: 0 };
    run(j, n);
    if (job === j) job = null;
    return done.get(k);
  }
  return {
    /** Mean colour (level 1) at content time t. */
    at(t, out = [0, 0, 0]) {
      const u = t / step, k = Math.floor(u), a = point(k), b = point(k + 1), x = u - k;
      for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * x;
      return out;
    },
    /** Fill the next grid point in the direction of travel, `budget` samples now. */
    advance(t, direction = 1, budget = 32) {
      const k = Math.floor(t / step) + (direction < 0 ? -1 : 2);
      if (done.has(k)) return;
      if (!job || job.k !== k) job = { k, i: 0, r: 0, g: 0, b: 0 };
      if (run(job, Math.min(n, job.i + budget))) job = null;
    },
    /** Samples a grid point costs. */
    get size() { return n; },
  };
}
