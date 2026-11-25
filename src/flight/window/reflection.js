// The cabin as the glass mirrors it (plan 03, section 7.7, "Cabin reflection"; F5.5): a cube map rendered from the
// modelled cabin at the passenger's own pane, with the cabin's lights at full (cabinLight 1); the pane scales it by the
// flight's cabinLight channel and by how the pre-exposure has moved since. Because the app's light is in physical
// units, the reflection shows by itself when the outside is dark and vanishes by day.
//
// Rendered on demand, not every frame: when the model arrives, on a new seat, when night turns to day or back (the
// lights' tint), and when the own shade moves. The cabin's group is lent to a scene of its own for the six renders
// (so no sky, no world and no scene lights get in: what the cube holds is the cabin's own light, in body axes) and
// handed straight back to its parent.

import { Scene, CubeCamera, Vector3, Color, HalfFloatType } from 'three';
import { CubeRenderTarget } from 'three/webgpu';
import { CABIN_LAYER } from '../cabin/cabin.js';

/**
 * @param {{ size?: number }} [o]  size: the cube's face, texels (128 on High and Ultra, 64 on Low)
 */
export function createCabinReflection({ size = 128 } = {}) {
  const target = new CubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: true });
  target.texture.name = 'window-cabin-reflection';
  const camera = new CubeCamera(0.02, 12, target);
  camera.layers.set(CABIN_LAYER);
  for (const c of camera.children) c.layers.set(CABIN_LAYER);
  const scene = new Scene();
  scene.name = 'window-reflection-capture';
  let captures = 0, lastMs = 0, exposure = 1, valid = false;
  const _clear = new Color();

  return {
    target,
    texture: target.texture,
    get valid() { return valid; },
    get captures() { return captures; },
    get lastMs() { return lastMs; },
    /** The pre-exposure when the cube was drawn (the pane multiplies by now / then). */
    get exposure() { return exposure; },
    /** GPU bytes: six half-float RGBA faces with mips. */
    get bytes() { return Math.round(size * size * 6 * 8 * (4 / 3)); },
    /**
     * Draw the cube from `position` (the cabin group's axes, metres) with the cabin's lights at full.
     * @param {{ renderer: object, cabin: { group: import('three').Object3D, model?: object }, position: Vector3,
     *   hide?: import('three').Object3D[], night?: boolean, exposureNow?: number }} o
     */
    capture({ renderer, cabin, position, hide = [], night = false, exposureNow = 1 }) {
      if (!renderer || !cabin?.model) return false;
      const t0 = performance.now();
      const g = cabin.group, parent = g.parent;
      const index = parent ? parent.children.indexOf(g) : -1;
      const mats = cabin.model.materials;
      const before = mats ? mats.cabinLight : 1;
      // the night setting the cabin has now (a share through the twilight, cabin.js nightShare), not only the flag:
      // the cube's lamps are the cabin's at full on the setting in use
      const nightNow = typeof mats?.night === 'number' ? mats.night : night;
      // the cube is the cabin's own lamps only: the outside's light in the cabin (cabin.js createCabinLight) is off
      // while it is drawn, or a cube drawn by day, rescaled by the exposure at dusk, mirrors a daylit cabin forty times over
      const outsideBefore = mats?.outside ?? null;
      const shown = hide.map((o) => o.visible);
      const auto = renderer.autoClear, alpha = renderer.getClearAlpha();
      renderer.getClearColor(_clear);
      try {
        if (parent) parent.remove(g);
        scene.add(g);
        for (const o of hide) o.visible = false;
        if (mats) mats.set({ cabinLight: 1, night: nightNow, ...(outsideBefore ? { windowL: 0, sunLux: 0 } : {}) });
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 1);
        camera.position.copy(position);
        scene.updateMatrixWorld(true);
        camera.update(renderer, scene);
        exposure = exposureNow;
        valid = true;
        captures++;
      } finally {
        scene.remove(g);
        if (parent) { parent.add(g); if (index >= 0) { parent.children.splice(parent.children.indexOf(g), 1); parent.children.splice(index, 0, g); } }
        hide.forEach((o, i) => { o.visible = shown[i]; });
        if (mats) mats.set({ cabinLight: before, night: nightNow, ...(outsideBefore ?? {}) });
        renderer.autoClear = auto;
        renderer.setClearColor(_clear, alpha);
        g.updateMatrixWorld(true);
      }
      lastMs = performance.now() - t0;
      return true;
    },
    invalidate() { valid = false; },
    dispose() { target.dispose(); },
  };
}

export { Vector3 };
