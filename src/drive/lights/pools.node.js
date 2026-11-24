// The lamp pool map around the car on plan 01's renderer (plan 02, D5.4 and section 7.8; third stretch, decisions 2
// and 6): pools.js's factory and methods, with its surface term written in TSL for surfaceLight.node.js. The ring,
// its window, workers and tile cache are poolRing.js's, shared with the classic renderer.
//
// The term is an illuminance: E = sum over the four channels of lux x weight, where each weight is the colour of the
// class (luminance 1) x the lit share of the slice x the warm-up flux x the display's fade, worked out per frame on
// the CPU (lights/index.js poolWeights). surfaceLight.node.js reflects it as albedo x E / pi x the light scale (the
// pre-exposure in the shipped look), so no unit is applied here. Buildings take a share on walls (WALL) and roofs
// (ROOF), the ground by its normal's tilt, exactly as pools.js: the map holds illuminance on level ground.
//
// Programs: the two terms (ground, building) are made once per pool map and shared by every material they are added
// to, so all the ground materials keep one program between them (surfaceLight.node.js, "Programs").

import { uniform, texture, vec2, vec3, float, min, clamp, mix, smoothstep, select } from 'three/tsl';
import { POOL_TILE_PX } from './poolTile.js';
import { addSurfaceTerm } from './surfaceLight.node.js';
import { RING, poolWindow, createPoolRing } from './poolRing.js';

export { RING, poolWindow };
const WALL = 0.5, ROOF = 0.35;

/**
 * @param {{ renderer: object, pack: object, createWorker?: () => Worker, workers?: number, tilePx?: number,
 *   photometry?: { display?: 'classic' | 'physical', nodes?: object } }} opts  as pools.js; photometry: the light
 *   scale's context (photometry.node.js), given to every material the term is added to
 */
export function createPools({ renderer, pack, createWorker, workers = 2, tilePx = POOL_TILE_PX, photometry = {} }) {
  const r = createPoolRing({ renderer, pack, createWorker, workers, tilePx });
  const uRect = uniform(r.rect).setName('uLampPoolRect');
  const uSpec = uniform(r.spec).setName('uLampPoolSpec');
  const uW = r.weights.map((w, i) => uniform(w).setName(`uLampPoolW${i}`));
  const ring = texture(r.ring);

  /** The pool's lux on a surface (pools.js termBody), for 'ground' or 'building'. */
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
    /** Channel weights (dimensionless: colour x lit share x warm-up x fade), each [r, g, b]. */
    setWeights: r.setWeights,
    /** The lux the shown map holds per channel at map (x, y) (poolRing.js), or null. */
    channelsAt: r.channelsAt,
    whenSettled: r.whenSettled,
    stats: r.stats,
    dispose: r.dispose,
  };
}
