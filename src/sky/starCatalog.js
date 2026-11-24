// Decodes public/data/sky/stars.bin (scripts/build_stars.py; plan 01, T4.1) into typed arrays. Pure: no three.js,
// no fetch, so the star renderer, tests and tools share it.
//
// Record, 12 bytes, little-endian: int16 x3 J2000 unit vector x 32767 (x to RA 0h, y to RA 6h, z to the north
// celestial pole), int16 V in millimagnitudes, uint8 x3 linear-sRGB colour (largest channel 255), uint8 flags.

export const STAR_RECORD_BYTES = 12;
export const STAR_FLAGS = { variable: 1, multiple: 2, colourFromSpectralType: 4, colourDefault: 8 };

/**
 * @param {ArrayBuffer | ArrayBufferView} data the bytes of stars.bin
 * @returns {{ count: number, direction: Float32Array, vmag: Float32Array, color: Float32Array, flags: Uint8Array }}
 *   direction and color hold three numbers per star, renormalised direction and colour in 0..1
 */
export function decodeStars(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength % STAR_RECORD_BYTES) throw new Error(`stars.bin: ${bytes.byteLength} bytes is not a whole number of records`);
  const count = bytes.byteLength / STAR_RECORD_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const direction = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const vmag = new Float32Array(count);
  const flags = new Uint8Array(count);
  for (let i = 0, o = 0; i < count; i++, o += STAR_RECORD_BYTES) {
    const x = view.getInt16(o, true), y = view.getInt16(o + 2, true), z = view.getInt16(o + 4, true);
    const n = Math.hypot(x, y, z) || 1;
    direction[i * 3] = x / n; direction[i * 3 + 1] = y / n; direction[i * 3 + 2] = z / n;
    vmag[i] = view.getInt16(o + 6, true) / 1000;
    color[i * 3] = bytes[o + 8] / 255; color[i * 3 + 1] = bytes[o + 9] / 255; color[i * 3 + 2] = bytes[o + 10] / 255;
    flags[i] = bytes[o + 11];
  }
  return { count, direction, vmag, color, flags };
}

/** J2000 right ascension and declination in degrees to the unit vector the catalogue uses. */
export function raDecToVector(raDeg, decDeg) {
  const a = (raDeg * Math.PI) / 180, d = (decDeg * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
