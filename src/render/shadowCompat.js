// `renderer.shadowMap.needsUpdate` and `.autoUpdate` on WebGPURenderer (plan 01, T2.1). The classic renderer draws
// its shadow maps on demand through those two flags, and the app (edits, picking, the key light, attractions), the
// test helpers and the landmark checker all write `renderer.shadowMap.needsUpdate = true`. WebGPURenderer has no
// such flags: each light's shadow has its own `autoUpdate` and `needsUpdate`, and a light left at the default
// redraws its shadow map every frame. This shim gives the old flags their old meaning on top of the per-light ones,
// so every writer keeps working; phase 3's cascades replace it (section 11.6).

/** Every shadow-casting light in the scene. */
export function shadowCasters(scene) {
  const out = [];
  scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow) out.push(o); });
  return out;
}

export function installShadowCompat(renderer, scene) {
  let autoUpdate = false;
  const sm = renderer.shadowMap;
  Object.defineProperty(sm, 'needsUpdate', {
    configurable: true,
    get: () => shadowCasters(scene).some((l) => l.shadow.needsUpdate),
    set(v) {
      if (!v) return;
      for (const l of shadowCasters(scene)) { l.shadow.autoUpdate = autoUpdate; l.shadow.needsUpdate = true; }
    },
  });
  Object.defineProperty(sm, 'autoUpdate', {
    configurable: true,
    get: () => autoUpdate,
    set(v) {
      autoUpdate = !!v;
      for (const l of shadowCasters(scene)) l.shadow.autoUpdate = autoUpdate;
    },
  });
}

/** Make a newly created shadow-casting light follow the on-demand rule (a no-op on the classic renderer). */
export function onDemandShadow(renderer, light) {
  if (renderer.isWebGPURenderer) light.shadow.autoUpdate = renderer.shadowMap.autoUpdate === true;
}
