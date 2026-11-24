// The windshield on plan 01's renderer (plan 02, D4.4; third stretch, decisions 2, 3 and 6): windshield.js and
// windshield.glsl.js with three/webgpu and three/tsl. The model (the dirt mask, the veil's phase function, the
// dashboard's reflection, the values each frame) is veil.js, shared with the classic renderer.
//
// Two layers:
//   - The analytic veil, as windshield.glsl.js: a mesh over the windshield opening, a child of the car, so it is drawn in
//     the scene pass with the cabin (last of the transparent objects: additive, depth-tested against the cabin and the
//     world, no depth write). It writes linear HDR: veil.js's values are in buffer units, scaled by the classic scene's
//     light at the classic display (as on the classic renderer) and by the pre-exposure in the shipped look (cd/m^2 x
//     env.nodes.exposure, decision 6). The sun and the sky are analytic; the dashboard's reflection too.
//   - The veil from the pipeline's bloom (decision 3; plan 01 section 11.8, stage `afterBloom`): the dirt mask times the
//     bloom chain, so every bright source in view (oncoming lamps, signs, a low sun's disc in the sky) scatters off the
//     dirt with no special case, which is section 7.6's design. Only where the pipeline has a bloom (the shipped look);
//     at the classic display there is none and the oncoming lamps' veil stays analytic (veil.js's lamp term), as on the
//     classic renderer. In the shipped look the analytic lamp term is off, so lamps are not counted twice.
//     The stage reads where the glass is seen from a quarter-resolution mask drawn each frame from the cabin's silhouette
//     and the glass (the dirt mask on the glass, 0 behind the dashboard, the pillars and the mirror); the same mask is
//     plan 01's metering mask.

import * as THREE from 'three';
import { Mesh, MeshBasicNodeMaterial, RenderTarget } from 'three/webgpu';
import {
  Fn, uniform, uniformArray, texture, uv, positionLocal, vec2, vec3, vec4, float, select, normalize, dot, acos, min, max, abs,
  sqrt, clamp, reflect, smoothstep, screenUV, If, luminance,
} from 'three/tsl';
import { VEIL, GLASS_N, windshieldMask, veilFrame, glassFrame } from './veil.js';
import { createTimings } from '../timing.js';
import { photometryContext } from '../lights/photometry.node.js';

const DEG = 180 / Math.PI;
/** The bloom veil: the share of the bloom chain the dirt scatters toward the eye at mask 1 (assumed: a dusty pane scatters a
 * few percent of the light through it; 0.6 drew the whole glass milky by day, with the wipers' arcs plain). */
export const BLOOM_VEIL = 0.05;

const phaseVeil = (c) => {
  const th = acos(min(c, 1)).mul(DEG);
  return select(c.greaterThan(0), c.div(th.mul(th).add(VEIL.THETA_C * VEIL.THETA_C)), float(0));
};

/** Unpolarised Fresnel reflectance of a pane, both faces (veil.js glassReflectance). */
const glassReflectance = (ci0) => {
  const ci = clamp(ci0, 1e-4, 1);
  const si = sqrt(max(0, float(1).sub(ci.mul(ci)))).div(GLASS_N);
  const ct = sqrt(max(0, float(1).sub(si.mul(si))));
  const rs = ci.sub(ct.mul(GLASS_N)).div(ci.add(ct.mul(GLASS_N)));
  const rp = ci.mul(GLASS_N).sub(ct).div(ci.mul(GLASS_N).add(ct));
  const r = rs.mul(rs).add(rp.mul(rp)).mul(0.5);
  return r.mul(2).div(r.add(1));
};

/**
 * @param {{ parent: THREE.Object3D, corners: object, options: object, env: object, pipeline?: object, renderer?: object }} o
 *   parent: the car's group (cabin coordinates); corners: the windshield's (cabin coordinates); options: a preset's
 *   `windshield`; pipeline: plan 01's, for the bloom veil (only where it has a bloom)
 */
export function createWindshield({ parent, corners, options, env, pipeline = null, renderer = null, silhouette = null }) {
  const { bottomLeft: BL, bottomRight: BR, topRight: TR, topLeft: TL } = corners;
  const { glassIn, glassOut, size: [glassW, glassH] } = glassFrame(corners);
  const phot = photometryContext({ nodes: env?.nodes });
  const classic = phot.display === 'classic';
  const [mw, mh] = options.maskSize || [512, 256];
  const maskData = windshieldMask({ width: mw, height: mh, size: [glassW, glassH] });
  const mask = new THREE.DataTexture(maskData, mw, mh, THREE.RedFormat, THREE.UnsignedByteType);
  mask.minFilter = THREE.LinearFilter; mask.magFilter = THREE.LinearFilter; mask.generateMipmaps = false;
  mask.needsUpdate = true;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...BL.toArray(), ...BR.toArray(), ...TR.toArray(), ...TL.toArray()], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const maxLamps = Math.max(1, options.lamps | 0);
  const u = {
    sunDir: uniform(new THREE.Vector3(0, 1, 0)), sun: uniform(new THREE.Color(0, 0, 0)), sky: uniform(new THREE.Color(0, 0, 0)),
    lamps: uniformArray(Array.from({ length: maxLamps }, () => new THREE.Vector4(0, 0, -1, 0)), 'vec4'),
    lampColor: uniform(new THREE.Color(1, 0.96, 0.9)), dash: uniform(new THREE.Color(0, 0, 0)),
    glassN: uniform(glassIn.clone()), eye: uniform(new THREE.Vector3(0, 1.2, 0)),
    dashRect: uniform(new THREE.Vector4(Math.min(BL.x, TL.x) - 0.05, Math.max(BR.x, TR.x) + 0.05, BL.z - 0.02, -0.66)),
    dashY: uniform(BL.y - 0.03),
  };
  const material = new MeshBasicNodeMaterial({
    name: 'windshield', transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  });
  material.colorNode = Fn(() => {
    const p = positionLocal;
    const v = normalize(p.sub(u.eye)).toVar();
    const m = texture(mask, uv()).r;
    const sun0 = u.sun.mul(phaseVeil(dot(v, u.sunDir)));
    const sun = sun0.div(luminance(sun0).div(VEIL.CAP_SUN).add(1));
    let lamp = float(0);
    for (let i = 0; i < maxLamps; i++) {
      const L = u.lamps.element(i);
      lamp = lamp.add(L.w.mul(phaseVeil(dot(v, L.xyz))));
    }
    const lampC = lamp.div(lamp.div(VEIL.CAP_LAMP).add(1));
    const col = sun.add(u.sky).add(u.lampColor.mul(lampC)).mul(m).toVar();
    // the dashboard top, mirrored in the glass
    const r = reflect(v, u.glassN);
    const t = u.dashY.sub(p.y).div(min(r.y, -1e-4));
    const h = p.add(r.mul(t));
    const R = u.dashRect;
    const inside = r.y.lessThan(-0.02).and(h.x.greaterThan(R.x)).and(h.x.lessThan(R.y)).and(h.z.greaterThan(R.z)).and(h.z.lessThan(R.w));
    const e = min(min(h.x.sub(R.x), R.y.sub(h.x)), min(h.z.sub(R.z), R.w.sub(h.z)));
    const grille = select(h.z.lessThan(R.z.add(0.07)), float(0.55), float(1));
    const dash = u.dash.mul(glassReflectance(abs(dot(v, u.glassN)))).mul(grille).mul(smoothstep(0, 0.08, e));
    return vec4(col.add(select(inside, dash, vec3(0))), 1);
  })();
  const mesh = new Mesh(geometry, material);
  mesh.name = 'windshield';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6; // the last transparent object: over the world's sprites and the rain's composite
  parent.add(mesh);

  // ---------------------------------------------------------------- the glass as seen: the bloom veil's mask and the meter's
  // A quarter-resolution picture of where the glass is seen and how dirty it is there: the cabin's silhouette (black, in
  // depth) and then the glass (r: the dirt mask, g: 1), drawn with this frame's camera. The bloom veil reads r; plan
  // 01's exposure gets it as the metering mask (r and g are 0 where the dashboard, the pillars or the mirror hide the
  // glass). The scene pass's depth cannot serve: plan 01's pipeline keeps it only when a render stage follows the scene.
  const seen = { on: uniform(0) };
  const maskScene = new THREE.Scene();
  maskScene.name = 'windshield-mask';
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  maskScene.add(holder);
  const glassMat = new MeshBasicNodeMaterial({ depthTest: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  glassMat.colorNode = vec4(texture(mask, uv()).r, 1, 0, 1);
  const glassQuad = new Mesh(geometry, glassMat);
  glassQuad.frustumCulled = false;
  holder.add(glassQuad);
  const black = new MeshBasicNodeMaterial({ color: 0x000000, side: THREE.DoubleSide, fog: false });
  const maskTarget = new RenderTarget(64, 64, { depthBuffer: true, generateMipmaps: false });
  maskTarget.texture.name = 'windshield-seen';
  maskTarget.texture.minFilter = THREE.LinearFilter; maskTarget.texture.magFilter = THREE.LinearFilter;
  let maskRenders = 0;
  const _clearC = new THREE.Color(), _black = new THREE.Color(0, 0, 0);
  /** Draw the mask for this frame's camera (`L`: rig.last), at a quarter of the scene pass's size (64 x 64 without a pipeline). */
  function drawMask(camera, L) {
    if (!renderer || !silhouette) return;
    const rt = pipeline?.scenePass?.renderTarget;
    const w = rt ? Math.max(16, Math.round(rt.width / 4)) : 64, h = rt ? Math.max(16, Math.round(rt.height / 4)) : 64;
    if (maskTarget.width !== w || maskTarget.height !== h) maskTarget.setSize(w, h);
    holder.matrix.copy(L.body);
    holder.matrixWorldNeedsUpdate = true;
    holder.updateMatrixWorld(true);
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear, alpha = renderer.getClearAlpha();
    renderer.getClearColor(_clearC);
    renderer.setRenderTarget(maskTarget);
    renderer.setClearColor(_black, 0);
    renderer.autoClear = true;
    silhouette.overrideMaterial = black;
    renderer.render(silhouette, camera);
    silhouette.overrideMaterial = null;
    renderer.autoClear = false;
    renderer.render(maskScene, camera);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(_clearC, alpha);
    renderer.autoClear = auto;
    maskRenders++;
  }

  let removeStage = null;
  const bloomVeil = !classic && pipeline && !pipeline.legacy && pipeline.settings?.bloom > 0;
  if (bloomVeil) {
    const stage = ({ color, bloom }) => Fn(() => {
      const out = vec4(color).toVar();
      If(seen.on.greaterThan(0.5), () => {
        const m = texture(maskTarget.texture, screenUV).r;
        out.assign(vec4(out.rgb.add(bloom.rgb.mul(m).mul(BLOOM_VEIL)), out.a));
      });
      return out;
    })();
    removeStage = pipeline.addStage({ id: 'cabin-veil', at: 'afterBloom', node: stage });
  }

  let enabled = options.enabled !== false;
  mesh.visible = enabled;
  const timing = createTimings();
  const picked = [];
  let last = { scenePerLux: 0, sunLux: 0, lit: 0, sunVeil: 0, lamps: [], ambient: 0 };
  const out = { sunDir: u.sunDir.value, sun: u.sun.value, sky: u.sky.value, lamps: u.lamps.array, dash: u.dash.value };
  const consts = { glassOut, maxLamps, dashboard: options.dashboard, picked };
  
  /**
   * This frame's values (veil.js veilFrame), and the bloom veil's view.
   * @param {object} o veilFrame's input, and `camera` (the scene camera), `ambientLux` (plan 01's horizontal illuminance)
   */
  function update(o) {
    if (!enabled) { seen.on.value = 0; return; }
    const t0 = performance.now();
    const over = classic ? {} : { ambient: o.ambientLux, scenePerLux: env?.nodes?.exposure?.value ?? 1 };
    last = veilFrame(bloomVeil ? { ...o, lampPoints: null } : o, out, consts, over);
    u.eye.value.setFromMatrixPosition(o.L.head);
    // the mask: every frame where the bloom veil reads it; otherwise only when the meter wants a new one
    if (o.camera && (bloomVeil || o.meterDue)) { drawMask(o.camera, o.L); seen.on.value = bloomVeil ? 1 : 0; }
    timing.add(performance.now() - t0);
  }

  return {
    mesh, material, mask, maskData, glassIn, glassOut, size: [glassW, glassH], bloomVeil,
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; mesh.visible = enabled; if (!enabled) seen.on.value = 0; },
    /** Hidden with the car (the clean view): the bloom veil goes too. */
    hide() { seen.on.value = 0; },
    /** Where the glass is seen (r: dirt, g: 1; 0 behind the cabin), as last drawn: the metering mask. */
    glassSeen: maskTarget.texture,
    update,
    stats: () => ({ enabled, bloomVeil, maskRenders, ...last, js: timing.summary() }),
    dispose() { removeStage?.(); parent.remove(mesh); geometry.dispose(); material.dispose(); glassMat.dispose(); black.dispose(); mask.dispose(); maskTarget.dispose(); },
  };
}

