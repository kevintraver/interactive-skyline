// The lamp pool map around the car (plan 02, D5.4; section 7.8), and its term on the drive's surfaces, on the classic
// renderer (pools.node.js is plan 01's). The ring, its window, workers and cache are poolRing.js's:
//
// A ring texture of RING x RING tiles (POOL_TILE_M metres, POOL_TILE_PX texels each: 2048 m at 2 m per texel),
// RGBA half floats in lux, one channel per light class and switching slice (poolTile.js). Tile (ti, tj) always sits
// in ring slot (ti mod RING, tj mod RING), so the texture is read with repeat wrapping at map / (RING x tile) and
// moving the window only replaces the tiles that left it. The window is RING x RING tiles centred on the car's
// position snapped to the tile grid, so what is drawn is a function of where the car is, not of the way it came.
// Tiles are splatted in workers (pools.worker.js) and kept in a small cache; a window shows once all its tiles are
// in, and until then the part of the last complete window that the new one shares.
//
// The surface term (surfaceLight.js) adds albedo x E / pi with E = sum over channels of lux x weight, where each
// weight is the colour of the class x the lit share of the slice x the warm-up flux x lighting.units.lux x the dusk
// fade, worked out per frame on the CPU (setWeights). Buildings take a share on walls (WALL) and roofs (ROOF):
// the map holds illuminance on level ground.

import { POOL_TILE_PX } from './poolTile.js';
import { addSurfaceTerm } from './surfaceLight.js';
import { RING, poolWindow, createPoolRing } from './poolRing.js';

export { RING, poolWindow };
const WALL = 0.5, ROOF = 0.35;

const TERM_HEAD = /* glsl */ `
uniform sampler2D uLampPool;
uniform vec4 uLampPoolRect;   // x0, y0, x1, y1 of the shown window (map metres)
uniform vec4 uLampPoolSpec;   // 1 / ring size (m), edge fade (m), on (0/1), unused
uniform vec3 uLampPoolW[4];   // weight of each channel (colour x lit share x warm-up x units x fade)`;

const termBody = (surface) => /* glsl */ `
if ( uLampPoolSpec.z > 0.5 ) {
  vec2 slMap = vec2( slWorld.x, -slWorld.z );
  vec2 slIn = min( slMap - uLampPoolRect.xy, uLampPoolRect.zw - slMap );
  float slFade = clamp( min( slIn.x, slIn.y ) / uLampPoolSpec.y, 0.0, 1.0 );
  if ( slFade > 0.0 ) {
    vec4 slP = texture( uLampPool, slMap * uLampPoolSpec.x );
    vec3 slPool = slP.r * uLampPoolW[0] + slP.g * uLampPoolW[1] + slP.b * uLampPoolW[2] + slP.a * uLampPoolW[3];
    ${surface === 'building' ? `slPool *= mix( ${WALL.toFixed(2)}, ${ROOF.toFixed(2)}, smoothstep( 0.5, 0.9, slNormal.y ) );` : 'slPool *= clamp( slNormal.y * 1.5, 0.0, 1.0 );'}
    slE += slPool * slFade;
  }
}`;

/**
 * @param {{ renderer: THREE.WebGLRenderer, pack: object, createWorker?: () => Worker, workers?: number, tilePx?: number }} opts
 *   pack: the decoded lamp product (pack.js), sent to the workers once (poolRing.js holds the window, the workers and
 *   the ring)
 */
export function createPools({ renderer, pack, createWorker, workers = 2, tilePx = POOL_TILE_PX }) {
  const r = createPoolRing({ renderer, pack, createWorker, workers, tilePx });
  const uniforms = {
    uLampPool: { value: r.ring },
    uLampPoolRect: { value: r.rect },
    uLampPoolSpec: { value: r.spec },
    uLampPoolW: { value: r.weights },
  };
  const terms = {
    ground: { id: 'lampPools', key: 'ground-v1', uniforms, head: TERM_HEAD, body: termBody('ground') },
    building: { id: 'lampPools', key: 'building-v1', uniforms, head: TERM_HEAD, body: termBody('building') },
  };
  return {
    uniforms, terms, ring: r.ring,
    /** Add the pool term to a material: surface 'ground' (road, terrain) or 'building'. Returns a remover. */
    attach(material, surface = 'ground') { return addSurfaceTerm(material, terms[surface] || terms.ground); },
    /** Follow the car (map metres). Off, nothing is requested and the term draws nothing. */
    update: r.update,
    /** Channel weights (scene irradiance per lux), each [r, g, b]. */
    setWeights: r.setWeights,
    channelsAt: r.channelsAt,
    whenSettled: r.whenSettled,
    stats: r.stats,
    dispose: r.dispose,
  };
}
