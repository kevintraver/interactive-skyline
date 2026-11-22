// Reads the night-lights grids (scripts/build_nightlights.py; plan 01, T4.4 and section 11.7). Pure: decode and
// lookup only, no three.js and no fetch. The texture, toUV, drawn-mask and lamp-cell parts of the NightLights
// interface belong to the renderer and come with it.
//
// Each grid file holds a uint16 plane of radiance, R = (v / 256)^2 in nW cm-2 sr-1, then a uint8 plane of the
// off-nadir to near-nadir ratio x 64; row 0 = south, column 0 = west, on local metres (x east, y north). World
// coordinates are x east and z = -north (section 11.9).

export const decodeRadiance = (v) => (v / 256) * (v / 256);
export const encodeRadiance = (r) => Math.min(65535, Math.max(0, Math.round(Math.sqrt(Math.max(0, r)) * 256)));

/**
 * @param {{x0:number, y0:number, step:number, nx:number, ny:number}} spec one entry of nightlights.json `grids`
 * @param {ArrayBuffer | ArrayBufferView} data the bytes of nightlights-<grid>.bin
 */
export function decodeNightLightsGrid(spec, data, ratioScale = 64) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const n = spec.nx * spec.ny;
  if (bytes.byteLength !== 3 * n) throw new Error(`night-lights grid: ${bytes.byteLength} bytes, expected ${3 * n}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const radiance = new Float32Array(n);
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    radiance[i] = decodeRadiance(view.getUint16(2 * i, true));
    ratio[i] = bytes[2 * n + i] / ratioScale;
  }
  return { x0: spec.x0, y0: spec.y0, step: spec.step, nx: spec.nx, ny: spec.ny, radiance, ratio };
}

/** True when world (x, z) falls on the grid. */
export const gridContains = (g, x, z) => x >= g.x0 && x < g.x0 + g.nx * g.step && -z >= g.y0 && -z < g.y0 + g.ny * g.step;

/** Bilinear between cell centres of one plane at world (x, z); 0 off the grid. */
export function sampleGrid(g, plane, x, z) {
  if (!gridContains(g, x, z)) return 0;
  const fx = Math.min(Math.max((x - g.x0) / g.step - 0.5, 0), g.nx - 1);
  const fy = Math.min(Math.max((-z - g.y0) / g.step - 0.5, 0), g.ny - 1);
  const ix = Math.min(Math.floor(fx), g.nx - 2), iy = Math.min(Math.floor(fy), g.ny - 2);
  const ax = fx - ix, ay = fy - iy;
  const at = (c, r) => plane[r * g.nx + c];
  return (at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax) * (1 - ay) + (at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax) * ay;
}

/**
 * Garstang's direct-upward fraction F for everything but street lamps, from the off-nadir ratio: 0.05 at a ratio
 * of 1 (light leaves as it would from a flat lit surface), rising to 0.20 at 2 and above (section 7.8). Provisional
 * until calibrate_skyglow.py (T4.7) fits it.
 */
export const upwardFraction = (ratio) => Math.min(0.2, Math.max(0.05, 0.05 + 0.15 * (ratio - 1)));

/**
 * The data half of section 11.7's NightLights.
 * @param {{ meta: object, metro: ReturnType<typeof decodeNightLightsGrid>, region?: ReturnType<typeof decodeNightLightsGrid>, k?: number }} o
 *   k: nW cm-2 sr-1 per cd/m2 toward the zenith; defaults to meta.calibration.k, set by T4.7
 */
export function createNightLights({ meta, metro, region = null, k = meta?.calibration?.k ?? null }) {
  const G = meta?.calibration?.G ?? 0.15;
  const pick = (x, z) => (gridContains(metro, x, z) ? metro : region && gridContains(region, x, z) ? region : null);
  const radiance = (x, z) => {
    const g = pick(x, z);
    return g ? sampleGrid(g, g.radiance, x, z) : 0;
  };
  const offNadirRatio = (x, z) => {
    const g = pick(x, z);
    return g ? sampleGrid(g, g.ratio, x, z) : 1;
  };
  const needK = () => {
    if (!(k > 0)) throw new Error('night lights: the radiance-to-luminance constant k is not calibrated yet (T4.7)');
    return k;
  };
  const baseRadiance = radiance; // no registered emitters yet (T4.5 subtracts them)
  const upwardLuminance = (x, z) => baseRadiance(x, z) / needK();
  // Garstang: i(0) = GLE * 2G(1 - F) / 2pi, so GLE = pi * i(0) / (G (1 - F))
  const groundEmission = (x, z) => (Math.PI * upwardLuminance(x, z)) / (G * (1 - upwardFraction(offNadirRatio(x, z))));
  return { radiance, baseRadiance, offNadirRatio, upwardLuminance, groundEmission, metro, region };
}
