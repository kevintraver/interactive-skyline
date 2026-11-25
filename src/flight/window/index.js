// The cabin window's glass (plan 03, Phase 5: F5.1 to F5.7): the one entry point the session uses.
//
//   const pane = createWindowPane({ nodes, cabin, quality, renderer })
//   pane.setTrack(track, { airAt })     the journey: frost, fog and water integrated over it (paneState.js)
//   pane.update(state, { env, sun, wallS, simMs, night, cabinLight, reducedMotion })   every frame, before drawing
//   pane.setSeat(seat)                  after cabin.setSeat(seat): the panes of the new run
//   pane.setFocus('far' | 'pane'), pane.setEffects({ frost, condensation, droplets, scratches, reflections }),
//   pane.setEnabled(on), pane.setOverride({ frost, fog, wet, mist, rainRateMmH }), pane.stats(), pane.dispose()
//
// What it draws: the modelled cabin's inner-pane quads (cabin.glb's PaneInner, placed at every open window of the run)
// with paneMaterial.js, as one instanced mesh inside the cabin's group, on the cabin's layer, last of the transparent
// objects. Inside the cabin's group, the clean view (which hides that group) shows no glass, and picking (layer 0)
// passes through it. Until the model has loaded (the code-built stand-in cabin has no panes) nothing is drawn.
//
// Time (7.5): the pane's condition is the journey's (state.t into the pane state); drops and their motion run on
// presentation time (wallS) and stand still under reduced motion; nothing flashes.
//
// The cabin's reflection needs the renderer, to draw its cube map on demand (reflection.js): pass `renderer` here or
// in update(); without it the glass reflects nothing.
//
// Plan 01's pipeline (`pipeline`): while the pane is drawn in the scene pass, it reads a copy of that pass's colour
// made half way through the pass (three's viewportMipTexture), so the pass must keep its multisampled buffers between
// the opaque and the transparent objects. The pipeline discards them when no stage needs them (keepBuffers in
// src/render/pipeline.js; on WebGPU they are then transient and cannot be loaded again, a validation error). The pane
// therefore registers an empty render stage while it is shown, which tells the pipeline to keep them; it costs the
// store of those buffers, counted in the pane's measured cost. F3.9's afterAA cabin pass removes the need.

import { Group, InstancedMesh, Matrix4, Vector3 } from 'three';
import { CABIN_LAYER } from '../cabin/cabin.js';
import { FUSELAGE, bodyZ } from '../aircraft/dimensions.js';
import { createPaneState } from './paneState.js';
import { paneFrame, RING } from './paneFrame.js';
import { createPaneMaterial } from './paneMaterial.js';
import { loadPaneTextures } from './paneTextures.js';
import { createCabinReflection } from './reflection.js';

export { createPaneState } from './paneState.js';
export { paneFrame, dropFlow } from './paneFrame.js';

/** Drawn after every other transparent object (the windshield of plan 02 uses the same value). */
export const PANE_RENDER_ORDER = 1e6;
const LEVELS = ['low', 'high', 'ultra'];
const NONE = Object.freeze({ frost: 0, fog: 0, wet: 0, mist: 0, rainRateMmH: 0, tFaceC: 20, inCloud: false });

/**
 * @param {{ nodes?: { exposure?: { value: number } }, cabin: object, quality?: string | { level: string },
 *   renderer?: object, outside?: (uv: any, level: any) => any, textureBaseUrl?: string, textureLoader?: object,
 *   effects?: object }} o
 *   cabin: createModelledCabin()'s; outside: the frame behind the pane, for F3.9's afterAA cabin pass (default: three's
 *   viewportMipTexture of the scene pass)
 */
export function createWindowPane({ nodes = {}, cabin, quality = 'high', renderer = null, pipeline = null, outside = null, textureBaseUrl, textureLoader = null, effects = null } = {}) {
  let level = typeof quality === 'string' ? quality : quality?.level ?? 'high';
  if (!LEVELS.includes(level)) level = 'high';
  const group = new Group();
  group.name = 'window-pane';
  const textures = loadPaneTextures({ ...(textureBaseUrl ? { baseUrl: textureBaseUrl } : {}), facets: true, loader: textureLoader,
    onLoad: (name, t) => { if (made?.textureNodes[name]) made.textureNodes[name].value = t; } });
  const reflection = createCabinReflection({ size: level === 'low' ? 64 : 128 });
  let made = null;
  let mesh = null, source = null, enabled = true, disposed = false;
  let paneState = null, override = null, fx = { ...(effects || {}) };
  let focusTarget = 0, focus = 0, lastWall = null;
  let rend = renderer;
  let captureKey = '';
  let last = { pane: NONE, frame: null };
  let cpuMs = 0, cpuN = 0;
  let removeKeep = null;
  /** Keep the scene pass's multisampled buffers while the pane reads a mid-pass copy (see the header). */
  function keepBuffers(on) {
    if (outside || !pipeline?.addStage || pipeline.legacy) return;
    if (on && !removeKeep) removeKeep = pipeline.addStage({ id: 'window-pane-keep-buffers', at: 'afterScene', render() {} });
    else if (!on && removeKeep) { removeKeep(); removeKeep = null; }
  }
  /** Shown: enabled, built, and every ancestor visible (the clean view hides the cabin's group). */
  function shown() {
    if (!enabled || !mesh) return false;
    for (let o = group; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  function material() {
    if (made) made.material.dispose();
    made = createPaneMaterial({ textures, level, reflection, panes: cabin.model?.info?.panes ?? {}, outside });
    // textures that arrived before this material was made
    for (const n of ['surface', 'frost', 'facets']) made.textureNodes[n].value = textures[n];
    if (mesh) mesh.material = made.material;
  }

  /** The panes of the cabin's current run: its PaneInner instances, re-made with this material. */
  function rebuild() {
    if (disposed) return;
    const src = cabin.model?.meshes?.get('PaneInner')?.[0] ?? null;
    if (mesh) { group.remove(mesh); mesh.dispose(); mesh = null; }
    source = src;
    if (!src || !src.count) return;
    if (!made) material();
    mesh = new InstancedMesh(src.geometry, made.material, src.count);
    mesh.name = 'window-pane-glass';
    for (let i = 0; i < src.count; i++) { src.getMatrixAt(i, _m); mesh.setMatrixAt(i, _m); }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.layers.set(CABIN_LAYER);
    mesh.renderOrder = PANE_RENDER_ORDER;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    group.add(mesh);
    captureKey = ''; // the reflection is drawn again for the new run
  }
  const _m = new Matrix4();

  if (cabin?.group) cabin.group.add(group);
  const ready = Promise.resolve(cabin?.ready).then(() => { if (!disposed) { material(); rebuild(); } return api; });

  /** Where the cube is drawn: the own window's inner pane, 3 cm inboard (the cabin group's axes). */
  function capturePosition(out) {
    const lay = cabin.model?.layout;
    const r = (cabin.model?.info?.panes?.PaneInner ?? 1.8368) - 0.03;
    const sign = lay?.sign ?? 1;
    const station = lay?.own ?? lay?.bays?.[0]?.station ?? 0;
    return out.set(sign * r * Math.cos(RING), FUSELAGE.axisY + r * Math.sin(RING), bodyZ(station));
  }
  const _cap = new Vector3();

  const api = {
    group,
    ready,
    get mesh() { return mesh; },
    get uniforms() { return made?.uniforms ?? null; },
    get level() { return level; },
    get enabled() { return enabled; },
    textures,
    reflection,

    /** The journey: the pane state is integrated over the track once (and again when `airAt` changes). */
    setTrack(track, { airAt = null } = {}) {
      paneState = track ? createPaneState(track, { airAt }) : null;
      return api;
    },
    /** The pane state over the journey (paneState.js), or null. */
    get paneState() { return paneState; },
    /** Override the pane's condition (the harness, the effects panel's debug): any of frost, fog, wet, mist,
     * rainRateMmH; null to follow the journey again. */
    setOverride(o) { override = o ? { ...o } : null; return api; },

    /**
     * Every frame, before drawing.
     * @param {object} state  the AircraftState (quaternion, airVelocity, t, cabinLight)
     * @param {{ env?: object, sun?: { dir: Vector3, illuminanceLux: number, color?: { r: number, g: number, b: number } },
     *   wallS?: number, simMs?: number, night?: boolean, cabinLight?: number, reducedMotion?: boolean, exposure?: number,
     *   ambientLux?: number, renderer?: object }} [o]  ambientLux: the sky's diffuse illuminance (default env.lightAt())
     */
    update(state, { env = null, sun = undefined, wallS = 0, night = false, cabinLight, reducedMotion = false, exposure, ambientLux, renderer: r = null } = {}) {
      const t0 = performance.now();
      if (r) rend = r;
      keepBuffers(shown());
      if (!made) return api;
      const side = (cabin.model?.layout?.sign ?? (cabin.seat?.side === 'left' ? -1 : 1)) < 0 ? 'left' : 'right';
      const fromJourney = paneState ? paneState.at(state?.t ?? 0) : NONE;
      const pane = override ? { ...NONE, ...fromJourney, ...override } : fromJourney;
      const sunIn = sun !== undefined ? sun : env?.state?.sun ? { dir: env.state.sun.dir, illuminanceLux: env.state.sun.illuminanceLux, color: env.state.sun.color } : null;
      const k = Number.isFinite(exposure) ? exposure : nodes?.exposure?.value ?? 1;
      const light = Number.isFinite(cabinLight) ? cabinLight : Number.isFinite(state?.cabinLight) ? state.cabinLight : 1;
      let amb = ambientLux;
      if (!Number.isFinite(amb) && env?.lightAt && state?.position) { try { amb = env.lightAt(state.position)?.ambientLux; } catch { amb = 0; } }
      const f = paneFrame({ state, pane, side, sun: sunIn, exposure: k, wallS, cabinLight: light, reducedMotion, effects: fx, ambientLux: amb });
      const u = made.uniforms;
      u.sunBody.value.copy(f.sunBody);
      u.sunE.value = f.sunE;
      if (sunIn?.color) u.sunColor.value.set(sunIn.color.r, sunIn.color.g, sunIn.color.b);
      u.frost.value = f.frost;
      u.fog.value = f.fog;
      u.wet.value = f.wet;
      u.mist.value = f.mist;
      u.rain.value = f.rainRateMmH;
      u.scratches.value = f.scratches;
      u.transmission.value = f.transmission;
      u.ambient.value = f.ambient;
      u.timeS.value = f.timeS;
      u.flow.value.set(f.flow.u, f.flow.v, f.flow.speed);
      // focus pulls over about a third of a second of presentation time; at once under reduced motion
      const dt = lastWall === null || reducedMotion ? Infinity : Math.max(0, wallS - lastWall);
      lastWall = wallS;
      focus = dt === Infinity ? focusTarget : focus + (focusTarget - focus) * (1 - Math.exp(-dt / 0.12));
      u.focus.value = focus;
      // the cabin's reflection: drawn again for a new run, a change of night and day, or a moved shade
      const shade = Number.isFinite(cabin.shade) ? cabin.shade : 0;
      const key = `${source?.uuid}|${night ? 1 : 0}|${Math.round(shade * 20)}`;
      if (rend && mesh && cabin.model && key !== captureKey && f.reflection > 0) {
        if (reflection.capture({ renderer: rend, cabin, position: capturePosition(_cap), hide: [group], night, exposureNow: k })) captureKey = key;
        u.capture.value.copy(_cap);
      }
      u.reflection.value = reflection.valid ? f.reflection * (k / (reflection.exposure || k || 1)) : 0;
      last = { pane, frame: f };
      cpuMs += performance.now() - t0;
      cpuN++;
      return api;
    },

    /** After cabin.setSeat(seat): the panes of the new run (and the reflection is drawn again). */
    setSeat() { rebuild(); return api; },
    /** Key F: focused far (the default) or on the pane. */
    setFocus(where) { focusTarget = where === 'pane' ? 1 : 0; return api; },
    get focus() { return focusTarget ? 'pane' : 'far'; },
    /** Switch effects: { frost, condensation, droplets, scratches, reflections, transmission } (each true by default). */
    setEffects(o) { fx = { ...fx, ...(o || {}) }; return api; },
    get effects() { return { frost: true, condensation: true, droplets: true, scratches: true, reflections: true, transmission: true, ...fx }; },
    /** The clean view's glass: off removes the pane from the picture and from the frame's cost. */
    setEnabled(on) { enabled = !!on; group.visible = enabled; if (!enabled) keepBuffers(false); return api; },
    /** Another preset: the material is made again with that preset's taps. */
    setQuality(q) {
      const next = typeof q === 'string' ? q : q?.level;
      if (LEVELS.includes(next) && next !== level) { level = next; if (made) material(); }
      return api;
    },
    stats() {
      const instances = mesh ? mesh.count : 0;
      const g = mesh?.geometry;
      const triPer = g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0;
      const drawn = enabled && instances > 0;
      return {
        enabled, level, instances, drawCalls: drawn ? 1 : 0, triangles: drawn ? instances * triPer : 0,
        taps: made?.taps ?? 0, textureBytes: textures.bytes, cubeBytes: reflection.bytes, texturesLoaded: textures.loaded,
        textureErrors: textures.errors.slice(), captures: reflection.captures, captureMs: +reflection.lastMs.toFixed(2),
        cpuMs: cpuN ? +(cpuMs / cpuN).toFixed(4) : 0, focus: api.focus, effects: api.effects,
        pane: { ...last.pane }, sunE: last.frame?.sunE ?? 0, reflection: made?.uniforms.reflection.value ?? 0,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      keepBuffers(false);
      if (group.parent) group.parent.remove(group);
      if (mesh) { group.remove(mesh); mesh.dispose(); mesh = null; }
      if (made) made.material.dispose();
      textures.dispose();
      reflection.dispose();
    },
  };
  return api;
}
