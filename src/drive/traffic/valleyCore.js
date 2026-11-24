// The `valley` drive part (plan 02, D6.6): the work both renderers share, with no shader in it. valley.js (GLSL, the
// classic renderer) and valley.node.js (TSL, plan 01's) each hand this their material, the way they make a uniform
// and the unit of uGain; the part itself (data, geometry, route, hour of week, switching) is here once (plan 02, third
// stretch, decision 2: pure logic is shared, not copied). valley.js's header describes the part.
//
// Detail by plan 01's quality level (decision 8), on plan 01's renderer only (`quality`): VALLEY_CLASSES names the road
// classes drawn per level. Low leaves out the secondary roads (the dimmest ribbons: 1,159 of the 2,576 pieces in Las Vegas);
// High and Ultra draw them all, as the classic renderer does.

import * as THREE from 'three';
import { curveDrop } from '../../world/frame.js';
import { decodeValley, hiddenGroups } from './valleyFormat.js';
import { buildValleyGeometry, indexWithout } from './valleyGeometry.js';
import { VALLEY_LAMPS, HEAD_COLOR, TAIL_COLOR, HASH_MEAN, hourOfWeekAt, driftTime } from './valleyModel.js';
import { createTimings } from '../timing.js';

/** The ribbons fade in between these distances from the eye, metres. */
export const NEAR_M = [350, 1200];
/** Narrowest strip on the screen, pixels. */
export const MIN_PX = 1.5;
/** With the transparent lights, just before the light sprites (sprites.js, renderOrder 10). */
const RENDER_ORDER = 9;
/** Road classes drawn by plan 01's quality level (valley.json `classes`). */
export const VALLEY_CLASSES = Object.freeze({
  low: Object.freeze(['motorway', 'trunk', 'primary']),
  high: null, // all
  ultra: null,
});

/** Runs { first, count } of the pieces (before the groups) whose class is not drawn at this level. */
export function classRuns(data, level) {
  const keep = VALLEY_CLASSES[level];
  if (!keep) return [];
  const drop = new Set(data.classes.map((c, i) => (keep.includes(c) ? -1 : i)).filter((i) => i >= 0));
  const end = data.groups?.length ? Math.min(...data.groups.map((g) => g.first)) : data.count;
  const runs = [];
  for (let i = 0; i < end; i++) {
    if (!drop.has(data.cls[i])) continue;
    const last = runs[runs.length - 1];
    if (last && last.first + last.count === i) last.count++; else runs.push({ first: i, count: 1 });
  }
  return runs;
}

/**
 * @param {object} ctx the part context (parts.js)
 * @param {{ uniform: (value: *) => { value: * }, unit: number, material: (uniforms: object, shapes: THREE.DataTexture) => THREE.Material,
 *   fade?: (look: object) => number, liveFade?: (() => number) | null, minFade?: number, quality?: object | null }} o
 *   uniform: makes a uniform holding `value`; unit: uGain per unit of fade (the classic scene units per cd/m^2, or 1
 *   where the material carries the light scale); fade: the look's fade (default its `lights`); liveFade: the fade
 *   read each frame instead (plan 01's shipped look: the vehicles' lit share at the ambient light of the moment);
 *   minFade: drawn only above this fade (0); quality: plan 01's app.quality (detail by level), null on the classic renderer
 */
export async function createValleyPartWith(ctx, { uniform, unit, material: makeMaterial, fade: fadeOf, liveFade = null, minFade = 0, quality = null }) {
  const doc = await ctx.optional('traffic/valley.json');
  if (!doc) return null;
  const buffer = await ctx.get(doc.file || 'traffic/valley.bin').then((r) => r.arrayBuffer());
  const data = decodeValley(doc, buffer);
  const { env, terrain, base } = ctx;
  const { renderer } = ctx.app;
  const tz = data.tz || env.city?.tz || 'America/Los_Angeles';

  const g = buildValleyGeometry(data, { heightAt: terrain.surfaceAt, base, curveDrop });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(g.dir, 3));
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(g.along, 2));
  geometry.setAttribute('aTraffic', new THREE.BufferAttribute(g.traffic, 4));
  geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
  let routeId = null, hidden = [], level = quality?.level ?? 'high', dropped = classRuns(data, quality ? level : 'high');
  /** Leave out the groups of the route being driven and the classes the quality level does not draw (a new index; the vertices stay). */
  const applyRoute = (id, force = false) => {
    const next = hiddenGroups(data, id);
    if (!force && id === routeId && next.length === hidden.length) return;
    routeId = id;
    hidden = next;
    geometry.setIndex(new THREE.BufferAttribute(indexWithout(g, [...hidden, ...dropped]), 1));
    ctx.app?.invalidate?.();
  };
  if (dropped.length) applyRoute(null, true);
  const offQuality = quality?.on ? quality.on('change', (q) => {
    if (q.level === level) return;
    level = q.level;
    dropped = classRuns(data, level);
    applyRoute(routeId, true);
  }) : () => {};

  // the shapes as a float texture, one row per shape
  const shapeTex = new Float32Array(168 * data.shapes.length);
  data.shapes.forEach((s, r) => shapeTex.set(s, r * 168));
  const shapes = new THREE.DataTexture(shapeTex, 168, data.shapes.length, THREE.RedFormat, THREE.FloatType);
  shapes.minFilter = shapes.magFilter = THREE.NearestFilter;
  shapes.needsUpdate = true;

  const u = uniform;
  const uniforms = {
    tShapes: { value: shapes }, uHow: u(0), uPixelAngle: u(1e-3), uMinPx: u(MIN_PX),
    uNear: u(new THREE.Vector2(NEAR_M[0], NEAR_M[1])), uVisibility: u(80000),
    uLamps: u(new THREE.Vector4(VALLEY_LAMPS.head, VALLEY_LAMPS.headPower, VALLEY_LAMPS.spill, VALLEY_LAMPS.tail)),
    uGain: u(0), uTime: u(0), uHashMean: u(HASH_MEAN),
    uHeadColor: u(new THREE.Vector3(...HEAD_COLOR)), uTailColor: u(new THREE.Vector3(...TAIL_COLOR)),
  };
  const material = makeMaterial(uniforms, shapes);
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

  const show = () => { mesh.visible = enabled && fade > minFade; };
  const setFade = (f) => { fade = f; uniforms.uGain.value = unit * fade * gainScale; show(); };
  const lookFade = fadeOf || ((look) => Math.min(1, Math.max(0, look.lights ?? look.dusk ?? (look.night ? 1 : 0))));

  const part = {
    name: 'valley',
    update(frame) {
      if (liveFade) setFade(liveFade());
      if (!mesh.visible) return;
      const t0 = performance.now();
      lastHow = howAt(frame.simMs);
      uniforms.uHow.value = lastHow;
      uniforms.uTime.value = driftTime(frame.simMs);
      timings.add(performance.now() - t0);
    },
    beforeRender(frame) {
      if (liveFade) setFade(liveFade());
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
      if (!liveFade) setFade(lookFade(look));
    },
    /** Multiply the ribbons' brightness: a debugging aid for finding them in a screenshot, never a look. */
    setGainScale(k) { gainScale = k; uniforms.uGain.value = unit * fade * gainScale; ctx.app?.invalidate?.(); },
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
        ...(quality ? { level, classes: VALLEY_CLASSES[level] || data.classes } : {}),
      };
    },
    mesh, uniforms,
    dispose() {
      offQuality();
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
      shapes.dispose();
    },
  };
  mesh.userData.part = part; // for tests/manual/valley-shots.mjs, which finds it in the scene
  return part;
}
