// Every street lamp from the air (plan 03, F6.4, section 7.11 "Lamps from the air"): the valley's inventory
// (public/data/<city>/lamps-drive.bin, the drive's own product) and the region's towns (lights-region.bin,
// scripts/build_flight_lights.py) as light points in one draw, from cruise to the runway.
//
// What is the drive's, imported and not changed: the pack's layout and cell culling (src/drive/lights/pack.js), the lamp
// types with their optics, colours and sodium warm-up (lamps.js), each lamp's photocell threshold and the switch-on
// table (switching.js), and the sprite layer (sprites.js): a lamp's intensity toward the eye from its optic, its own
// pool seen from afar, the flux-conserving sprite rule, physical units through env.nodes. So a lamp switches on at the
// same moment and with the same colour whether it is seen from the car or from the aircraft.
//
// What is the flight's: which cells are drawn and how many of their lamps (thin.js: thinning with the light kept and
// no pop), the heights the lamps stand at (the regional terrain's, refreshed when finer grids arrive), and the air the
// light crosses (extinction.js, set by the caller each frame as `visibility`, an extinction length).

import { Frustum, Matrix4, Vector2 } from 'three';
import { curveDrop } from '../../world/frame.js';
import { decodeLampPack, cullCells, BOUND_STRIDE } from '../../drive/lights/pack.js';
import { createLampTypes, LUMINAIRE_DIAMETER_M } from '../../drive/lights/lamps.js';
import { switchThresholdLux } from '../../drive/lights/switching.js';
import { createSpriteLayer } from '../../drive/lights/sprites.js';
import { photometryContext } from '../../drive/lights/photometry.js';
import { hashOrder, cellScreenArea, drawShares, writeDrawList } from './thin.js';

/** Sprites drawn at most, by quality level (the drive's lampDetail: plan 02, 9.1). */
export const AIR_BUDGET = Object.freeze({ low: 20000, high: 80000, ultra: 250000 });
/** At most this many drawn lamps per pixel of a cell's area on screen (the drive's SCREEN_DENSITY). */
export const AIR_DENSITY = 0.25;
/** Lamp heads stand this much higher than the terrain says (m): the far terrain is drawn with coarser triangles. */
export const HEAD_LIFT_M = 3;
/** Reflectance of the ground under a lamp, for its pool seen from afar (the drive's GROUND_ALBEDO). */
export const GROUND_ALBEDO = 0.15;
/**
 * All the outdoor light a city sends up over what its street lamps send up: 5, street lamps a fifth of it. Kyba et al.
 * (2021, Lighting Research & Technology; Tucson changed its street lights' output over ten nights and the VIIRS day-
 * night band measured the difference) found street lights 18 % of the city's light at full output (95 % CI 15 to
 * 23 %), 21 % with other owners' street lights, and 13 % after midnight with the city's dimmed; the rest is parking
 * lots, signs, buildings and homes. The valley's inventory holds every owner's street lamps and the flights land in the
 * evening, so 1 / 0.21 to 1 / 0.18: 4.8 to 5.6 (checked in F8.1, 25 Nov 2026; this comment cited the 13 % before).
 * Las Vegas's casinos make its share of other light larger than Tucson's, so 5 is the low side. From the air each
 * lamp's pool stands for its neighbourhood's light (the plan's per-cell calibration against the satellite's radiance,
 * section 7.11, would replace this one number; plan 01's radiance grids are not built in this checkout).
 */
export const ALL_LIGHT_FACTOR = 5;
/**
 * Where a lamp's pool, and its neighbourhood's light, joins its point (m from the eye; the sprite layer's uGlowRange,
 * a smooth step). Nearer than the start the ground's light is not drawn: a pool there is a patch metres across, not a
 * point, and the neighbourhood's own lights are not in the inventory, so drawing them into the lamp's point would make
 * it a beacon. By the end they are all in it. On final the nearest ground a side window shows is about a kilometre
 * away. (The drive starts at 800 m and ends at 1,000 m, with its own pools nearer; the flight has no pools.)
 */
export const POOL_RANGE_M = Object.freeze([300, 2500]);
const TURN_COS = Math.cos((0.3 * Math.PI) / 180);
/** The draw list is rewritten when the eye has moved this share of its height above the ground (at least 2 m). */
export const REBUILD_SHARE = 0.002;

/**
 * @param {{ packs: Array<{ meta: object, buffer: ArrayBuffer, name: string }>, heightAt: (x: number, y: number) => number,
 *   base: number, earthR: number, nodes?: object, level?: string }} o
 *   packs: lamp packs in the drive's layout; heightAt: metres above sea level of the ground at map (x, y); base: the
 *   city's base (scene y 0); nodes: env.nodes (the pre-exposure and the lights-out slider); level: the quality level
 */
export function createAirLamps({ packs, heightAt, base, earthR, nodes = null, level = 'high' }) {
  const decoded = packs.map((p) => ({ name: p.name, pack: decodeLampPack(p.meta, p.buffer) }));
  const types = createLampTypes(decoded[0].pack.lampTypes);
  const total = decoded.reduce((a, d) => a + d.pack.count, 0);
  const photometry = photometryContext(nodes ? { nodes } : {});
  const layer = createSpriteLayer({ capacity: Math.max(1, total), name: 'flight-lamps', photometry });
  layer.mesh.visible = false;
  layer.mesh.renderOrder = 10;
  const patternOf = new Map(types.list.map((t) => [t.id, layer.definePattern({ kind: t.optic, kDown: t.kDown, kUp: t.kUp, downShare: 1 - t.uplight })]));
  const sodium = types.list.find((t) => t.cls === 'sodium');
  const sodiumUv = sodium ? { startUv: sodium.warmup(0).uv, steadyUv: sodium.steadyUv } : null;

  // texels: each pack's cells in order, each cell's lamps in hash order; `src` maps a texel to [pack, index]
  const srcPack = new Uint8Array(total), srcIndex = new Uint32Array(total);
  const cellFirst = [], cellCount = [];
  let base0 = 0;
  const pos = [0, 0, 0];
  decoded.forEach((d, p) => {
    const { pack } = d;
    const nCells = pack.nx * pack.ny;
    const order = hashOrder(pack.cellStart, nCells);
    for (let t = 0; t < pack.count; t++) {
      const i = order[t];
      const texel = base0 + t;
      srcPack[texel] = p; srcIndex[texel] = i;
      const type = types.byId.get(pack.type[i]) || types.list[0];
      pos[0] = pack.x[i]; pos[1] = 0; pos[2] = -pack.y[i];
      layer.set(texel, {
        position: pos, color: type.color, intensity: pack.lumens[i], pattern: patternOf.get(type.id), axis: [0, -1, 0],
        aim: Number.isFinite(pack.aim[i]) ? (pack.aim[i] * Math.PI) / 180 : null,
        // the valley's lamps switch as they do in the drive (the drive hashes the pack index); the region's follow on
        threshold: pack.enclosed[i] ? -1 : switchThresholdLux(base0 + i), warm: type.cls === 'sodium' ? 1 : 0,
        diameter: type.key === 'led_highmast' ? 2 * LUMINAIRE_DIAMETER_M : LUMINAIRE_DIAMETER_M, mount: pack.mount[i],
      });
    }
    for (let c = 0; c < nCells; c++) {
      const a = pack.cellStart[c], b = pack.cellStart[c + 1];
      if (b > a) { cellFirst.push(base0 + a); cellCount.push(b - a); }
    }
    base0 += pack.count;
  });
  const nCells = cellFirst.length;
  const bounds = new Float64Array(nCells * BOUND_STRIDE);
  const P = layer.data[0];
  let floorAlt = 0;

  /** Put every lamp head on the ground as heightAt now answers (a slice at a time) and work out the cells' bounds. */
  async function placeHeights(slice = 40000) {
    let lowest = Infinity;
    for (let t0 = 0; t0 < total; t0 += slice) {
      for (let t = t0; t < Math.min(total, t0 + slice); t++) {
        const d = decoded[srcPack[t]].pack, i = srcIndex[t];
        const x = d.x[i], y = d.y[i];
        const alt = heightAt(x, y) - base + d.mount[i] + HEAD_LIFT_M;
        P[4 * t + 1] = alt - curveDrop(x, y);
        if (alt < lowest) lowest = alt;
      }
      if (t0 + slice < total) await new Promise((r) => setTimeout(r, 0));
    }
    for (let k = 0; k < nCells; k++) {
      const a = cellFirst[k], b = a + cellCount[k];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, h0 = Infinity, h1 = -Infinity, a0 = Infinity, a1 = -Infinity;
      for (let t = a; t < b; t++) {
        const x = P[4 * t], y = P[4 * t + 1], z = P[4 * t + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
        if (y < h0) h0 = y; if (y > h1) h1 = y;
        const al = y + curveDrop(x, -z);
        if (al < a0) a0 = al; if (al > a1) a1 = al;
      }
      const o = k * BOUND_STRIDE;
      bounds[o] = (x0 + x1) / 2; bounds[o + 1] = (z0 + z1) / 2; bounds[o + 2] = Math.hypot(x1 - x0, z1 - z0) / 2;
      bounds[o + 3] = h0; bounds[o + 4] = h1; bounds[o + 5] = b - a; bounds[o + 6] = a; bounds[o + 7] = k; bounds[o + 8] = a0; bounds[o + 9] = a1;
    }
    floorAlt = lowest - 150;
    layer.uniforms.tPos.value.needsUpdate = true; // the positions only
    dirty = true;
  }

  const frustum = new Frustum(), pv = new Matrix4(), size = new Vector2();
  // the four side planes only: near and far depend on the depth convention (reversed on WebGPU, where three's Frustum
  // read with its default convention takes the near plane for the far one); the distance limit and the horizon test
  // stand in for them
  const planes = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const visibleCells = new Int32Array(nCells);
  const counts = new Float64Array(nCells), areas = new Float64Array(nCells), firsts = new Uint32Array(nCells), shares = new Float64Array(nCells);
  const last = new Float64Array(11).fill(NaN);
  let dirty = true, drawn = 0, cellsDrawn = 0, lampsInView = 0, budget = AIR_BUDGET[level] ?? AIR_BUDGET.high, density = AIR_DENSITY;
  let rebuilds = 0, scale = 1;

  /**
   * Choose what to draw for this camera (only when the eye has moved or turned enough, or something changed).
   * @param {{ camera: import('three').PerspectiveCamera, renderer?: object, heightAboveGround?: number, extinctionM: number }} o
   */
  function cull({ camera, renderer = null, heightAboveGround = 100, extinctionM = 80000 }) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements, eye = camera.position;
    const fov = camera.getEffectiveFOV ? camera.getEffectiveFOV() : camera.fov;
    if (renderer) renderer.getDrawingBufferSize(size); else size.set(1280, 800);
    const moved = Math.hypot(eye.x - last[0], eye.y - last[1], eye.z - last[2]);
    const turned = -(e[8] * last[3] + e[9] * last[4] + e[10] * last[5]);
    // rewritten every few metres (0.2 % of the height: 5 m at 2,400 m, 18 m at cruise), so a far cell's last lamp
    // fades in steps of a few hundredths of its light; the CPU cost is a fraction of a millisecond
    const step = Math.max(2, REBUILD_SHARE * Math.max(0, heightAboveGround));
    if (!dirty && moved < step && turned > TURN_COS && fov === last[6] && camera.aspect === last[7] && size.y === last[8]) return false;
    last[0] = eye.x; last[1] = eye.y; last[2] = eye.z; last[3] = -e[8]; last[4] = -e[9]; last[5] = -e[10];
    last[6] = fov; last[7] = camera.aspect; last[8] = size.y;
    dirty = false;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    for (let i = 0; i < 4; i++) { const pl = frustum.planes[i]; planes[i][0] = pl.normal.x; planes[i][1] = pl.normal.y; planes[i][2] = pl.normal.z; planes[i][3] = pl.constant; }
    const eyeAlt = eye.y + curveDrop(eye.x, -eye.z);
    // beyond 8 extinction lengths a lamp keeps under 0.04 % of its light
    const maxDistance = Math.min(450000, 8 * extinctionM);
    const res = cullCells(bounds, { eye, eyeAlt, planes, maxDistance, earthR, floorAlt, out: visibleCells, pad: [step + 5, Math.tan((0.8 * Math.PI) / 180)] });
    const pa = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.y);
    for (let j = 0; j < res.count; j++) {
      const k = res.cells[j], o = k * BOUND_STRIDE;
      const d = Math.max(1, Math.hypot(bounds[o] - eye.x, bounds[o + 1] - eye.z));
      const sinEl = Math.min(1, Math.max(0.01, (eyeAlt - (bounds[o + 8] + bounds[o + 9]) / 2) / d) + (bounds[o + 4] - bounds[o + 3]) / d);
      counts[j] = bounds[o + 5];
      areas[j] = cellScreenArea({ d, r: bounds[o + 2], sinEl, pixelAngle: pa });
      firsts[j] = bounds[o + 6];
    }
    const s = drawShares({ counts, areas, n: res.count, density, budget, out: shares });
    drawn = writeDrawList(layer.drawIndices, { firsts, counts, f: shares, n: res.count, budget });
    layer.setDrawCount(drawn);
    cellsDrawn = res.count;
    lampsInView = res.lamps;
    scale = s.scale;
    rebuilds++;
    return true;
  }

  const api = {
    mesh: layer.mesh,
    layer,
    count: total,
    /** Put the lamps on the ground heightAt answers now (again when a finer grid has arrived). */
    placeHeights,
    /**
     * Per frame, before the scene pass.
     * @param {{ camera: object, renderer?: object, heightAboveGround?: number, extinctionM: number, ambientLux: number,
     *   onTable: Float32Array, on: boolean }} o  extinctionM: lamps at d keep exp(-d / extinctionM) (extinction.js)
     */
    update({ camera, renderer = null, heightAboveGround = 100, extinctionM = 80000, ambientLux = 0, onTable = null, on = true, allLight = ALL_LIGHT_FACTOR }) {
      layer.mesh.visible = on;
      if (!on) return;
      cull({ camera, renderer, heightAboveGround, extinctionM });
      // the pool seen from afar carries the neighbourhood's light (ALL_LIGHT_FACTOR); the lamp's own beam stays its own
      layer.setFrame({ ambientLux, onTable, visibility: extinctionM, sodium: sodiumUv, groundAlbedo: GROUND_ALBEDO * allLight, glowRange: POOL_RANGE_M });
    },
    /** A different quality level: its sprite budget. */
    setLevel(l) { const b = AIR_BUDGET[l] ?? AIR_BUDGET.high; if (b !== budget) { budget = b; dirty = true; } },
    /** Lamps per pixel a far cell is thinned to (a probe's knob). */
    setDensity(v) { density = v > 0 ? v : AIR_DENSITY; dirty = true; },
    /** The light drawn now: { lamps: weight summed } (equals the lamps in view when nothing is over budget). */
    drawnLight() { let w = 0; const a = layer.drawIndices; for (let j = 0; j < drawn; j++) w += a[2 * j + 1]; return w; },
    stats: () => ({ lamps: total, byPack: Object.fromEntries(decoded.map((d) => [d.name, d.pack.count])), cells: nCells, cellsDrawn, lampsInView,
      drawn: layer.mesh.visible ? drawn : 0, budget, scale: +scale.toFixed(3), rebuilds }),
    dispose() { layer.dispose(); },
  };
  layer.mesh.userData.airLamps = api; // for probes (tests/manual), which find the layer in the scene
  return api;
}
