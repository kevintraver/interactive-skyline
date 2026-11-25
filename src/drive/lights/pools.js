// The lamp pool map around the car (plan 02, D5.4 and section 7.8; third stretch, decision 6), and its term on the
// drive's surfaces through surfaceLight.js. The ring, its window, workers and tile cache are poolRing.js's.
//
// The term is an illuminance: E = sum over the four channels of lux x weight, where each weight is the colour of the
// class (luminance 1) x the lit share of the slice x the warm-up flux, worked out per frame on the CPU (lights/index.js
// poolWeights). surfaceLight.js reflects it as albedo x E / pi x the light scale (the pre-exposure), so no unit
// is applied here. Buildings take a share on walls (WALL) and roofs (ROOF), the ground by its normal's tilt: the map
// holds illuminance on level ground.
//
// Programs: the two terms (ground, building) are made once per pool map and shared by every material they are added
// to, so all the ground materials keep one program between them (surfaceLight.js, "Programs").

import { uniform, texture, vec2, vec3, float, min, clamp, mix, smoothstep, select } from 'three/tsl';
import { POOL_TILE_PX } from './poolTile.js';
import { addSurfaceTerm } from './surfaceLight.js';
import { RING, poolWindow, createPoolRing } from './poolRing.js';

export { RING, poolWindow };
const WALL = 0.5, ROOF = 0.35;

/**
 * @param {{ renderer: object, pack: object, createWorker?: () => Worker, workers?: number, tilePx?: number,
 *   photometry?: { nodes?: object } }} opts  pack: the lamp product (pack.js); createWorker, workers: the splatting
 *   workers (default pools.worker.js, two); tilePx: texels along a tile; photometry: the light scale's context
 *   (photometry.js), given to every material the term is added to
 */
export function createPools({ renderer, pack, createWorker, workers = 2, tilePx = POOL_TILE_PX, photometry = {} }) {
  const r = createPoolRing({ renderer, pack, createWorker, workers, tilePx });
  const uRect = uniform(r.rect).setName('uLampPoolRect');
  const uSpec = uniform(r.spec).setName('uLampPoolSpec');
  const uW = r.weights.map((w, i) => uniform(w).setName(`uLampPoolW${i}`));
  const ring = texture(r.ring);

  /** The pool's lux on a surface, for 'ground' or 'building'. */
  const luxOf = (surface) => ({ positionWorld, normalWorld }) => {
    const map = vec2(positionWorld.x, positionWorld.z.negate());
    const inside = min(map.sub(uRect.xy), uRect.zw.sub(map));
    const fade = clamp(min(inside.x, inside.y).div(uSpec.y), 0, 1);
    const p = ring.sample(map.mul(uSpec.x));
    const pool = uW[0].mul(p.r).add(uW[1].mul(p.g)).add(uW[2].mul(p.b)).add(uW[3].mul(p.a));
    const tilt = surface === 'building'
      ? mix(float(WALL), float(ROOF), smoothstep(0.5, 0.9, normalWorld.y))
      : clamp(normalWorld.y.mul(1.5), 0, 1);
    return select(uSpec.z.greaterThan(0.5), pool.mul(tilt).mul(fade), vec3(0));
  };
  const terms = {
    ground: { id: 'lampPools', key: 'ground-v1', lux: luxOf('ground') },
    building: { id: 'lampPools', key: 'building-v1', lux: luxOf('building') },
  };

  return {
    terms, ring: r.ring, tilePx,
    /** Add the pool term to a node material: surface 'ground' (road, terrain) or 'building'. Returns a remover. */
    attach(material, surface = 'ground') { return addSurfaceTerm(material, terms[surface] || terms.ground, { photometry }); },
    /** Follow the car (map metres). Off, nothing is requested and the term draws nothing. */
    update: r.update,
    /** Channel weights (dimensionless: colour x lit share x warm-up), each [r, g, b]. */
    setWeights: r.setWeights,
    /** The lux the shown map holds per channel at map (x, y) (poolRing.js), or null. */
    channelsAt: r.channelsAt,
    whenSettled: r.whenSettled,
    stats: r.stats,
    dispose: r.dispose,
  };
}
