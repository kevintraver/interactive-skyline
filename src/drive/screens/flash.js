// The flash-rate limit of plan 02, section 4.11 ("no full-field flashing above 3 Hz in generic screen content"),
// as a measurement that the tests run over every content program.
//
// The measure, after the general flash threshold of WCAG 2.x (2.3.1) and ITU-R BT.1702:
//  - the signal is the screen's mean relative luminance over its area, Y = 0.2126 R + 0.7152 G + 0.0722 B of the
//    linear content colour, normalised by the program's peak luminance (the brightest it can show), sampled at
//    60 Hz of real time (so at a playback rate r, every 1 / (60 r) simulated seconds);
//  - a transition is a change of Y by at least 10% of the peak in one direction (the luminance has to rise or fall
//    by 0.1 from its last extreme before it counts again: hysteresis, so noise does not count);
//  - a flash is a pair of opposing transitions; the limit is at most 3 flashes, that is 6 transitions, in any
//    window of one second of real time.
// The worst count over all one-second windows of a run is the program's flash rate at that playback rate.

export const FLASH_LIMIT_HZ = 3;
export const FLASH_STEP = 0.1;
export const SAMPLE_HZ = 60;

/** Relative luminance of a linear RGB triple. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Times (s) of the transitions in a luminance series sampled every `dt` seconds (already normalised to 0..1).
 * @param {ArrayLike<number>} y  @param {number} dt  @param {number} [step]
 */
export function transitions(y, dt, step = FLASH_STEP) {
  const out = [];
  if (!y.length) return out;
  let lo = y[0], hi = y[0], dir = 0; // dir: +1 rising since the last low, -1 falling since the last high
  for (let i = 1; i < y.length; i++) {
    const v = y[i];
    if (v > hi) hi = v;
    if (v < lo) lo = v;
    if (dir >= 0 && hi - v >= step) { out.push(i * dt); dir = -1; lo = v; hi = v; }
    else if (dir <= 0 && v - lo >= step) { out.push(i * dt); dir = 1; lo = v; hi = v; }
  }
  return out;
}

/** The most flashes (pairs of transitions) in any one-second window. */
export function maxFlashesPerSecond(times) {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1) j++;
    best = Math.max(best, i - j + 1);
  }
  return best / 2;
}

/**
 * Run a program and measure it: `sample(tSim)` returns the mean linear [r, g, b] (normalised so that the
 * program's peak luminance is 1) at simulated content time tSim. Plays `seconds` of real time at `rate`.
 * @returns {{ flashesPerSecond: number, transitions: number, maxStepPerSecond: number }}
 *   maxStepPerSecond: the largest luminance change per second of real time between consecutive samples
 */
export function measureFlash(sample, { rate = 1, seconds = 30, t0 = 0 } = {}) {
  const n = Math.round(seconds * SAMPLE_HZ), dt = 1 / SAMPLE_HZ;
  const y = new Float64Array(n);
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    const c = sample(t0 + i * dt * rate);
    y[i] = luminance(c[0], c[1], c[2]);
    if (i) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]) * SAMPLE_HZ);
  }
  const times = transitions(y, dt);
  return { flashesPerSecond: maxFlashesPerSecond(times), transitions: times.length, maxStepPerSecond: maxStep };
}
