// The `valley` drive part (plan 02, D6.6): traffic on the rest of the valley as light ribbons, no vehicles.
//
// Every freeway and principal arterial of the valley is a pair of thin glowing strips on the ground, one per
// direction, offset to the right of travel. The driven routes' own carriageways are in the file as groups by route
// (valleyFormat.js); the part leaves out the group(s) of the route being driven (setRoute), whose traffic is drawn
// as vehicles by the `traffic` part, and keeps the other routes' freeways lit.
// Their brightness is the light of the vehicles on them at the moment: vehicles per metre (daily volume x the
// hour-of-week shape / speed) x each vehicle's intensity toward the eye, white where the traffic comes toward the
// eye (head lamps), red where it goes away (tail lamps), with a pattern drifting along at the traffic's speed.
// The arithmetic is valleyModel.js, mirrored by valley.glsl.js; the data is public/data/<city>/traffic/valley.json
// + valley.bin (scripts/build_valley_traffic.py, read by valleyFormat.js), the strips valleyGeometry.js.
//
// One draw call. Per frame the part sets six uniforms (the hour of week, the drift time, the pixel angle, the
// visibility); nothing else runs on the CPU. Off by day: drawn only while the look's `lights` is above zero,
// scaled by it. Faded out within NEAR_M of the eye, where a strip would read as paint on the ground and where the
// route's own traffic is drawn as vehicles anyway.

import * as THREE from 'three';
import { curveDrop } from '../../world/frame.js';
import { decodeValley, hiddenGroups } from './valleyFormat.js';
import { buildValleyGeometry, indexWithout } from './valleyGeometry.js';
import { valleyVertex, valleyFragment } from './valley.glsl.js';
import { VALLEY_LAMPS, HEAD_COLOR, TAIL_COLOR, HASH_MEAN, hourOfWeekAt, driftTime } from './valleyModel.js';
import { createTimings } from '../timing.js';

/** The ribbons fade in between these distances from the eye, metres. */
export const NEAR_M = [350, 1200];
/** Narrowest strip on the screen, pixels. */
export const MIN_PX = 1.5;
/** With the transparent lights, just before the light sprites (sprites.js, renderOrder 10). */
const RENDER_ORDER = 9;

/** @param {object} ctx the part context (parts.js) */
export async function createValleyPart(ctx) {
  const doc = await ctx.optional('traffic/valley.json');
  if (!doc) return null;
  const buffer = await ctx.get(doc.file || 'traffic/valley.bin').then((r) => r.arrayBuffer());
  const data = decodeValley(doc, buffer);
  const { env, terrain, base } = ctx;
  const { renderer } = ctx.app;
  const tz = data.tz || env.city?.tz || 'America/Los_Angeles';

  const g = buildValleyGeometry(data, { heightAt: terrain.heightAt, base, curveDrop });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(g.dir, 3));
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(g.along, 2));
  geometry.setAttribute('aTraffic', new THREE.BufferAttribute(g.traffic, 4));
  geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
  let routeId = null, hidden = [];
  /** Leave out the groups of the route being driven (a new index; the vertices stay). */
  const applyRoute = (id) => {
    const next = hiddenGroups(data, id);
    if (id === routeId && next.length === hidden.length) return;
    routeId = id;
    hidden = next;
    geometry.setIndex(new THREE.BufferAttribute(indexWithout(g, hidden), 1));
    ctx.app?.invalidate?.();
  };

  // the shapes as a float texture, one row per shape
  const shapeTex = new Float32Array(168 * data.shapes.length);
  data.shapes.forEach((s, r) => shapeTex.set(s, r * 168));
  const shapes = new THREE.DataTexture(shapeTex, 168, data.shapes.length, THREE.RedFormat, THREE.FloatType);
  shapes.minFilter = shapes.magFilter = THREE.NearestFilter;
  shapes.needsUpdate = true;

  const uniforms = {
    tShapes: { value: shapes }, uHow: { value: 0 }, uPixelAngle: { value: 1e-3 }, uMinPx: { value: MIN_PX },
    uNear: { value: new THREE.Vector2(NEAR_M[0], NEAR_M[1]) }, uVisibility: { value: 80000 },
    uLamps: { value: new THREE.Vector4(VALLEY_LAMPS.head, VALLEY_LAMPS.headPower, VALLEY_LAMPS.spill, VALLEY_LAMPS.tail) },
    uGain: { value: 0 }, uTime: { value: 0 }, uHashMean: { value: HASH_MEAN },
    uHeadColor: { value: new THREE.Vector3(...HEAD_COLOR) }, uTailColor: { value: new THREE.Vector3(...TAIL_COLOR) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'valley-ribbons', uniforms, vertexShader: valleyVertex, fragmentShader: valleyFragment,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'valley-ribbons';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.visible = false;
  ctx.group.add(mesh);

  const timings = createTimings();
  const size = new THREE.Vector2();
  let fade = 0, enabled = true, lastHow = 0, gainScale = 1;
  // the zone offset changes twice a year: cache it per UTC hour
  let offHour = NaN, offHow = 0;
  const howAt = (simMs) => {
    const H = Math.floor(simMs / 3600000);
    if (H !== offHour) { offHour = H; offHow = hourOfWeekAt(H * 3600000, tz); }
    return (offHow + (simMs - H * 3600000) / 3600000) % 168;
  };

  const show = () => { mesh.visible = enabled && fade > 0; };

  const part = {
    name: 'valley',
    update(frame) {
      if (!mesh.visible) return;
      const t0 = performance.now();
      lastHow = howAt(frame.simMs);
      uniforms.uHow.value = lastHow;
      uniforms.uTime.value = driftTime(frame.simMs);
      timings.add(performance.now() - t0);
    },
    beforeRender(frame) {
      if (!mesh.visible) return;
      const t0 = performance.now();
      const cam = frame.camera;
      renderer.getDrawingBufferSize(size);
      const fov = cam.isPerspectiveCamera ? cam.getEffectiveFOV() : 50;
      uniforms.uPixelAngle.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.y);
      uniforms.uVisibility.value = env.weather?.state?.().visibilityM || 80000;
      // a paused clock still gets its hour (update runs only when the pose moves)
      const how = howAt(frame.simMs);
      if (how !== lastHow) { lastHow = how; uniforms.uHow.value = how; uniforms.uTime.value = driftTime(frame.simMs); }
      timings.add(performance.now() - t0);
    },
    setLook(look) {
      fade = Math.min(1, Math.max(0, look.lights ?? look.dusk ?? (look.night ? 1 : 0)));
      uniforms.uGain.value = env.lighting.units.nit * fade * gainScale;
      show();
    },
    /** Multiply the ribbons' brightness: a debugging aid for finding them in a screenshot, never a look. */
    setGainScale(k) { gainScale = k; uniforms.uGain.value = env.lighting.units.nit * fade * gainScale; ctx.app?.invalidate?.(); },
    /** The route being driven: its own carriageways are left out (its vehicles are the `traffic` part's). */
    setRoute({ route } = {}) { applyRoute(route?.id ?? null); },
    /** Turn the ribbons off and on (for the frame-budget probe and the screenshots). */
    setEnabled(on) { enabled = !!on; show(); ctx.app?.invalidate?.(); },
    whenSettled: () => Promise.resolve(),
    stats() {
      const t = timings.summary();
      return {
        visible: mesh.visible, enabled, fade, pieces: data.count, ribbons: g.ribbons, points: g.points,
        triangles: geometry.index.count / 3, route: routeId, hidden: hidden.map((h) => h.id), groups: data.groups.map((h) => h.id),
        how: +lastHow.toFixed(3), js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    mesh,
    dispose() {
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
      shapes.dispose();
    },
  };
  mesh.userData.part = part; // for tests/manual/valley-shots.mjs, which finds it in the scene
  return part;
}
