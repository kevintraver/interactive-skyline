// Rolling timings of the drive's own per-frame JavaScript. Frame time as a whole means nothing under a
// software renderer, so this is what tests bound.

/** @param {number} [size] how many recent samples to keep */
export function createTimings(size = 240) {
  const buf = new Float64Array(size);
  let n = 0, next = 0, last = 0;
  return {
    /** Add one sample, milliseconds. */
    add(ms) {
      last = ms;
      buf[next] = ms;
      next = (next + 1) % size;
      if (n < size) n++;
    },
    reset() { n = 0; next = 0; last = 0; },
    /** { count, last, mean, p95, max } over the window, milliseconds. */
    summary() {
      if (!n) return { count: 0, last: 0, mean: 0, p95: 0, max: 0 };
      const xs = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      return { count: n, last, mean, p95: xs[Math.min(n - 1, Math.ceil(0.95 * n) - 1)], max: xs[n - 1] };
    },
  };
}
