// Hashes and low-discrepancy sequences for vehicle slots (plan 02, section 5.8).
//
// Two kinds of number per slot k:
//   - presence comes from the golden-ratio Weyl sequence (the best-distributed one in one dimension):
//     consecutive k fill [0,1) evenly, so thinning slots by a slowly varying threshold keeps counts
//     within a vehicle or two of the expectation, hour by hour (random hashes miss by several %);
//   - the class (truck or not) from a second Weyl sequence, on sqrt(2), so trucks are spread evenly
//     too and do not line up with presence;
//   - cosmetic choices (body, colour, jitter phase) come from an integer hash, so neighbours differ.

const GOLD = 0.6180339887498949; // (sqrt 5 - 1) / 2
const ROOT2 = 0.41421356237309515; // sqrt 2 - 1

const frac = (x) => x - Math.floor(x);

// Each stream (direction and lane) starts its sequences at an offset of its own. The offset must not
// be a multiple of the step (salt * (1 - GOLD) would make every lane the same sequence shifted by a
// slot, so their count errors would add up instead of cancelling).
const offset = (salt, m) => (((Math.imul(salt + 1, 0x9e3779b1) ^ m) >>> 0) % 1000003) / 1000003;

/** Presence coordinate of slot k in stream `salt` (0..1). */
export const presenceU = (k, salt) => frac(k * GOLD + offset(salt, 0x5bd1e995));
/** Class coordinate of slot k in stream `salt` (0..1); truck when below the stream's truck share. */
export const classV = (k, salt) => frac(k * ROOT2 + offset(salt, 0x27d4eb2f));

/** 32-bit integer hash of a slot (k may exceed 2^32) and a salt. */
export function hash32(k, salt = 0) {
  const lo = k % 4294967296;
  const hi = (k - lo) / 4294967296;
  let h = Math.imul((lo | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(hi | 0, 0x27d4eb2f) ^ Math.imul(salt + 1, 0x165667b1);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform 0..1 from a hash. */
export const unit = (h) => h / 4294967296;
