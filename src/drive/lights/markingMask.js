// The road's marking mask for retroreflection (plan 02, D5.2), read from the road atlas at run time.
//
// The road material draws lane lines, edge lines and gore chevrons from one canvas atlas (roadnet/atlas.js) whose
// layout and colours belong to the road's own code. Rather than assume where the lines are, the mask is made from
// the atlas' pixels when the part starts: from its night (emissive) map when there is one, where the atlas marks
// what is retroreflective as bright and everything else as dark, otherwise from the day map, where paint is the
// lightest thing. Each texel becomes [white paint coverage, yellow paint coverage, 0, 255]; the barrier reflectors'
// region (REGIONS.reflector, when the atlas exports it) is left out, since those carry their own `retro` attribute.
// The mask is sampled at the same uv as the road's map (vMapUv) with the same wrapping and mipmaps, so a line far away
// averages into its asphalt as the colour map does and the coverage stays right at any distance.

/** Brightness ramps (8-bit max channel) from no paint to full paint, by source, when the atlas names no paint colours. */
export const MASK_RAMPS = Object.freeze({ night: [178, 229], day: [172, 215] });

/**
 * The ramp for a paint colour ('#rrggbb', the atlas' PAINT white): full coverage at 97% of its brightest channel,
 * none below LOW[source] of that. Below the ramp lies everything else the atlas draws: on the night map asphalt and
 * concrete are far darker than paint; by day the light concrete of structures comes within 80% of it, hence the
 * narrower day ramp.
 */
const LOW = { night: 0.78, day: 0.88 };
export function rampOf(hex, source = 'night') {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const mx = Math.max(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  return [(LOW[source] || LOW.night) * 0.97 * mx, 0.97 * mx];
}

/**
 * Classify RGBA pixels into a mask. Pure.
 * @param {Uint8ClampedArray|Uint8Array} rgba  @param {number} width  @param {number} height
 * @param {{ source?: 'night'|'day', skip?: Array<[number, number]>, ramp?: number[] }} [opts] skip: [x0, x1) pixel columns
 *   to leave empty; ramp: [lo, hi] brightness of no paint and full paint (default MASK_RAMPS[source])
 * @returns {Uint8Array} RGBA mask
 */
export function classifyMarkings(rgba, width, height, { source = 'night', skip = [], ramp = null } = {}) {
  const [lo, hi] = ramp || MASK_RAMPS[source] || MASK_RAMPS.night;
  const out = new Uint8Array(width * height * 4);
  const skipCol = new Uint8Array(width);
  for (const [a, b] of skip) for (let x = Math.max(0, a); x < Math.min(width, b); x++) skipCol[x] = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i + 3] = 255;
      if (skipCol[x]) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const mx = Math.max(r, g, b);
      const cov = Math.min(Math.max((mx - lo) / (hi - lo), 0), 1);
      if (!cov) continue;
      const yellow = Math.min(Math.max(((r - b) / Math.max(r, 1) - 0.25) / 0.4, 0), 1);
      out[i] = Math.round(255 * cov * (1 - yellow));
      out[i + 1] = Math.round(255 * cov * yellow);
    }
  }
  return out;
}

/** The pixels of a texture's image (canvas, ImageBitmap, image or DataTexture image), or null. */
export function pixelsOf(image) {
  if (!image) return null;
  const { width, height } = image;
  if (!width || !height) return null;
  if (image.data && image.data.length === width * height * 4) return { data: image.data, width, height };
  let ctx = null;
  try { ctx = typeof image.getContext === 'function' ? image.getContext('2d') : null; } catch { ctx = null; }
  if (!ctx) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height)
      : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width, height }) : null;
    ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
  }
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

/**
 * The mask for a set of road materials (roadnet/material.js's result), as RGBA bytes, or null when no atlas image can
 * be read. @param {{ map?: object, nightMap?: object }} materials
 * @param {{ reflector?: number[] }|null} regions REGIONS of roadnet/atlas.js in the image's pixel columns
 * @param {{ day?: { white: string }, night?: { white: string } }|null} paint the atlas' PAINT colours, when it exports them
 */
export function markingMaskOf(materials, regions, paint = null) {
  const night = pixelsOf(materials?.nightMap?.image);
  const src = night || pixelsOf(materials?.map?.image);
  if (!src) return null;
  const source = night ? 'night' : 'day';
  const skip = regions?.reflector ? [regions.reflector] : [];
  const ramp = rampOf(paint?.[source]?.white, source);
  return { data: classifyMarkings(src.data, src.width, src.height, { source, skip, ramp }), width: src.width, height: src.height, source };
}
