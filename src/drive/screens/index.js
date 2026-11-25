// The `screens` drive part (plan 02, D7.3 and D7.5). Joined in parts.js.
//
// Clocks. While driving, the extras' animation (the LED skins of night.js, the fountain show, the turning wheel)
// runs on the content clock (clock.js): every update the part holds attractions.js's clocks at the content time of
// the simulation through the hook that file already offers, attractions.freeze(seconds), so scrubbing back gives
// the same frame, pausing holds it and 16x runs it 16 times as fast (the LED skins measure 0 full-field flashes a
// second at 16x and at most 1 over any quarter of the Sphere; the digital billboards 1: tests/unit/screens).
// When the visitor leaves Drive the part lets go (freeze(null)) and the map's own clocks run again. attractions.js,
// night.js and fountain.js are not changed.
//
// Registry. The screens the drive knows (registry.js): the Sphere (screen id 'sphere'), the LED faces of the other
// landmark models and of the extras, and the billboards part's faces. LED screens take their mean colour from the
// mirror of night.js's program (led.js) over a fixed set of area samples of their LED faces; their level is a luminance
// in cd/m^2, the one plan 01's building material draws the skin at (led.js ledScale: plan 01's ledCdM2(switchOn.signs)).
//
// The Sphere's light (D7.5; third stretch, decision 6): an illuminance in lux, a surface term (light.js) on the
// ground, the wide terrain, the low buildings and every 'road' and 'building' surface of ctx.eachSurface (the road and
// the corridor's buildings), scaled each frame by the Sphere's mean colour and falling off with distance
// from its centre. The term is switched on in beforeRender and off in afterRender, so it only ever lights the
// drive's frames, never the map's. It follows hide and move: hidden, the term is off; moved, its centre moves with
// the building's offset. It follows the app's edit events on the part context's bus (ctx.app.events, src/app/events.js):
// 'buildings:changed' after every hide, show and move step (interaction/edits.js emits one per drag step, so the light
// moves with a dragged Sphere frame by frame) re-reads the Sphere's visibility and offset, and 'buildings:rebuilt'
// (the height cutoff rebuilt the towers) rescans the removable buildings. Both are read once when the part starts;
// nothing is polled per frame.

import * as THREE from 'three';
import { switchOn } from '../../render/materials/shared.js';
import { createTimings } from '../timing.js';
import { eachGround } from '../parts.js';
import { contentSeconds } from './clock.js';
import { createLedMeanCache, ledMean, ledSamples, ledScale } from './led.js';
import { createScreenRegistry } from './registry.js';
import { createSphereLight } from './light.js';

export const SPHERE_ID = 'w976405284';
/** Metres from the Sphere's centre within which its light is drawn. */
export const SPHERE_RANGE = 900;
/** The Sphere's mean colour is worked out only while the eye is within this distance of it (m). */
const SPHERE_WORK_M = 8000;
/** Area samples of the Sphere's skin for its mean colour: the program's stripes are about 14 m apart, so fewer alias
 * (512 are within about 2% of the mean of every face: tests/unit/screens/led.test.js). The mean is kept on a 1 s grid
 * of content time and filled ahead a slice a frame (led.js createLedMeanCache). */
const SPHERE_SAMPLES = 512;

/** What multiplies an LED pattern now (led.js ledScale), from the shared uniforms. */
const ledNow = () => ledScale({ signs: switchOn.signs.value });

/** An LED screen of a removable building (its geometry is in world coordinates; the mesh moves by its offset). */
function buildingScreen(entry, id, name) {
  const geo = entry.mesh.geometry;
  const led = geo.getAttribute('led'), pos = geo.getAttribute('position');
  if (!led || !pos || !led.array.some((v) => v > 0)) return null;
  const big = id === 'sphere';
  const { samples, area, centre } = ledSamples(pos.array, led.array, big ? SPHERE_SAMPLES : 48);
  let r = 0;
  for (let i = 0; i < samples.length; i += 4) r += Math.hypot(samples[i] - centre[0], samples[i + 1] - centre[1], samples[i + 2] - centre[2]) * samples[i + 3];
  const cache = big ? createLedMeanCache(samples) : null;
  return {
    id, kind: 'led', name, area, radius: r, entry, samples, cache,
    centre: () => [centre[0] + entry.offset.x, centre[1] + entry.offset.y, centre[2] + entry.offset.z],
    visible: () => entry.mesh.visible,
    meanColor(simMs, out = [0, 0, 0]) {
      if (cache) cache.at(contentSeconds(simMs), out); else ledMean(samples, contentSeconds(simMs), out);
      const k = ledNow();
      out[0] *= k; out[1] *= k; out[2] *= k;
      return out;
    },
  };
}

/** An LED screen on an extra (a mesh in its own frame, placed by its matrixWorld). */
function extraScreen(mesh, id, name) {
  const geo = mesh.geometry;
  const led = geo.getAttribute('led'), pos = geo.getAttribute('position');
  if (!led || !pos || !led.array.some((v) => v > 0)) return null;
  const { samples, area, centre } = ledSamples(pos.array, led.array, 64);
  const c = new THREE.Vector3();
  const shown = () => { for (let o = mesh; o; o = o.parent) if (!o.visible) return false; return true; };
  return {
    id, kind: 'led', name, area, samples,
    centre: () => c.set(centre[0], centre[1], centre[2]).applyMatrix4(mesh.matrixWorld).toArray(),
    visible: shown,
    meanColor(simMs, out = [0, 0, 0]) {
      ledMean(samples, contentSeconds(simMs), out);
      const k = ledNow();
      out[0] *= k; out[1] *= k; out[2] *= k;
      return out;
    },
  };
}

/** @param {object} ctx the part context (parts.js) */
export function createScreensPart(ctx) {
  const { app, session } = ctx;
  // the Sphere's light: its term and uniforms
  const light = createSphereLight({ range: SPHERE_RANGE, photometry: { nodes: ctx.env?.nodes } });
  const registry = createScreenRegistry();
  const timings = createTimings();
  const attractions = () => (typeof window !== 'undefined' ? window.__skyline?.attractions : null) || null;

  // ---------------------------------------------------------------- the registry
  let sphere = null, extrasDone = false;
  function scanBuildings() {
    for (const s of registry.list()) if (s.entry) registry.remove(s.id);
    sphere = null;
    for (const entry of app.tall || []) {
      const isSphere = entry.data.id === SPHERE_ID;
      const s = buildingScreen(entry, isSphere ? 'sphere' : `led:${entry.data.id}`, entry.data.name || entry.data.id);
      if (!s) continue;
      registry.add(s);
      if (isSphere) sphere = s;
    }
  }
  function scanExtras() {
    const a = attractions();
    if (!a || extrasDone) return;
    extrasDone = true;
    a.ready?.then(() => {
      for (const root of a.extras || []) {
        let k = 0;
        root.traverse((m) => {
          if (!m.isMesh) return;
          const s = extraScreen(m, `extra:${root.name}${k ? `#${k}` : ''}`, root.name);
          if (s) { registry.add(s); k++; }
        });
      }
    });
  }
  scanBuildings();
  scanExtras();

  // ---------------------------------------------------------------- the Sphere's light
  const uniforms = light.uniforms;
  const detach = [], attached = new Set();
  const attach = (material) => {
    if (!material || attached.has(material)) return;
    if (!material.isNodeMaterial) return; // a stock material the renderer converts itself takes no term
    attached.add(material);
    detach.push(light.attach(material));
  };
  attach(ctx.materials?.road);
  attach(ctx.materials?.roadNear);
  attach(ctx.wideMesh?.material);
  const offGround = eachGround(ctx, (mesh) => attach(mesh.material)); // the terrain patches too, when they come
  // the road and the corridor's buildings as the session hands them over (a route switch adds more)
  const offSurfaces = typeof ctx.eachSurface === 'function'
    ? ctx.eachSurface((material, kind) => { if (kind === 'road' || kind === 'building') attach(material); })
    : () => {};
  let corridorCheck = 0;
  function attachLate() {
    const low = app.getLow?.();
    if (low) attach(low.material); // the corridor's material comes through eachSurface
  }

  let lightOn = false, lightEnabled = true, sphereState = '', sphereShown = false;
  const sphereMean = [0, 0, 0];
  /** Read the Sphere's visibility and offset into the term (at the start, and on every edit event). */
  function placeSphere() {
    sphereShown = !!sphere && sphere.visible();
    if (!sphere) { lightOn = false; sphereState = 'none'; return; }
    const c = sphere.centre();
    uniforms.uScrSphere.value.set(c[0], c[1], c[2], sphere.radius);
    sphereState = `${sphereShown ? 'shown' : 'hidden'} ${c.map((v) => v.toFixed(1)).join(',')}`;
  }
  placeSphere(); // the one check at the start: the buildings were scanned above
  // the app's edit events (ctx.app.events): a hide, show or move step, and the height cutoff's rebuild
  const events = app.events;
  const offChanged = events?.on('buildings:changed', () => { placeSphere(); app.invalidate?.(); });
  const offRebuilt = events?.on('buildings:rebuilt', () => { scanBuildings(); placeSphere(); app.invalidate?.(); });

  // ---------------------------------------------------------------- the clocks
  let holding = false, heldAt = null, watch = 0;
  function hold(t) {
    const a = attractions();
    if (!a) return;
    if (t !== heldAt) { heldAt = t; a.freeze(t); }
    if (!holding) { holding = true; watch = requestAnimationFrame(watchExit); }
  }
  /** Each animation frame while holding: once Drive is left, give the map its clocks back. */
  function watchExit() {
    if (!holding) return;
    if ((app.seam ?? app.drive)?.active) { watch = requestAnimationFrame(watchExit); return; }
    release();
  }
  function release() {
    if (!holding) return;
    holding = false;
    heldAt = null;
    cancelAnimationFrame(watch);
    attractions()?.freeze(null);
  }

  let lastSimMs = NaN, pendingMs = 0;
  const part = {
    name: 'screens',
    registry,
    uniforms,
    /** The Sphere's light on and off (for measuring it; on by default). */
    setLight(on) { lightEnabled = !!on; },
    /** Put the Sphere's light on another material (test hook: tests/manual/screens-luminance.mjs, a lux meter). */
    attachLight: (material) => attach(material),
    update(frame) {
      const t0 = performance.now();
      lastSimMs = frame.simMs;
      hold(contentSeconds(frame.simMs));
      if (!extrasDone) scanExtras();
      if (++corridorCheck % 30 === 1) attachLate();
      // the billboards' faces join the registry once that part is in
      const bb = session?.part?.('billboards');
      if (bb?.screens && !registry.get(bb.screens[0]?.id ?? '')) for (const s of bb.screens) registry.add(s);
      pendingMs += performance.now() - t0;
    },
    beforeRender(frame) {
      const t0 = performance.now();
      lightOn = false;
      if (lightEnabled && sphereShown) {
        const c = uniforms.uScrSphere.value, eye = frame.camera.position;
        const d = Math.hypot(eye.x - c.x, eye.y - c.y, eye.z - c.z);
        if (d < SPHERE_WORK_M) {
          sphere.meanColor(frame.simMs, sphereMean);
          // the next grid point, ahead of the clock: what one frame at this rate moves through, and a margin
          const dir = frame.dtSimMs < 0 ? -1 : 1, perFrame = (Math.abs(frame.rate || 1) / 60) * sphere.cache.size;
          if (frame.playing) sphere.cache.advance(contentSeconds(frame.simMs), dir, Math.min(sphere.cache.size, Math.ceil(perFrame) + 24));
          uniforms.uScrSphereL.value.set(sphereMean[0], sphereMean[1], sphereMean[2]);
          lightOn = sphereMean[0] + sphereMean[1] + sphereMean[2] > 1e-4;
        }
      }
      uniforms.uScrSphereSpec.value.y = lightOn ? 1 : 0;
      timings.add(pendingMs + performance.now() - t0);
      pendingMs = 0;
    },
    afterRender() { uniforms.uScrSphereSpec.value.y = 0; }, // the map's frames never see the term
    stats() {
      const t = timings.summary();
      return {
        screens: registry.summary(lastSimMs), held: heldAt, sphereLight: { on: lightOn, state: sphereState, mean: sphereMean.map((v) => +v.toFixed(4)) },
        materials: attached.size, js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    dispose() {
      offGround();
      offSurfaces();
      release();
      offChanged?.(); offRebuilt?.();
      for (const d of detach) d();
    },
  };
  ctx.group.userData.screensPart = part; // for tests/manual/screens-shots.mjs
  return part;
}
