// Vehicle lamps as light sprites (plan 02, D6.4): the work. lampLayer.js hands this the sprite layer's factory
// (lights/sprites.js).
//
// One sprite layer holding every lamp of every vehicle out to the sprite range, rewritten each frame. Photometry and
// switching: lamps.js.
//
// Which vehicles. Near ones from the fleet's placement (the bodies' window, exact) and far ones from the far field
// (far.js, cached per tile and moved on); in a band of NEAR_BAND_M at the ends of the bodies' window a vehicle is
// in both lists and the two weights sum to one, so nothing doubles or drops where the lists meet. Every vehicle's
// lamps are then weighted by spriteWeight (lamps.js): whole within the sprite range less its band, falling to 0
// at its end, where the ribbons (ribbon.js) take over with the complementary weight.
//
// Per lamp: position from the body's lamp positions (vehicles.json, as renderCore.js reads them), facing as its axis,
// intensity in candela x the vehicle's opacity (dissolve, ramps, the car's slot) x the weights above, a lobe
// pattern, its colour, the lens diameter, and the vehicle's switch-on threshold (lux; the shader compares it with
// the ambient illuminance). A lamp facing away from the eye (its lobe is zero there) is not written. Brake lamps
// (the stop sprites on the tail lamps and the high stop lamp) are listed while the vehicle's speed falls.
// Only the rows in use are written (sprites.js commitRows).
// Cost: beyond mergeDist (where a lamp pair's spacing is about a pixel with the current lens) a vehicle's pairs are
// one sprite each at their middle carrying both lamps' light (head, tail, stop; a truck's front and rear marker
// groups), and its side-facing markers are left out; nearer, a marker seen almost edge on (its lobe under
// MARKER_COS) is left out too. Summed light is kept either way (merged sprites carry the sum).

import { BODY_NAMES } from './fleet.js';
import * as LAMPS from './lamps.js';

// local bindings: the hot loop calls plain functions, not module-namespace getters (see demand.js)
const { LAMP_CD, LOBE, LENS_M, LAMP_RGB, vehicleThresholdLux, spriteWeight } = LAMPS;

export const CAPACITY = 16384;
export const NEAR_BAND_M = 60;
/** A marker lamp seen at more than acos(MARKER_COS) from its axis is not drawn (under a tenth of its light). */
const MARKER_COS = 0.1;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Lamps of a body (vehicles.json lamps), model frame x right, y up, z rear, with their photometry; merged: the
 * template for far away (pairs and marker groups as one lamp at their middle with their summed light). */
function templateOf(spec, pat, merged = false) {
  const L = spec.lamps || {};
  const pts = [];
  const FRONT = [0, 0, -1], REAR = [0, 0, 1], LEFT = [-1, 0, 0], RIGHT = [1, 0, 0];
  const add = (p, f, cd, rgb, pattern, lens, brakeOnly = 0) => { if (p) pts.push({ p, f, cd, rgb, pattern, lens, brakeOnly }); };
  for (const p of L.head || []) add(p, FRONT, LAMP_CD.head, LAMP_RGB.white, pat.head, LENS_M.head);
  for (const p of L.tail || []) add(p, REAR, LAMP_CD.tail, LAMP_RGB.red, pat.tail, LENS_M.tail);
  for (const p of L.tail || []) add(p, REAR, LAMP_CD.stop, LAMP_RGB.red, pat.stop, LENS_M.tail, 1);
  if (L.chmsl) add(L.chmsl, REAR, LAMP_CD.chmsl, LAMP_RGB.red, pat.chmsl, LENS_M.chmsl, 1);
  (L.side_marker_front || []).forEach((p, i) => add(p, i === 0 ? LEFT : RIGHT, LAMP_CD.amber, LAMP_RGB.amber, pat.marker, LENS_M.marker));
  (L.side_marker_rear || []).forEach((p, i) => add(p, i === 0 ? LEFT : RIGHT, LAMP_CD.red, LAMP_RGB.red, pat.marker, LENS_M.marker));
  const FACING = { front: FRONT, rear: REAR, left: LEFT, right: RIGHT };
  for (const c of L.clearance || []) {
    const red = c.color === 'red';
    add(c.p, FACING[c.facing] || FRONT, red ? LAMP_CD.red : LAMP_CD.amber, red ? LAMP_RGB.red : LAMP_RGB.amber, pat.marker, LENS_M.marker);
  }
  if (merged) {
    // one lamp per (facing, pattern, colour, brake) group at its middle with the group's light; side-facing ones go
    const groups = new Map();
    for (const x of pts) {
      if (x.f[0] !== 0) continue;
      const key = `${x.f.join()}|${x.pattern}|${x.rgb === LAMP_RGB.red ? 'r' : x.rgb === LAMP_RGB.amber ? 'a' : 'w'}|${x.brakeOnly}`;
      const g = groups.get(key);
      if (g) { g.n++; g.cd += x.cd; for (let k = 0; k < 3; k++) g.sum[k] += x.p[k]; } else groups.set(key, { ...x, n: 1, sum: x.p.slice() });
    }
    pts.length = 0;
    for (const g of groups.values()) pts.push({ ...g, p: g.sum.map((v) => v / g.n), lens: g.lens * Math.sqrt(g.n) });
  }
  const n = pts.length;
  const t = { n, p: new Float32Array(3 * n), f: new Float32Array(3 * n), cd: new Float32Array(n), rgb: new Float32Array(3 * n), pattern: new Uint8Array(n), lens: new Float32Array(n), brakeOnly: new Uint8Array(n), marker: new Uint8Array(n) };
  pts.forEach((x, i) => {
    t.p.set(x.p, 3 * i); t.f.set(x.f, 3 * i); t.rgb.set(x.rgb, 3 * i);
    t.cd[i] = x.cd; t.pattern[i] = x.pattern; t.lens[i] = x.lens; t.brakeOnly[i] = x.brakeOnly; t.marker[i] = x.pattern === pat.marker ? 1 : 0;
  });
  return t;
}

/**
 * @param {{ parent: THREE.Object3D, sidecar: object, capacity?: number, createSpriteLayer: Function, layerOptions?: object }} opts
 *   sidecar: vehicles.json; createSpriteLayer: lights/sprites.js's; layerOptions: more of its options (photometry)
 */
export function createLampLayerWith({ parent, sidecar, capacity = CAPACITY, createSpriteLayer, layerOptions = {} }) {
  const layer = createSpriteLayer({ capacity, name: 'vehicle-lamps', minPx: 1.5, halo: 0.01, renderOrder: 11, reflect: true, ...layerOptions }); // reflect: twins on wet pavement (weather)
  const pat = {
    head: layer.definePattern({ kind: 'lobe', exponent: LOBE.head }),
    tail: layer.definePattern({ kind: 'lobe', exponent: LOBE.tail }),
    stop: layer.definePattern({ kind: 'lobe', exponent: LOBE.stop }),
    chmsl: layer.definePattern({ kind: 'lobe', exponent: LOBE.chmsl }),
    marker: layer.definePattern({ kind: 'lobe', exponent: LOBE.marker }),
  };
  const templates = BODY_NAMES.map((name) => templateOf(sidecar.bodies[name], pat));
  const mergedTemplates = BODY_NAMES.map((name) => templateOf(sidecar.bodies[name], pat, true));
  /** The closest pair spacing of any body's head or tail lamps (m): pairs merge where it is about a pixel. */
  const pairSpacing = Math.min(...BODY_NAMES.flatMap((name) => ['head', 'tail'].map((k) => { const l = sidecar.bodies[name].lamps?.[k]; return l && l.length > 1 ? Math.abs(l[1][0] - l[0][0]) : Infinity; })));
  let mergeDist = Infinity;
  layer.mesh.visible = false;
  parent.add(layer.mesh);
  const [P, C, X, S] = layer.data;
  let count = 0, dropped = 0, vehicles = 0;

  /** Write one vehicle's lamps; w its weight (opacity x list weight x sprite weight). */
  function writeVehicle(px, py, pz, F, U, i3, body, braking, id, w, eye) {
    const ex = eye.x - px, ey = eye.y - py, ez = eye.z - pz;
    const dist = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
    const T = dist > mergeDist ? mergedTemplates[body] : templates[body];
    const cosMin = MARKER_COS * dist;
    const Fx = F[i3], Fy = F[i3 + 1], Fz = F[i3 + 2];
    const Ux = U[i3], Uy = U[i3 + 1], Uz = U[i3 + 2];
    const Rx = Fy * Uz - Fz * Uy, Ry = Fz * Ux - Fx * Uz, Rz = Fx * Uy - Fy * Ux;
    const thr = vehicleThresholdLux(id);
    for (let j = 0; j < T.n; j++) {
      if (T.brakeOnly[j] && !braking) continue;
      const fx = T.f[3 * j], fy = T.f[3 * j + 1], fz = T.f[3 * j + 2];
      const ax = Rx * fx + Ux * fy - Fx * fz, ay = Ry * fx + Uy * fy - Fy * fz, az = Rz * fx + Uz * fy - Fz * fz;
      // facing away from the eye: nothing to draw (the lobes are zero behind their lamps); a marker nearly edge on
      const along = ax * ex + ay * ey + az * ez;
      if (along <= 0 || (T.marker[j] && along < cosMin)) continue;
      if (count >= capacity) { dropped++; continue; }
      const x = T.p[3 * j], y = T.p[3 * j + 1], z = T.p[3 * j + 2];
      const o = 4 * count;
      P[o] = px + Rx * x + Ux * y - Fx * z;
      P[o + 1] = py + Ry * x + Uy * y - Fy * z;
      P[o + 2] = pz + Rz * x + Uz * y - Fz * z;
      P[o + 3] = T.cd[j] * w;
      C[o] = T.rgb[3 * j]; C[o + 1] = T.rgb[3 * j + 1]; C[o + 2] = T.rgb[3 * j + 2]; C[o + 3] = T.pattern[j];
      X[o] = ax; X[o + 1] = ay; X[o + 2] = az; X[o + 3] = -10;
      S[o] = thr; S[o + 1] = 0; S[o + 2] = T.lens[j]; S[o + 3] = 0;
      count++;
    }
  }

  /**
   * Rewrite the layer for this frame.
   * @param {{ near: object|null, nearWindow: { sA: number, sB: number }, far: object|null, carS: number,
   *   ahead: number, behind: number, band: number, eye: {x,y,z}, on: boolean }} f
   *   near: fleet.place's result; far: far.js collect's result; ahead/behind: the sprite range (m) and band its share
   *   handed over to the ribbons.
   */
  function update({ near, nearWindow, far, carS, ahead, behind, band, eye, on, pxPerRad = 0 }) {
    count = 0; dropped = 0; vehicles = 0;
    // pairs merge where their spacing is under 1.2 px
    mergeDist = pxPerRad > 0 ? (pairSpacing * pxPerRad) / 1.2 : Infinity;
    if (!on) { layer.commitRows(0); layer.mesh.visible = false; return; }
    const { sA, sB } = nearWindow || { sA: 0, sB: 0 };
    if (near) {
      for (let i = 0; i < near.count; i++) {
        const s = near.s[i];
        const wl = smooth((sB - s) / NEAR_BAND_M) * smooth((s - sA) / NEAR_BAND_M);
        const w = near.alpha[i] * wl * spriteWeight(s - carS, ahead, behind, band);
        if (w < 0.004) continue;
        vehicles++;
        const i3 = 3 * i;
        writeVehicle(near.pos[i3], near.pos[i3 + 1], near.pos[i3 + 2], near.fwd, near.up, i3, near.body[i], near.brake[i], near.id[i], w, eye);
      }
    }
    if (far) {
      for (let i = 0; i < far.count; i++) {
        const s = far.s[i];
        const inNear = s > sA && s < sB ? smooth((sB - s) / NEAR_BAND_M) * smooth((s - sA) / NEAR_BAND_M) : 0;
        const w = far.alpha[i] * (1 - inNear) * spriteWeight(s - carS, ahead, behind, band);
        if (w < 0.004) continue;
        vehicles++;
        const i3 = 3 * i;
        writeVehicle(far.pos[i3], far.pos[i3 + 1], far.pos[i3 + 2], far.fwd, far.up, i3, far.body[i], far.brake[i], far.id[i], w, eye);
      }
    }
    layer.commitRows(count);
    layer.mesh.visible = count > 0;
  }

  /** The lobe exponent of each pattern id (for probes: a lamp's intensity toward a direction is cd x c^n). */
  const exponents = { [pat.head]: LOBE.head, [pat.tail]: LOBE.tail, [pat.stop]: LOBE.stop, [pat.chmsl]: LOBE.chmsl, [pat.marker]: LOBE.marker };
  return {
    layer, templates, mergedTemplates, update, exponents,
    get count() { return count; },
    get mergeDist() { return mergeDist; },
    setFrame: (f) => layer.setFrame(f),
    clear() { count = 0; layer.commitRows(0); layer.mesh.visible = false; },
    stats: () => ({ sprites: count, vehicles, dropped }),
    dispose: () => layer.dispose(),
  };
}
