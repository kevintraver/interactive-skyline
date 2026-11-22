// Counter-based randomness: rand(seed, ...keys) is a pure function, so anything drawn from it is the same
// however a moment is reached (play, scrub, deep link). Keys are integers, other numbers or strings.

const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);

/** 32-bit integer mixer ("lowbias32", Chris Wellons): every input bit affects every output bit. */
function mix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

function absorb(h, key) {
  if (typeof key === 'string') {
    h = mix(h ^ 0x9e3779b9 ^ key.length);
    for (let i = 0; i < key.length; i++) h = mix(h ^ key.charCodeAt(i));
    return h;
  }
  if (Number.isInteger(key) && Math.abs(key) <= 0x7fffffff) return mix(h ^ (key | 0));
  f64[0] = Number(key);
  return mix(mix(h ^ u32[0]) ^ u32[1]);
}

/** A 32-bit unsigned hash of a seed and any number of keys. */
export function hash32(seed, ...keys) {
  let h = mix((seed | 0) ^ 0x2545f491);
  for (const k of keys) h = absorb(h, k);
  return h;
}

/** A float in [0, 1) that depends only on the seed and the keys. */
export const rand = (seed, ...keys) => hash32(seed, ...keys) / 4294967296;
