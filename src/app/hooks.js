// window.__skyline: hooks for automated checks. A tested contract (tests/e2e/hooks.spec.js): the landmark
// skill's checker and the test suites drive the app through it. Members may be added, never removed or changed.
import * as THREE from 'three';
import { isHidden, isMoved } from '../interaction/edits.js';
import { createPerf } from '../render/perf.js';
import { createCapture } from '../render/capture.js';
import * as uniforms from '../render/materials/shared.js';
import { MeshBasicNodeMaterial, Mesh, PlaneGeometry, MeshBasicMaterial } from 'three/webgpu';
import { vec3, vec4 } from 'three/tsl';

const lerp = THREE.MathUtils.lerp;

export function installHooks(app) {
  const { tall, renderer, scene, camera, controls, sky, invalidate, settings } = app;
  window.__skyline = {
    tall, renderer, scene, camera, controls, sun: sky.sun, invalidate, settings, setSetting: app.setSetting, focusOn: app.focusOn,
    flying: app.flying,
    setView: app.views.set,
    select: (id) => app.select(tall.find((e) => e.data.id === id) || null),
    selectedId: () => app.selected && app.selected.data.id,
    /** Screen position of a building: near its top while standing, its ground marker once hidden. */
    screen(id) {
      const t = tall.find((e) => e.data.id === id);
      const box = new THREE.Box3().setFromObject(isHidden(t) ? t.marker : t.mesh);
      const p = box.getCenter(new THREE.Vector3());
      if (!isHidden(t)) p.y = lerp(box.min.y, box.max.y, 0.8);
      p.project(camera);
      return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, visible: t.mesh.visible };
    },
    place: app.place, movedIds: () => tall.filter(isMoved).map((t) => t.data.id),
    hiddenIds: () => tall.filter((t) => !t.mesh.visible).map((t) => t.data.id),
    perf: createPerf(app),
    // plan 01, phase 1 (section 8.6): the simulation clock, the environment and the frame loop
    clock: app.clock, env: app.env, loop: app.loop, timeline: app.timeline, transport: app.transport,
    // the explore camera's limits (src/interaction/cameraLimits.js): `enabled` off stands them down for other modes
    cameraLimits: app.cameraLimits,
    // plan 01, phase 2: which renderer and backend draw ('webgpu' | 'webgl2' on WebGPURenderer, 'webgl' for the
    // classic renderer behind ?renderer=legacy), why, and one frame as a PNG blob
    backend: app.backend, rendererInfo: { kind: app.rendererKind, backend: app.backend, reason: app.backendReason },
    capture: createCapture({ ...app, draw: app.draw }),
    pipeline: app.pipeline, look: app.look || null, quality: app.quality || null,
    /** pipeline.probe(): scene-referred light at a point of the screen, before exposure (T2.4) */
    probe: (x, y) => app.pipeline.probe(x, y),
    /** the uniforms every material shares (night, clock, haze, exposure, physical, switchOn, legacyScale, ...) */
    uniforms,
    /** a few three/webgpu and three/tsl names, for tests that add their own node materials (probe, stages) */
    webgpu: { MeshBasicNodeMaterial, Mesh, PlaneGeometry, MeshBasicMaterial }, tsl: { vec3, vec4 },
    /** three.js's Raycaster and Vector3, for the stability tools (tools/stability/pair.mjs names the surfaces that fight) */
    three: { Raycaster: THREE.Raycaster, Vector3: THREE.Vector3 },
  };
  return window.__skyline;
}
