// The `lamps` drive part (plan 02, D5.4 and D5.5): every street lamp the drive can see as a light sprite, the
// light pools they throw on the road, the ground and the roadside buildings near the car, and poles with arms and
// heads beside the road near the car. Joined in parts.js; reads public/data/<city>/lamps-drive.{json,bin}
// (scripts/pack_lamps.py).
//
// Sprites: one sprite layer (sprites.js) holds every lamp of the product as an instance, positions on the drawn
// terrain at the lamp's mounting height. Each frame, before the draw, the product's ~1 km cells are culled against
// the view frustum and the horizon (pack.js cullCells); when the visible set changes the draw list is rewritten
// (cells are runs of instances), nearest cells first and at most SPRITE_BUDGET lamps. Enclosed lamps (under a
// bridge, in a tunnel) never draw as sprites; they still light pools.
// Pools: pools.js (a 2 km window of 2 m texels around the car, splatted in workers), added through surfaceLight.js.
// Switching and warm-up (switching.js, lamps.js): every lamp has its own photocell threshold; the shader compares
// it with the ambient illuminance of the moment and reads its switch-on time of this evening from a table worked
// out per local day, so a sodium lamp's colour and flux are a pure function of simulation time. The pools follow
// the same thresholds in four slices (poolTile.js). Everything is scaled by the look's `lights` (0 by day, 1 by
// night; env.js's units are fitted to the night look), so by day the sprites and pools draw nothing and the
// per-frame work stops; the poles stand day and night.

import * as THREE from 'three';
import { curveDrop } from '../../world/frame.js';
import { decodeLampPack, nonEmptyCells, cellBounds, cullCells, BOUND_STRIDE } from './pack.js';
import { createLampTypes, LUMINAIRE_DIAMETER_M } from './lamps.js';
import { switchThresholdLux, createOnTable, sliceLit } from './switching.js';
import { createSpriteLayer } from './sprites.js';
import { createPools } from './pools.js';
import { createPoles } from './poles.js';
import { createTimings } from '../timing.js';
import { eachGround } from '../parts.js';

/** Sprites drawn at most (plan 02, 9.1: 80 k sprites on High, lamps and vehicle lamps and studs together). */
export const SPRITE_BUDGET = 80000;
/** Reflectance of the ground under a lamp, for its pool seen from afar (asphalt and desert, ASSUMED). */
const GROUND_ALBEDO = 0.15;
const HEIGHT_SLICE = 20000;
/** The cull is redone when the eye has moved this far (m) or turned more than CULL_TURN_DEG. */
const CULL_MOVE_M = 10;
const CULL_TURN_DEG = 0.4;
const CULL_COS = Math.cos((CULL_TURN_DEG * Math.PI) / 180);
/** At most this many drawn lamps per pixel of a cell's projected area (far cells are thinned, their light kept). */
const SCREEN_DENSITY = 0.25;
let screenDensity = SCREEN_DENSITY;
/** A cell is never thinned below this many drawn lamps. */
const MIN_PER_CELL = 24;
/** Padding of each cell in the frustum test: metres plus a share of its distance (what CULL_TURN_DEG sweeps). */
const CULL_PAD = [CULL_MOVE_M + 2, Math.tan(((2 * CULL_TURN_DEG) * Math.PI) / 180)];

/** @param {object} ctx the part context (parts.js) */
export async function createLampsPart(ctx) {
  const meta = await ctx.optional('lamps-drive.json');
  if (!meta) return null;
  const buffer = await ctx.get(meta.file || 'lamps-drive.bin').then((r) => r.arrayBuffer());
  const pack = decodeLampPack(meta, buffer);
  const types = createLampTypes(pack.lampTypes);
  const { renderer, camera } = ctx.app;
  const { env, terrain, base, earthR } = ctx;

  // heights on the ground the drive draws, a slice at a time so the main thread is not held up
  const n = pack.count;
  const headY = new Float32Array(n), headAlt = new Float32Array(n);
  for (let i0 = 0; i0 < n; i0 += HEIGHT_SLICE) {
    for (let i = i0; i < Math.min(n, i0 + HEIGHT_SLICE); i++) {
      const x = pack.x[i], y = pack.y[i];
      headAlt[i] = terrain.surfaceAt(x, y) - base + pack.mount[i];
      headY[i] = headAlt[i] - curveDrop(x, y);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const cells = nonEmptyCells(pack);
  const bounds = cellBounds(pack, headY, headAlt, cells);
  let floorAlt = Infinity;
  for (let k = 0; k < cells.length; k++) floorAlt = Math.min(floorAlt, bounds[k * BOUND_STRIDE + 8]);
  floorAlt -= 150; // below the lowest lamp: the horizon test stays conservative

  // the sprite layer: instance i is lamp i of the product
  const layer = createSpriteLayer({ capacity: n, name: 'lamp-sprites', reflect: true }); // reflect: twins on wet pavement (weather)
  const patternOf = new Map();
  for (const t of types.list) {
    patternOf.set(t.id, layer.definePattern({ kind: t.optic, kDown: t.kDown, kUp: t.kUp, downShare: 1 - t.uplight }));
  }
  const sodium = types.list.find((t) => t.cls === 'sodium');
  const sodiumUv = sodium ? { startUv: sodium.warmup(0).uv, steadyUv: sodium.steadyUv } : null;
  const pos = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = types.byId.get(pack.type[i]) || types.list[0];
    pos[0] = pack.x[i]; pos[1] = headY[i]; pos[2] = -pack.y[i];
    layer.set(i, {
      position: pos, color: t.color, intensity: pack.lumens[i], pattern: patternOf.get(t.id), axis: [0, -1, 0],
      aim: Number.isFinite(pack.aim[i]) ? (pack.aim[i] * Math.PI) / 180 : null,
      threshold: pack.enclosed[i] ? -1 : switchThresholdLux(i), warm: t.cls === 'sodium' ? 1 : 0,
      diameter: t.key === 'led_highmast' ? 2 * LUMINAIRE_DIAMETER_M : LUMINAIRE_DIAMETER_M, mount: pack.mount[i],
    });
  }
  layer.commit();
  layer.mesh.visible = false;
  ctx.group.add(layer.mesh);

  const pools = createPools({ renderer, pack });
  const detach = [];
  const attach = (material, surface) => { if (material) detach.push(pools.attach(material, surface)); };
  attach(ctx.materials?.road, 'ground');
  attach(ctx.materials?.roadNear, 'ground');
  attach(ctx.wideMesh?.material, 'ground');
  const offGround = eachGround(ctx, (mesh) => attach(mesh.material, 'ground')); // the terrain patches too, when they come
  let corridorMat = null, corridorCheck = 0, corridorGroup;

  // the poles stand near the roads of the route's RoadNet: rebuilt when the route changes (setRoute)
  let poleRoads = ctx.net?.roadnet || null;
  let poles = createPoles({ pack, types, roads: poleRoads?.roads || [], groundY: terrain.surfaceY, parent: ctx.group });

  const onTable = createOnTable(env.ephemeris);
  const table = new Float32Array(37);
  const timings = createTimings();
  const sub = { poles: createTimings(), pools: createTimings(), weights: createTimings(), cull: createTimings() };
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  const planes = Array.from({ length: 6 }, () => [0, 0, 0, 0]);
  const culled = new Int32Array(cells.length);
  const order = [];
  let cnt = new Float64Array(0), dst = new Float64Array(0), kmin = new Float64Array(0);
  const bufSize = new THREE.Vector2();
  let prevCells = new Int32Array(0), prevCount = -1;
  let pendingMs = 0, lights = 0, ambient = 0, simMs = 0, on = false, culls = 0, lastLamps = 0, lastCells = 0;
  const lastCam = new Float64Array(11);

  const white = types.byKey.get('led_street') || types.list.find((t) => t.cls === 'led') || types.list[0];
  const sliceW = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

  /** The pools' channel weights for the moment: colour x lit share x warm-up x units x fade. */
  function poolWeights() {
    const k = env.lighting.units.lux * lights;
    const slices = [[0, 0.5], [0.5, 1]];
    for (let s = 0; s < 2; s++) {
      const { share, midThresholdLux } = sliceLit(ambient, slices[s][0], slices[s][1]);
      // sodium: the slice's middle lamp's warm-up
      if (sodium && share > 0) {
        const secs = secondsOnAt(midThresholdLux);
        const w = sodium.warmup(secs);
        for (let c = 0; c < 3; c++) sliceW[s][c] = Math.max(0, w.color[c]) * w.flux * share * k;
      } else sliceW[s].fill(0);
      for (let c = 0; c < 3; c++) sliceW[2 + s][c] = Math.max(0, white.color[c]) * share * k;
    }
    pools.setWeights(sliceW);
  }
  function secondsOnAt(threshold) {
    const f = Math.min(Math.max((Math.log10(threshold) + 0.6) / 0.1, 0), 36), i = Math.min(Math.floor(f), 35), t = f - i;
    const v = table[i] * (1 - t) + table[i + 1] * t;
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  /** Cull the cells against the camera; rewrite the draw list when the visible set changed. */
  function cull() {
    camera.updateMatrixWorld();
    // re-cull only when the eye moved CULL_MOVE_M or turned CULL_TURN, or the lens or viewport changed; the cull
    // pads each cell by what that much turning sweeps, so nothing at the screen's edge is late
    const e = camera.matrixWorld.elements, eye = camera.position;
    const fov = camera.getEffectiveFOV?.() ?? 0;
    const moved = Math.hypot(eye.x - lastCam[0], eye.y - lastCam[1], eye.z - lastCam[2]);
    const turned = -(e[8] * lastCam[3] + e[9] * lastCam[4] + e[10] * lastCam[5]); // camera looks down -z
    const up = e[4] * lastCam[6] + e[5] * lastCam[7] + e[6] * lastCam[8];
    if (prevCount >= 0 && moved < CULL_MOVE_M && turned > CULL_COS && up > CULL_COS && fov === lastCam[9] && camera.aspect === lastCam[10]) return;
    lastCam[0] = eye.x; lastCam[1] = eye.y; lastCam[2] = eye.z;
    lastCam[3] = -e[8]; lastCam[4] = -e[9]; lastCam[5] = -e[10];
    lastCam[6] = e[4]; lastCam[7] = e[5]; lastCam[8] = e[6];
    lastCam[9] = fov; lastCam[10] = camera.aspect;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    frustum.planes.forEach((pl, i) => { planes[i][0] = pl.normal.x; planes[i][1] = pl.normal.y; planes[i][2] = pl.normal.z; planes[i][3] = pl.constant; });
    const eyeAlt = eye.y + curveDrop(eye.x, -eye.z);
    const vis = env.weather.state().visibilityM || 80000;
    const res = cullCells(bounds, { eye, eyeAlt, planes, maxDistance: Math.min(120000, vis * 4), earthR, floorAlt, out: culled, pad: CULL_PAD });
    let count = res.count;
    // Thinning, flux kept: a cell drawn as every k-th lamp, each drawn lamp carrying the light of the k it stands for.
    // First by what the cell covers on screen (far districts seen edge-on hold several lamps per pixel; summed in a
    // pixel they look the same, and drawing them all costs fill and blending for nothing): at most
    // SCREEN_DENSITY lamps per pixel of the cell's projected area. Then, if still over the budget, by distance:
    // k = ceil(d / d0) with d0 the largest that fits.
    renderer.getDrawingBufferSize(bufSize);
    const pa = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, bufSize.y);
    order.length = 0;
    let total = 0;
    for (let j = 0; j < count; j++) {
      const o = res.cells[j] * BOUND_STRIDE;
      const d = Math.max(1, Math.hypot(bounds[o] - eye.x, bounds[o + 1] - eye.z));
      const c = bounds[o + 5];
      const w = (2 * bounds[o + 2]) / d / pa + 1;
      const sinEl = Math.min(1, Math.max(0.01, (eyeAlt - (bounds[o + 8] + bounds[o + 9]) / 2) / d) + (bounds[o + 4] - bounds[o + 3]) / d);
      const k = Math.max(1, Math.ceil(c / Math.max(MIN_PER_CELL, w * w * sinEl * screenDensity)));
      order.push([res.cells[j], Math.max(1, d - bounds[o + 2]), k]);
      total += Math.ceil(c / k);
    }
    if (total > SPRITE_BUDGET) {
      const m = order.length;
      if (cnt.length < m) { cnt = new Float64Array(cells.length); dst = new Float64Array(cells.length); kmin = new Float64Array(cells.length); }
      for (let j = 0; j < m; j++) { cnt[j] = bounds[order[j][0] * BOUND_STRIDE + 5]; dst[j] = order[j][1]; kmin[j] = order[j][2]; }
      const drawnAt = (d0) => { let a = 0; for (let j = 0; j < m; j++) a += Math.ceil(cnt[j] / Math.max(kmin[j], Math.ceil(dst[j] / d0))); return a; };
      let lo = 1, hi = 1e6;
      for (let it = 0; it < 24; it++) { const mid = Math.sqrt(lo * hi); if (drawnAt(mid) > SPRITE_BUDGET) hi = mid; else lo = mid; }
      for (const e of order) e[2] = Math.max(e[2], Math.ceil(e[1] / lo));
    }
    // the same cells and strides as last time: nothing to upload
    let changed = count !== prevCount;
    if (!changed) for (let j = 0; j < count; j++) if (prevCells[2 * j] !== order[j][0] || prevCells[2 * j + 1] !== order[j][2]) { changed = true; break; }
    lastCells = count; lastLamps = total;
    if (!changed) return;
    if (prevCells.length < 2 * count) prevCells = new Int32Array(2 * cells.length);
    const draw = layer.drawIndices;
    let w = 0;
    for (let j = 0; j < count; j++) {
      const o = order[j][0] * BOUND_STRIDE, first = bounds[o + 6], c = bounds[o + 5], k = order[j][2];
      for (let i = 0; i < c && w < SPRITE_BUDGET; i += k) { draw[2 * w] = first + i; draw[2 * w + 1] = Math.min(k, c - i); w++; }
      prevCells[2 * j] = order[j][0]; prevCells[2 * j + 1] = k;
    }
    prevCount = count;
    layer.setDrawCount(w);
    culls++;
  }

  let enabled = true;
  const part = {
    name: 'lamps',
    /** Switch the whole part off and on (for measuring what it costs); off it draws and does nothing. */
    setEnabled(v) {
      enabled = !!v;
      layer.mesh.visible = enabled && on;
      poles.setVisible(enabled);
      if (!enabled) pools.update(0, 0, false);
    },
    /** Lamps per pixel a far cell is thinned to (default SCREEN_DENSITY; Infinity: no thinning but the budget's). */
    setScreenDensity(v) { screenDensity = v > 0 ? v : SCREEN_DENSITY; prevCount = -1; },
    update(frame) {
      if (!enabled) return;
      const t0 = performance.now();
      simMs = frame.simMs;
      ambient = env.lighting.ambientLux(frame.sun.elevation);
      on = lights > 0;
      const car = frame.pose.position;
      const tp = performance.now();
      poles.update(car.x, -car.z);
      sub.poles.add(performance.now() - tp);
      const tq = performance.now();
      pools.update(car.x, -car.z, on);
      sub.pools.add(performance.now() - tq);
      if (!corridorMat && ++corridorCheck % 30 === 1) {
        // the roadside buildings' shared material, once their first cell is in (the group is looked up once)
        corridorGroup ??= ctx.group.children.find((o) => o.name === 'corridor') || null;
        const mesh = corridorGroup?.children.find((m) => m.isMesh);
        if (mesh) { corridorMat = mesh.material; attach(corridorMat, 'building'); }
      }
      const tw = performance.now();
      if (on) {
        onTable(simMs, table);
        poolWeights();
      }
      sub.weights.add(performance.now() - tw);
      pendingMs += performance.now() - t0;
    },
    setLook(look) {
      lights = look.lights ?? look.dusk ?? (look.night ? 1 : 0);
      on = lights > 0;
      layer.mesh.visible = on && enabled;
      if (!on) pools.update(0, 0, false);
    },
    beforeRender() {
      if (!enabled) return;
      const t0 = performance.now();
      if (!on) { timings.add(pendingMs); pendingMs = 0; return; }
      const tc = performance.now();
      cull();
      sub.cull.add(performance.now() - tc);
      layer.setFrame({
        camera, renderer, gain: env.lighting.units.nit * lights, ambientLux: ambient, onTable: table,
        visibility: env.weather.state().visibilityM || 80000, sodium: sodiumUv, groundAlbedo: GROUND_ALBEDO,
      });
      timings.add(pendingMs + performance.now() - t0);
      pendingMs = 0;
    },
    /** Another route: its RoadNet's roads decide which lamps get poles. */
    setRoute({ roadnet }) {
      if (!roadnet || roadnet === poleRoads) return;
      poleRoads = roadnet;
      poles.dispose();
      poles = createPoles({ pack, types, roads: roadnet.roads, groundY: terrain.surfaceY, parent: ctx.group });
      poles.setVisible(enabled);
    },
    whenSettled: () => pools.whenSettled(),
    stats() {
      const t = timings.summary();
      return {
        lamps: n, on, lights, ambientLux: ambient, sprites: on ? layer.drawn : 0, cells: lastCells, lampsInView: lastLamps, culls,
        poles: poles.count, pools: pools.stats(), js: { mean: t.mean, p95: t.p95, max: t.max, sub: Object.fromEntries(Object.entries(sub).map(([k, v]) => { const x = v.summary(); return [k, [+x.mean.toFixed(3), +x.p95.toFixed(2), +x.max.toFixed(2)]]; })) },
      };
    },
    dispose() {
      offGround();
      for (const d of detach) d();
      layer.dispose();
      pools.dispose();
      poles.dispose();
    },
  };
  layer.mesh.userData.lampsPart = part; // for tests/manual/lamps-shots.mjs
  return part;
}
