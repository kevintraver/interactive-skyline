// Drawing the placed vehicles (plan 02, D6.4): one InstancedMesh per body and level of detail (twelve
// draw calls at most) and one for the contact shadows, filled each frame from the fleet's placement and
// the camera. No allocation per frame: instance buffers have fixed capacities (a frame with more
// vehicles than that drops the farthest-listed ones and counts them in stats().dropped).
//
// Level of detail by size on screen. A freeway's vehicles are seen mostly end on, so a body's size is the
// mean of its width and height (1.65 m for a sedan, 3.35 m for a tractor-trailer). A body is drawn
// detailed while that covers at least LOD0_PX pixels, coarse down to MIN_PX, and not at all below; it
// dissolves between MIN_PX and MIN_PX + FADE_PX so the hand-over to nothing (and, at night, to the light
// sprites) never pops. The detailed level (about 600 triangles) is the near one; the coarse (about 60)
// carries the rest. With the default 50 mm lens at 1280 x 720 that is detailed to about 210 m for a sedan
// and coarse to about 1 km; the fleet's range (rangeFor) ends 30% beyond that, where the trucks, still
// 4 to 5 pixels, dissolve over its last 150 m.
//
// Lamp points (for the light sprites, D6.4's next step): lampPoints() lists every lamp of every vehicle
// drawn this frame, from vehicles.json's lamp positions:
//   { count, position: Float32Array(3n) scene metres, facing: Float32Array(3n) unit vector the lens faces,
//     kind: Uint8Array (LAMP_KIND: 0 head, 1 tail, 2 brake, 3 marker), colour: Uint8Array (0 white, 1 red,
//     2 amber), id: Float64Array the vehicle's id, alpha: Float32Array the vehicle's dissolve (0..1),
//     distance: Float32Array metres from the camera }
// Tail lamps are always listed (kind 1); a braking vehicle adds its tail lamps and the high-mounted stop
// lamp again as kind 2. Side markers and the trucks' clearance and identification lamps are kind 3. The
// arrays are reused: read them before the next frame.
import * as THREE from 'three';
import { BODY_NAMES } from './fleet.js';
import { createBodyMaterial, createShadowMaterial, createTrafficUniforms, LAMP } from './material.js';

export const LOD0_PX = 14;
export const MIN_PX = 3;
export const FADE_PX = 2;
export const LAMP_KIND = Object.freeze({ head: 0, tail: 1, brake: 2, marker: 3 });
const CAPACITY = [384, 1536]; // instances per body: detailed, coarse
const SHADOW_CAPACITY = 2048;
const LAMP_CAPACITY = 2048 * 8;

// lens colours baked in COLOR_0 (0..255, linear): see public/models/drive/vehicles.glb
const HEAD_LENS = [149, 156, 164];
const TAIL_LENS = [51, 2, 2];

/** Per-vertex `_lamp` from the baked lens colours (exact matches only). */
function lampAttribute(geo) {
  const c = geo.getAttribute('color');
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n);
  if (c) {
    const norm = c.normalized || c.array instanceof Float32Array ? 1 : 255;
    for (let i = 0; i < n; i++) {
      const r = Math.round((c.getX(i) * 255) / norm), g = Math.round((c.getY(i) * 255) / norm), b = Math.round((c.getZ(i) * 255) / norm);
      if (r === HEAD_LENS[0] && g === HEAD_LENS[1] && b === HEAD_LENS[2]) a[i] = LAMP.head;
      else if (r === TAIL_LENS[0] && g === TAIL_LENS[1] && b === TAIL_LENS[2]) a[i] = LAMP.tail;
    }
  }
  return new THREE.BufferAttribute(a, 1);
}

/** A body's lamps from vehicles.json as flat arrays in its model frame (x right, y up, z rear). */
function lampTemplate(spec) {
  const L = spec.lamps || {};
  const pts = [];
  const add = (p, facing, kind, colour, brakeOnly = false) => { if (p) pts.push({ p, facing, kind, colour, brakeOnly }); };
  const FRONT = [0, 0, -1], REAR = [0, 0, 1], LEFT = [-1, 0, 0], RIGHT = [1, 0, 0];
  for (const p of L.head || []) add(p, FRONT, LAMP_KIND.head, 0);
  for (const p of L.tail || []) add(p, REAR, LAMP_KIND.tail, 1);
  for (const p of L.tail || []) add(p, REAR, LAMP_KIND.brake, 1, true);
  if (L.chmsl) add(L.chmsl, REAR, LAMP_KIND.brake, 1, true);
  (L.side_marker_front || []).forEach((p, i) => add(p, i === 0 ? LEFT : RIGHT, LAMP_KIND.marker, 2));
  (L.side_marker_rear || []).forEach((p, i) => add(p, i === 0 ? LEFT : RIGHT, LAMP_KIND.marker, 1));
  const FACING = { front: FRONT, rear: REAR, left: LEFT, right: RIGHT };
  for (const c of L.clearance || []) add(c.p, FACING[c.facing] || FRONT, LAMP_KIND.marker, c.color === 'red' ? 1 : 2);
  return {
    n: pts.length,
    p: Float32Array.from(pts.flatMap((x) => x.p)),
    f: Float32Array.from(pts.flatMap((x) => x.facing)),
    kind: Uint8Array.from(pts.map((x) => x.kind)),
    colour: Uint8Array.from(pts.map((x) => x.colour)),
    brakeOnly: Uint8Array.from(pts.map((x) => (x.brakeOnly ? 1 : 0))),
  };
}

/** Palette (vehicles.json) as linear RGB with cumulative weights. */
function paletteOf(sidecar) {
  const colours = sidecar.palette?.colors?.length ? sidecar.palette.colors : [{ hex: 'A9ADB1', weight: 1 }];
  const total = colours.reduce((a, c) => a + (c.weight ?? 1), 0);
  const rgb = new Float32Array(colours.length * 3), cum = new Float32Array(colours.length);
  let acc = 0;
  const col = new THREE.Color();
  colours.forEach((c, i) => {
    col.setStyle(`#${c.hex}`, THREE.SRGBColorSpace); // stored linear
    rgb[3 * i] = col.r; rgb[3 * i + 1] = col.g; rgb[3 * i + 2] = col.b;
    acc += (c.weight ?? 1) / total;
    cum[i] = acc;
  });
  cum[cum.length - 1] = 1;
  return { rgb, cum, n: colours.length };
}

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * @param {{ parent: THREE.Object3D, sidecar: object, gltf: object }} opts sidecar: vehicles.json; gltf: the loaded vehicles.glb
 */
export function createTrafficRenderer({ parent, sidecar, gltf }) {
  const shared = createTrafficUniforms();
  const group = new THREE.Group();
  group.name = 'traffic';
  parent.add(group);
  const palette = paletteOf(sidecar);
  const specs = BODY_NAMES.map((name) => sidecar.bodies[name]);
  const lengths = specs.map((s) => s.length);
  const widths = specs.map((s) => s.width);
  const sizes = specs.map((s) => (s.width + s.height) / 2);
  const templates = specs.map(lampTemplate);

  const meshes = []; // [body][lod]
  const materials = [];
  for (let b = 0; b < BODY_NAMES.length; b++) {
    const row = [];
    for (let lod = 0; lod < 2; lod++) {
      const src = gltf.scene.getObjectByName(specs[b].nodes[`lod${lod}`]);
      if (!src || !src.geometry) throw new Error(`vehicles.glb has no ${specs[b].nodes[`lod${lod}`]}`);
      const geo = src.geometry.clone();
      geo.setAttribute('_lamp', lampAttribute(geo));
      if (!geo.getAttribute('_paint')) geo.setAttribute('_paint', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(1), 1));
      const cap = CAPACITY[lod];
      const it = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
      it.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iTraffic', it);
      const mat = createBodyMaterial(src.material, shared);
      materials.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `traffic-${BODY_NAMES[b]}-lod${lod}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      row.push(mesh);
    }
    meshes.push(row);
  }
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // XZ plane, normal +Y
  const iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(SHADOW_CAPACITY), 1);
  iAlpha.setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute('iAlpha', iAlpha);
  const shadowMat = createShadowMaterial(shared);
  const shadows = new THREE.InstancedMesh(quad, shadowMat, SHADOW_CAPACITY);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.count = 0;
  shadows.frustumCulled = false;
  shadows.renderOrder = -1; // before the bodies: drawn over the road, under the wheels
  shadows.name = 'traffic-shadows';
  shadows.matrixAutoUpdate = false;
  group.add(shadows);

  // per frame, reused
  const counts = new Int32Array(BODY_NAMES.length * 2);
  const drawnIdx = new Int32Array(SHADOW_CAPACITY);
  const drawnAlpha = new Float32Array(SHADOW_CAPACITY);
  const drawnDist = new Float32Array(SHADOW_CAPACITY);
  let drawnCount = 0, dropped = 0, lampFrame = -1, frameNo = 0, lastPlaced = null;
  const frustum = new THREE.Frustum(), projScreen = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const lamps = {
    count: 0,
    position: new Float32Array(LAMP_CAPACITY * 3), facing: new Float32Array(LAMP_CAPACITY * 3),
    kind: new Uint8Array(LAMP_CAPACITY), colour: new Uint8Array(LAMP_CAPACITY), id: new Float64Array(LAMP_CAPACITY),
    alpha: new Float32Array(LAMP_CAPACITY), distance: new Float32Array(LAMP_CAPACITY),
  };

  /** Pixels per metre at 1 m for this camera and viewport height. */
  const pxScale = (camera, height) => height / (2 * Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1));

  /**
   * The range (m) beyond which even the largest body is below MIN_PX, capped at `cap`: the fleet's
   * enumeration range for this camera.
   */
  function rangeFor(camera, height, cap = 2000) {
    const k = pxScale(camera, height);
    // where a sedan is MIN_PX, and 30% more so the larger bodies carry farther than the cars
    return Math.min(cap, (1.3 * sizes[0] * k) / MIN_PX);
  }

  /**
   * Fill the instance buffers from the placement, for this camera.
   * @param {object} placed fleet.place's result  @param {THREE.Camera} camera  @param {number} height viewport px
   * @param {{ s: number, range: number }} window the car's chainage and the fleet's range (vehicles dissolve over its last 150 m)
   */
  function draw(placed, camera, height, window) {
    frameNo++;
    lastPlaced = placed;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const k = pxScale(camera, height);
    counts.fill(0);
    drawnCount = 0; dropped = 0;
    const sh = shadows.instanceMatrix.array;
    const { pos, fwd, up } = placed;
    for (let i = 0; i < placed.count; i++) {
      const b = placed.body[i];
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const L = lengths[b];
      const lenPx = (sizes[b] * k) / Math.max(dist, 1);
      if (lenPx < MIN_PX) continue;
      sphere.center.set(px + up[3 * i], py + up[3 * i + 1], pz + up[3 * i + 2]);
      sphere.radius = L * 0.5 + 1.5;
      if (!frustum.intersectsSphere(sphere)) continue;
      let alpha = placed.alpha[i] * smooth((lenPx - MIN_PX) / FADE_PX);
      const ds = Math.abs(placed.s[i] - window.s);
      alpha *= smooth((window.range - ds) / 150);
      if (alpha <= 0.004) continue;
      const lod = lenPx >= LOD0_PX ? 0 : 1;
      const slot = b * 2 + lod;
      const mesh = meshes[b][lod];
      const c = counts[slot];
      if (c >= CAPACITY[lod] || drawnCount >= SHADOW_CAPACITY) { dropped++; continue; }
      counts[slot] = c + 1;
      const Fx = fwd[3 * i], Fy = fwd[3 * i + 1], Fz = fwd[3 * i + 2];
      const Ux = up[3 * i], Uy = up[3 * i + 1], Uz = up[3 * i + 2];
      const Rx = Fy * Uz - Fz * Uy, Ry = Fz * Ux - Fx * Uz, Rz = Fx * Uy - Fy * Ux;
      const m = mesh.instanceMatrix.array, o = c * 16;
      m[o] = Rx; m[o + 1] = Ry; m[o + 2] = Rz; m[o + 3] = 0;
      m[o + 4] = Ux; m[o + 5] = Uy; m[o + 6] = Uz; m[o + 7] = 0;
      m[o + 8] = -Fx; m[o + 9] = -Fy; m[o + 10] = -Fz; m[o + 11] = 0;
      m[o + 12] = px; m[o + 13] = py; m[o + 14] = pz; m[o + 15] = 1;
      // paint from the palette by the colour seed
      const u = (placed.colour[i] >>> 8) / 16777216;
      let p = 0;
      while (p < palette.n - 1 && u >= palette.cum[p]) p++;
      const col = mesh.instanceColor.array;
      col[3 * c] = palette.rgb[3 * p]; col[3 * c + 1] = palette.rgb[3 * p + 1]; col[3 * c + 2] = palette.rgb[3 * p + 2];
      const tr = mesh.geometry.attributes.iTraffic.array;
      tr[2 * c] = alpha; tr[2 * c + 1] = placed.brake[i];
      // contact shadow: the footprint a little enlarged, a few centimetres up
      const W = widths[b] + 0.35, Ls = L + 0.5, so = drawnCount * 16;
      sh[so] = Rx * W; sh[so + 1] = Ry * W; sh[so + 2] = Rz * W; sh[so + 3] = 0;
      sh[so + 4] = Ux; sh[so + 5] = Uy; sh[so + 6] = Uz; sh[so + 7] = 0;
      sh[so + 8] = -Fx * Ls; sh[so + 9] = -Fy * Ls; sh[so + 10] = -Fz * Ls; sh[so + 11] = 0;
      sh[so + 12] = px + Ux * 0.03; sh[so + 13] = py + Uy * 0.03; sh[so + 14] = pz + Uz * 0.03; sh[so + 15] = 1;
      iAlpha.array[drawnCount] = alpha;
      drawnIdx[drawnCount] = i;
      drawnAlpha[drawnCount] = alpha;
      drawnDist[drawnCount] = dist;
      drawnCount++;
    }
    for (let b = 0; b < BODY_NAMES.length; b++) {
      for (let lod = 0; lod < 2; lod++) {
        const mesh = meshes[b][lod], c = counts[b * 2 + lod];
        mesh.count = c;
        mesh.visible = c > 0;
        if (!c) continue;
        upload(mesh.instanceMatrix, c * 16);
        upload(mesh.instanceColor, c * 3);
        upload(mesh.geometry.attributes.iTraffic, c * 2);
      }
    }
    shadows.count = drawnCount;
    shadows.visible = drawnCount > 0;
    if (drawnCount) { upload(shadows.instanceMatrix, drawnCount * 16); upload(iAlpha, drawnCount); }
  }

  // upload only the instances in use, through one range object per attribute (three's addUpdateRange
  // would allocate one a frame; the renderer empties the list after each upload)
  const ranges = new Map();
  function upload(attr, n) {
    let r = ranges.get(attr);
    if (!r) { r = { start: 0, count: 0 }; ranges.set(attr, r); }
    r.count = n;
    attr.updateRanges.length = 0;
    attr.updateRanges.push(r);
    attr.needsUpdate = true;
  }

  /** The lamps of the vehicles drawn this frame (see the header). Built on the first call per frame. */
  function lampPoints() {
    if (lampFrame === frameNo) return lamps;
    lampFrame = frameNo;
    let n = 0;
    const placed = lastPlaced;
    if (placed) {
      for (let q = 0; q < drawnCount; q++) {
        const i = drawnIdx[q];
        const b = placed.body[i], T = templates[b];
        const px = placed.pos[3 * i], py = placed.pos[3 * i + 1], pz = placed.pos[3 * i + 2];
        const Fx = placed.fwd[3 * i], Fy = placed.fwd[3 * i + 1], Fz = placed.fwd[3 * i + 2];
        const Ux = placed.up[3 * i], Uy = placed.up[3 * i + 1], Uz = placed.up[3 * i + 2];
        const Rx = Fy * Uz - Fz * Uy, Ry = Fz * Ux - Fx * Uz, Rz = Fx * Uy - Fy * Ux;
        const braking = placed.brake[i];
        for (let j = 0; j < T.n; j++) {
          if (T.brakeOnly[j] && !braking) continue;
          if (n >= LAMP_CAPACITY) break;
          const x = T.p[3 * j], y = T.p[3 * j + 1], z = T.p[3 * j + 2];
          lamps.position[3 * n] = px + Rx * x + Ux * y - Fx * z;
          lamps.position[3 * n + 1] = py + Ry * x + Uy * y - Fy * z;
          lamps.position[3 * n + 2] = pz + Rz * x + Uz * y - Fz * z;
          const fx = T.f[3 * j], fy = T.f[3 * j + 1], fz = T.f[3 * j + 2];
          lamps.facing[3 * n] = Rx * fx + Ux * fy - Fx * fz;
          lamps.facing[3 * n + 1] = Ry * fx + Uy * fy - Fy * fz;
          lamps.facing[3 * n + 2] = Rz * fx + Uz * fy - Fz * fz;
          lamps.kind[n] = T.kind[j];
          lamps.colour[n] = T.colour[j];
          lamps.id[n] = placed.id[i];
          lamps.alpha[n] = drawnAlpha[q];
          lamps.distance[n] = drawnDist[q];
          n++;
        }
      }
    }
    lamps.count = n;
    return lamps;
  }

  return {
    group, lengths, widths, uniforms: shared.uniforms,
    rangeFor, draw, lampPoints,
    /** Hide everything (no model for this route yet). */
    clear() {
      for (const row of meshes) for (const m of row) { m.count = 0; m.visible = false; }
      shadows.count = 0; shadows.visible = false; drawnCount = 0; lastPlaced = null; frameNo++;
    },
    stats() {
      const byLod = [0, 0];
      let calls = 0;
      for (let s = 0; s < counts.length; s++) { byLod[s & 1] += counts[s]; if (counts[s]) calls++; }
      return { drawn: drawnCount, detailed: byLod[0], coarse: byLod[1], calls: calls + (drawnCount ? 1 : 0), dropped };
    },
    dispose() {
      parent.remove(group);
      for (const row of meshes) for (const m of row) { m.geometry.dispose(); m.dispose(); }
      for (const m of materials) m.dispose();
      quad.dispose(); shadowMat.dispose(); shadows.dispose();
    },
  };
}
