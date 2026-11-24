// The airframe v0 (plan 03, sections 6.5, 7.8; F1.5): the visible outside of a 737-800-class aircraft, generated in
// code from the published dimensions in dimensions.js. Plain lofts in plain grey-white, no logos or lettering. The
// modelled airframe of Phase 3 (a GLB with moving parts, F3.3) replaces it; this one stays as the fallback while that
// loads, so it is kept light (about 6,000 triangles).
//
// Body axes (section 5.5): nose -Z, right wing +X, up +Y, origin at the main gear's contact point on the centre line.
// One group, placed by an AircraftState's position and quaternion (placeAirframe).
//
// The wing is lofted from cambered sections along a planform with a straight leading edge and a kinked trailing edge,
// on 6 degrees of dihedral; the blended winglet continues the same loft round a circular blend into a canted panel, so
// there is no seam at the tip. Every surface is oriented outward (from inside the fuselage nothing of it is seen,
// which is what the cabin wants: its own sidewall frames the view).

import { BufferGeometry, Float32BufferAttribute, Group, Mesh } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { FUSELAGE, WING, WINGLET, ENGINE, TAIL, bodyZ } from './dimensions.js';

const RAD = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- planform

const SIDE = FUSELAGE.width / 2; // the fuselage side, where the published root chord is
const KINK = SIDE + WING.kinkFromSide;
const TIP = WING.span / 2;
const TAN_DIHEDRAL = Math.tan(WING.dihedral * RAD);

/**
 * The wing at `out` metres from the centre line: leading and trailing edge stations, chord, thickness ratio and the
 * height of the chord plane. Inboard of the fuselage side the root section carries on (the wing box under the floor).
 * @param {number} out
 */
export function wingPlanform(out) {
  const o = Math.min(Math.max(out, SIDE), TIP);
  const le = lerp(WING.rootLE, WING.tipLE, (o - SIDE) / (TIP - SIDE));
  const kinkLE = lerp(WING.rootLE, WING.tipLE, WING.kinkFromSide / (TIP - SIDE));
  const kinkTE = kinkLE + WING.kinkChord;
  const te = o <= KINK ? lerp(WING.rootTE, kinkTE, (o - SIDE) / (KINK - SIDE)) : lerp(kinkTE, WING.tipTE, (o - KINK) / (TIP - KINK));
  const [t0, t1, t2] = WING.thickness;
  const t = o <= KINK ? lerp(t0, t1, (o - SIDE) / (KINK - SIDE)) : lerp(t1, t2, (o - KINK) / (TIP - KINK));
  return { le, te, chord: te - le, t, y: WING.tipY - (TIP - out) * TAN_DIHEDRAL };
}

// ---------------------------------------------------------------- sections

/** Chordwise stations, cosine-spaced so the leading edge is round. */
const U = Array.from({ length: 13 }, (_, i) => (1 - Math.cos((Math.PI * i) / 12)) / 2);

/** NACA four-digit thickness (closed trailing edge) and a 2 % camber line at 40 %: a section that reads as a wing. */
function aerofoil(t, camber = 0.02) {
  const pts = [];
  const yt = (u) => 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const yc = (u) => (u < 0.4 ? (camber / 0.16) * (0.8 * u - u * u) : (camber / 0.36) * (0.2 + 0.8 * u - u * u));
  // upper surface trailing edge to leading edge, then lower back to the trailing edge (the edge point is doubled, so
  // the trailing edge stays sharp under smooth normals)
  for (let i = U.length - 1; i >= 0; i--) pts.push([U[i], yc(U[i]) + yt(U[i])]);
  for (let i = 1; i < U.length; i++) pts.push([U[i], yc(U[i]) - yt(U[i])]);
  return pts;
}

/**
 * Place a 2-D section (u along the chord, h along the section's normal, both in chords) in body space: leading edge
 * at `le`, chord `c` toward +Z, normal `n`.
 */
const place = (sec, le, c, n) => sec.map(([u, h]) => [le[0] + h * c * n[0], le[1] + h * c * n[1], le[2] + u * c + h * c * n[2]]);

/** The wing and winglet of one side (sign +1 right, -1 left) as a list of sections from root to winglet tip. */
function wingSections(sign) {
  const out = [];
  const normal = (phi) => [-sign * Math.sin(phi), Math.cos(phi), 0];
  for (const o of [0.9, SIDE, 3.2, 4.83, 6.1, KINK, 9.4, 11.4, 13.4, 15.3, TIP]) {
    const p = wingPlanform(o);
    out.push(place(aerofoil(p.t), [sign * o, p.y, bodyZ(p.le)], p.chord, normal(WING.dihedral * RAD)));
  }
  // the winglet: a circular blend from the dihedral to the panel angle, then the straight panel; chord and stations
  // run from the bare tip's to the published base width and last point
  const tip = wingPlanform(TIP);
  const phi0 = WING.dihedral * RAD, phi1 = WINGLET.panelAngle * RAD, r = WINGLET.blendRadius;
  const blendLen = r * (phi1 - phi0), total = blendLen + WINGLET.panelLength;
  const n0 = normal(phi0);
  const centre = [sign * TIP + r * n0[0], tip.y + r * n0[1]];
  const steps = [0.2, 0.4, 0.6, 0.8, 1].map((f) => f * blendLen).concat([0.45, 0.8, 1].map((f) => blendLen + f * WINGLET.panelLength));
  for (const s of steps) {
    const phi = s <= blendLen ? phi0 + s / r : phi1;
    const n = normal(phi);
    let x = centre[0] - r * n[0], y = centre[1] - r * n[1];
    if (s > blendLen) { const l = s - blendLen; x += sign * Math.cos(phi1) * l; y += Math.sin(phi1) * l; }
    const f = s / total;
    const chord = s <= blendLen ? lerp(tip.chord, WINGLET.baseChord, s / blendLen) : lerp(WINGLET.baseChord, WINGLET.tipChord, (s - blendLen) / WINGLET.panelLength);
    const te = lerp(WING.tipTE, WINGLET.lastPoint, f);
    out.push(place(aerofoil(lerp(tip.t, 0.08, f), 0.01), [x, y, bodyZ(te - chord)], chord, n));
  }
  return out;
}

/** An elliptical ring about an axis along Z: half-width a, half-height above `top` and below `bottom` (both x a). */
function ring(cx, cy, z, a, top = 1, bottom = 1, n = 24) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n; // 0 at the top, a quarter turn at +X
    const c = Math.cos(th);
    pts.push([cx + a * Math.sin(th), cy + a * c * (c >= 0 ? top : bottom), z]);
  }
  return pts;
}

// ---------------------------------------------------------------- geometry builder

/** Accumulates closed lofts into one indexed geometry, each loft oriented outward on its own. */
function builder() {
  const pos = [], idx = [], groups = [];
  const api = {
    /**
     * @param {number[][][]} sections rings of equal length
     * @param {{ wrap?: boolean, capStart?: boolean, capEnd?: boolean, startCapGroup?: number }} [o] wrap closes each
     *   ring on itself; caps are fans with their own vertices (a crisp edge); startCapGroup gives the start cap
     *   another material index
     */
    loft(sections, { wrap = false, capStart = true, capEnd = true, startCapGroup = 0 } = {}) {
      const base = pos.length / 3, n = sections[0].length;
      const tris = [];
      for (const s of sections) for (const p of s) pos.push(p[0], p[1], p[2]);
      const segs = wrap ? n : n - 1;
      for (let k = 0; k < sections.length - 1; k++) {
        for (let i = 0; i < segs; i++) {
          const a = base + k * n + i, b = base + k * n + ((i + 1) % n), c = a + n, d = b + n;
          tris.push([a, b, d], [a, d, c]);
        }
      }
      const caps = { start: [], end: [] };
      const cap = (s, flip, list) => {
        const start = pos.length / 3;
        const c = s.reduce((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n, m[2] + p[2] / n], [0, 0, 0]);
        for (const p of s) pos.push(p[0], p[1], p[2]);
        pos.push(c[0], c[1], c[2]);
        for (let i = 0; i < n; i++) {
          const a = start + i, b = start + ((i + 1) % n), m = start + n;
          list.push(flip ? [m, b, a] : [m, a, b]);
        }
      };
      if (capStart) cap(sections[0], true, caps.start);
      if (capEnd) cap(sections[sections.length - 1], false, caps.end);
      // outward: the signed volume about the loft's centre is positive
      let cx = 0, cy = 0, cz = 0;
      for (let i = base; i < pos.length / 3; i++) { cx += pos[3 * i]; cy += pos[3 * i + 1]; cz += pos[3 * i + 2]; }
      const m = pos.length / 3 - base;
      cx /= m; cy /= m; cz /= m;
      let vol = 0;
      for (const [a, b, c] of [...tris, ...caps.start, ...caps.end]) {
        const ax = pos[3 * a] - cx, ay = pos[3 * a + 1] - cy, az = pos[3 * a + 2] - cz;
        const bx = pos[3 * b] - cx, by = pos[3 * b + 1] - cy, bz = pos[3 * b + 2] - cz;
        const qx = pos[3 * c] - cx, qy = pos[3 * c + 1] - cy, qz = pos[3 * c + 2] - cz;
        vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
      }
      const emit = (list, group) => {
        for (const [a, b, c] of list) if (vol < 0) idx.push(a, c, b); else idx.push(a, b, c);
        if (list.length) groups.push({ count: list.length * 3, group });
      };
      if (startCapGroup === 0) emit([...tris, ...caps.start, ...caps.end], 0);
      else { emit([...tris, ...caps.end], 0); emit(caps.start, startCapGroup); }
      return api;
    },
    geometry() {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      // material groups only where a loft asked for a second material (a single material ignores them anyway)
      if (groups.some((x) => x.group !== 0)) {
        let start = 0;
        for (const { count, group } of groups) { g.addGroup(start, count, group); start += count; }
      }
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      return g;
    },
  };
  return api;
}

// ---------------------------------------------------------------- parts

function fuselageGeometry() {
  const R = FUSELAGE.width / 2, below = (FUSELAGE.height - R) / R; // lower half ellipse, in half-widths
  const stations = [0, 0.25, 0.7, 1.4, 2.3, 3.4, 4.8, FUSELAGE.noseEnd, 12, 17, 22, FUSELAGE.tailStart, 30, 32.5, 35, 37, FUSELAGE.length];
  const rings = stations.map((s) => {
    let f = 1, cy = FUSELAGE.axisY;
    if (s < FUSELAGE.noseEnd) { const u = 1 - s / FUSELAGE.noseEnd; f = Math.max(0.03, Math.sqrt(1 - u * u)); cy = lerp(FUSELAGE.axisY, FUSELAGE.noseTipY, u * u); }
    if (s > FUSELAGE.tailStart) { const u = (s - FUSELAGE.tailStart) / (FUSELAGE.length - FUSELAGE.tailStart); f = lerp(1, 0.07, smooth(u) * 0.6 + u * 0.4); cy = lerp(FUSELAGE.axisY, FUSELAGE.tailTipY, smooth(u)); }
    // the tail cone's belly sweeps up as its centre rises and it narrows
    return ring(0, cy, bodyZ(s), R * f, 1, below, 24);
  });
  return builder().loft(rings, { wrap: true }).geometry();
}

function wingGeometry(sign) {
  return builder().loft(wingSections(sign)).geometry();
}

/** Nacelle with its fan face (material 1, dark) and the pylon. */
function engineGeometry(sign) {
  const a = ENGINE.width / 2, cx = sign * ENGINE.out, cy = ENGINE.axisY, z0 = ENGINE.inlet;
  // [station, half-width]: fan face behind the lip, the lip, the cowl, the fan nozzle, the core cowl and plug
  const profile = [[z0 + 0.34, 0.76], [z0 + 0.05, 0.8], [z0, 0.88], [z0 + 0.12, 0.97], [z0 + 0.7, a], [z0 + 2.3, a * 0.99],
    [z0 + 3.3, 0.9], [z0 + ENGINE.length, 0.66], [z0 + ENGINE.length + 0.05, 0.5], [z0 + 4.9, 0.42], [z0 + 5.35, 0.18], [z0 + 5.55, 0.02]];
  const rings = profile.map(([s, r]) => ring(cx, cy, bodyZ(s), r, 1, ENGINE.flatten, 24));
  const b = builder().loft(rings, { wrap: true, startCapGroup: 1 });
  // the pylon: symmetric sections stacked from inside the cowl up into the wing
  const wingY = wingPlanform(ENGINE.out).y;
  const pylon = [[cy + 0.75, z0 + 0.9, 4.4], [cy + 1.1, z0 + 1.1, 4.5], [wingY + 0.1, z0 + 1.6, 4.4]].map(([y, le, c]) =>
    aerofoil(0.07, 0).map(([u, h]) => [cx + h * c, y, bodyZ(le) + u * c]));
  b.loft(pylon);
  return b.geometry();
}

/** Flap-track fairings: slender canoes under the wing, their tails behind the trailing edge (positions ESTIMATED). */
function fairingGeometry(sign) {
  const b = builder();
  for (const o of [3.3, 6.4, 9.3, 12.1]) {
    const p = wingPlanform(o);
    const top = p.y - 0.05; // tucked just under the lower surface
    const z0 = p.le + 0.45 * p.chord, z1 = p.te + 0.35 + 0.12 * p.chord;
    const n = 8;
    const rings = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const f = Math.sin(Math.PI * Math.pow(u, 0.8)) ** 0.7 + 0.02;
      const depth = (0.18 + 0.06 * p.chord) * f;
      rings.push(ring(sign * o, top, bodyZ(lerp(z0, z1, u)), 0.17 * f + 0.01, 0.2, depth / (0.17 * f + 0.01), 12));
    }
    b.loft(rings, { wrap: true });
  }
  return b.geometry();
}

function stabGeometry(sign) {
  const half = TAIL.stabSpan / 2;
  const sections = [0.3, 1.5, 4, half].map((o) => {
    const t = o / half;
    const c = lerp(TAIL.stabRootChord, TAIL.stabTipChord, t);
    const le = TAIL.stabRootLE + o * Math.tan(TAIL.stabSweepLE * RAD);
    const d = TAIL.stabDihedral * RAD;
    return place(aerofoil(0.1, 0), [sign * o, TAIL.stabY + o * Math.tan(d), bodyZ(le)], c, [-sign * Math.sin(d), Math.cos(d), 0]);
  });
  return builder().loft(sections).geometry();
}

function finGeometry() {
  const sections = [4.5, TAIL.finRootY, 8, TAIL.height].map((y) => {
    const t = (y - TAIL.finRootY) / (TAIL.height - TAIL.finRootY);
    const c = lerp(TAIL.finRootChord, TAIL.finTipChord, Math.max(t, 0)) + Math.max(0, -t) * 2;
    const le = TAIL.finRootLE + (y - TAIL.finRootY) * Math.tan(TAIL.finSweepLE * RAD);
    // a vertical section: the chord along +Z, its normal along +X, sections rising
    return aerofoil(0.1, 0).map(([u, h]) => [h * c, y, bodyZ(le) + u * c]);
  });
  return builder().loft(sections).geometry();
}

// ---------------------------------------------------------------- the group

/** Plain materials (node materials for WebGPURenderer, both backends): grey-white paint, a grey cowl, a dark fan. */
export function airframeMaterials() {
  return {
    paint: new MeshStandardNodeMaterial({ color: 0xdfe2e5, roughness: 0.45, metalness: 0 }),
    cowl: new MeshStandardNodeMaterial({ color: 0xc4c8cc, roughness: 0.4, metalness: 0.1 }),
    dark: new MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0 }),
    fairing: new MeshStandardNodeMaterial({ color: 0xd2d5d8, roughness: 0.5, metalness: 0 }),
  };
}

/**
 * The airframe v0: { group, parts, materials, triangles, dispose() }. `parts` names each mesh or group: fuselage,
 * wingLeft, wingRight (with their winglets), engineLeft, engineRight (nacelle, fan and pylon), fairingsLeft,
 * fairingsRight, stabLeft, stabRight, fin.
 * @param {{ materials?: ReturnType<typeof airframeMaterials> }} [opts]
 */
export function createAirframe({ materials = airframeMaterials() } = {}) {
  const group = new Group();
  group.name = 'airframe';
  const parts = {};
  const add = (name, geometry, material) => {
    const m = new Mesh(geometry, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    parts[name] = m;
  };
  add('fuselage', fuselageGeometry(), materials.paint);
  for (const [side, sign] of [['Left', -1], ['Right', 1]]) {
    add(`wing${side}`, wingGeometry(sign), materials.paint);
    add(`engine${side}`, engineGeometry(sign), [materials.cowl, materials.dark]);
    add(`fairings${side}`, fairingGeometry(sign), materials.fairing);
    add(`stab${side}`, stabGeometry(sign), materials.paint);
  }
  add('fin', finGeometry(), materials.paint);
  let triangles = 0;
  for (const m of Object.values(parts)) triangles += m.geometry.index.count / 3;
  return {
    group, parts, materials, triangles,
    dispose() {
      for (const m of Object.values(parts)) m.geometry.dispose();
      for (const mat of Object.values(materials)) mat.dispose();
    },
  };
}

/**
 * Place the airframe's group for an AircraftState: its position is the main gear contact point and its quaternion
 * takes body axes to scene axes, which is exactly the group's frame.
 * @param {import('three').Object3D} group  @param {{ position: import('three').Vector3, quaternion: import('three').Quaternion }} state
 */
export function placeAirframe(group, state) {
  group.position.copy(state.position);
  group.quaternion.copy(state.quaternion);
  group.updateMatrixWorld(true);
  return group;
}
