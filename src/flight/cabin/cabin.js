// The cabin v0 (plan 03, sections 7.4 and 7.6; F1.5): a length of cabin around the chosen seat, generated in code, so
// the view is framed as in a photograph from a window seat. The modelled cabin (F3.5, cabin.glb with panes and a
// shade) replaces it; this stays as the fallback while that loads.
//
// What is drawn, in body axes (dimensions.js): the sidewall on the seat's side as a cylinder at the trim radius with a
// rounded opening at every window station (a plain panel at the blanks) and the reveal from the trim out to the skin,
// where the opening is the real one, 10.5 x 14.4 in; the rest of the cabin shell, the floor and two end walls, so no
// look direction sees out through a gap; and the seats of the rows around, so the seat back ahead frames the view.
// Dark and matte: the outside is what the picture is exposed for. No panes in v0 (Phase 5 adds them).
//
// Everything is on its own layer (CABIN_LAYER): rendered because the flight's camera enables that layer, ignored by
// picking rays (layer 0), and ready for F3.9 to move the cabin into a pass of its own.

import { BufferGeometry, Float32BufferAttribute, FrontSide, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, clamp, materialColor, mix, uniform, vec3 } from 'three/tsl';
import { FUSELAGE, WINDOW, CABIN, bodyZ } from '../aircraft/dimensions.js';
import { windowStations, rowFront, seatCentreX, ROWS } from './lopa.js';

/** The cabin's layer (plan 7.6's table: CABIN 11). */
export const CABIN_LAYER = 11;

/** How far the cabin runs fore and aft of the eye, metres. */
const HALF_LENGTH = 5;
/** The trim's opening is larger than the window by this much on every side: a bevelled reveal (ESTIMATED). */
export const REVEAL_FLARE = CABIN.revealFlare;
/** Half the height of the band of window cells along the wall (developed), metres. */
const BAND = 0.3;
/** Subdivision of curved runs, radians: the wall's chords stay within 2.5 mm of the cylinder. */
const STEP = (6 * Math.PI) / 180;

const R = FUSELAGE.trimRadius, ROUT = FUSELAGE.width / 2, AXIS = FUSELAGE.axisY;
const FLOOR = FUSELAGE.floorAtWing;
const THETA_FLOOR = Math.asin((FLOOR - AXIS) / R);
const THETA_TOP = (55 * Math.PI) / 180; // where the window-side panel ends (the bins in a real cabin)
const THETA_WINDOW = Math.asin((FLOOR + WINDOW.centreAboveFloor - AXIS) / R);

/**
 * Collects triangles, each turned to face toward (or away from) a reference point. A normal function gives smooth
 * per-vertex normals (the curved wall, the reveal); without one a triangle is flat.
 */
function mesher() {
  const pos = [], nor = [], ab = new Vector3(), ac = new Vector3(), n = new Vector3();
  return {
    /**
     * @param {number[]} a @param {number[]} b @param {number[]} c @param {number[]} ref @param {boolean} [away]
     * @param {(p: number[]) => number[]} [normal]
     */
    tri(a, b, c, ref, away = false, normal) {
      ab.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      ac.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      n.crossVectors(ab, ac);
      const toRef = (ref[0] - (a[0] + b[0] + c[0]) / 3) * n.x + (ref[1] - (a[1] + b[1] + c[1]) / 3) * n.y + (ref[2] - (a[2] + b[2] + c[2]) / 3) * n.z;
      const flip = away ? toRef > 0 : toRef < 0;
      const tri = flip ? [a, c, b] : [a, b, c];
      if (flip) n.negate();
      n.normalize();
      for (const p of tri) { pos.push(p[0], p[1], p[2]); nor.push(...(normal ? normal(p) : [n.x, n.y, n.z])); }
    },
    quad(a, b, c, d, ref, away, normal) { this.tri(a, b, c, ref, away, normal); this.tri(a, c, d, ref, away, normal); },
    geometry() {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
      g.computeBoundingSphere();
      return g;
    },
  };
}

/** Unit vector toward the fuselage axis: the trim's smooth normal. */
const towardAxis = (p) => { const x = -p[0], y = AXIS - p[1], l = Math.hypot(x, y); return [x / l, y / l, 0]; };
const UP = () => [0, 1, 0];

/** Distance from (x, y) to a rounded rectangle of half sizes a, b and corner radius r, centred at the origin. */
function sdRoundRect(x, y, a, b, r) {
  const qx = Math.abs(x) - (a - r), qy = Math.abs(y) - (b - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Where the ray from the centre in direction (dx, dy) leaves a rounded rectangle. */
function onRoundRect(dx, dy, a, b, r) {
  let lo = 0, hi = Math.hypot(a, b);
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (sdRoundRect(dx * m, dy * m, a, b, r) > 0) hi = m; else lo = m; }
  return [dx * lo, dy * lo];
}

/**
 * The cabin around one seat: { group, parts: { wall, reveals, seats, ends }, windows, triangles, dispose() }.
 * `windows` lists the window positions along the drawn wall, each { station, open }.
 * @param {{ seat: ReturnType<import('./lopa.js').seat>, materials?: object }} opts
 */
export function createCabin({ seat, materials = cabinMaterials() }) {
  const s = seat.sign;
  const z0 = bodyZ(seat.eyeStation - HALF_LENGTH), z1 = bodyZ(seat.eyeStation + HALF_LENGTH);
  const zEye = bodyZ(seat.eyeStation);
  /** A point on a cylinder about the axis: angle from horizontal on the seat's side, radius, body z. */
  const P = (theta, r, z) => [s * r * Math.cos(theta), AXIS + r * Math.sin(theta), z];
  const axisAt = (z) => [0, AXIS, z];

  const wall = mesher(), reveals = mesher(), seats = mesher(), ends = mesher();

  // --- the window band: one cell per window position, from midpoint to midpoint
  const vC = R * THETA_WINDOW; // developed height of the window centre along the trim
  const positions = windowStations(seat.side).filter((w) => bodyZ(w.station) - 0.3 > z0 && bodyZ(w.station) + 0.3 < z1);
  const cells = positions.map((w, i) => {
    const z = bodyZ(w.station);
    const prev = i > 0 ? bodyZ(positions[i - 1].station) : z - 0.6, next = i < positions.length - 1 ? bodyZ(positions[i + 1].station) : z + 0.6;
    return { z, open: !w.blank, station: w.station, za: Math.max(z0, (prev + z) / 2), zb: Math.min(z1, (z + next) / 2) };
  });
  const bandLo = vC - BAND, bandHi = vC + BAND;
  const sideV = Array.from({ length: 11 }, (_, j) => bandLo + (2 * BAND * j) / 10); // shared by neighbouring cells

  // Every vertex of the wall lies on one of these angles and one of these stations, and the end walls use the same
  // angles: no T-junctions and no slivers where the sky (the fuselage skin is culled from inside) could show through.
  const run = (tA, tB) => { const n = Math.max(1, Math.ceil((tB - tA) / STEP)); return Array.from({ length: n }, (_, j) => tA + ((tB - tA) * j) / n); };
  const thetas = [...run(THETA_FLOOR, bandLo / R), ...sideV.map((v) => v / R), ...run(bandHi / R, THETA_TOP).slice(1), ...run(THETA_TOP, Math.PI - THETA_FLOOR), Math.PI - THETA_FLOOR];
  const bandFrom = thetas.indexOf(sideV[0] / R), bandTo = thetas.indexOf(sideV[sideV.length - 1] / R);
  const columns = [z0, ...cells.map((c) => c.za), ...(cells.length ? [cells[cells.length - 1].zb] : []), z1].filter((z, i, l) => i === 0 || z > l[i - 1] + 1e-9);

  const inner = { a: WINDOW.width / 2 + REVEAL_FLARE, b: WINDOW.height / 2 + REVEAL_FLARE, r: WINDOW.cornerRadius + REVEAL_FLARE };
  const outer = { a: WINDOW.width / 2, b: WINDOW.height / 2, r: WINDOW.cornerRadius };
  const ANG = Array.from({ length: 72 }, (_, k) => (2 * Math.PI * k) / 72 - Math.PI); // ray angles round the opening
  const TAU = 2 * Math.PI;
  for (const c of cells) {
    const ref = axisAt(c.z);
    if (!c.open) continue; // a blank is plain band, drawn with the rest below
    // the cell's border: its corners and the shared side heights, by angle about the window centre
    const border = [...sideV.map((v) => [c.zb, v]), ...sideV.map((v) => [c.za, v])]
      .map(([z, v]) => ({ p: P(v / R, R, z), a: Math.atan2(v - vC, z - c.z) })).sort((m, k) => m.a - k.a);
    // the opening on the trim (flared) and at the skin (the real window), on the same rays
    const open = ANG.map((a) => {
      const i = onRoundRect(Math.cos(a), Math.sin(a), inner.a, inner.b, inner.r), o = onRoundRect(Math.cos(a), Math.sin(a), outer.a, outer.b, outer.r);
      return { a, p: P((vC + i[1]) / R, R, c.z + i[0]), q: P(THETA_WINDOW + o[1] / ROUT, ROUT, c.z + o[0]) };
    });
    // zip the border to the opening by angle
    const nb = border.length, no = open.length;
    const ang = (list, k) => list[k % list.length].a + Math.floor(k / list.length) * TAU;
    let i = 0, j = 0;
    while (i < nb || j < no) {
      const takeBorder = j >= no || (i < nb && ang(border, i + 1) < ang(open, j + 1));
      if (takeBorder) { wall.tri(border[i % nb].p, border[(i + 1) % nb].p, open[j % no].p, ref, false, towardAxis); i++; }
      else { wall.tri(border[i % nb].p, open[(j + 1) % no].p, open[j % no].p, ref, false, towardAxis); j++; }
    }
    // the reveal: radially from the trim's opening out to the real opening at the skin; normals toward its centre line
    const u = [s * Math.cos(THETA_WINDOW), Math.sin(THETA_WINDOW), 0];
    const toCentre = (p) => {
      const d = [-p[0], AXIS - p[1], c.z - p[2]], k = d[0] * u[0] + d[1] * u[1];
      const w = [d[0] - k * u[0], d[1] - k * u[1], d[2]], l = Math.hypot(...w);
      return [w[0] / l, w[1] / l, w[2] / l];
    };
    const revealRef = P(THETA_WINDOW, (R + ROUT) / 2, c.z);
    for (let k = 0; k < no; k++) reveals.quad(open[k].p, open[(k + 1) % no].p, open[(k + 1) % no].q, open[k].q, revealRef, false, toCentre);
  }

  // --- the rest of the wall on the shared grid: everything but the open cells, then over the top and down the far side
  const openAt = (za) => cells.find((c) => c.open && Math.abs(c.za - za) < 1e-9);
  for (let ci = 0; ci < columns.length - 1; ci++) {
    const za = columns[ci], zb = columns[ci + 1], ref = axisAt((za + zb) / 2);
    const skipBand = !!openAt(za);
    for (let k = 0; k < thetas.length - 1; k++) {
      if (skipBand && k >= bandFrom && k < bandTo) continue;
      const a = thetas[k], b = thetas[k + 1];
      wall.quad(P(a, R, za), P(a, R, zb), P(b, R, zb), P(b, R, za), ref, false, towardAxis);
    }
  }
  for (let ci = 0; ci < columns.length - 1; ci++) {
    const za = columns[ci], zb = columns[ci + 1];
    wall.quad(P(Math.PI - THETA_FLOOR, R, za), P(THETA_FLOOR, R, za), P(THETA_FLOOR, R, zb), P(Math.PI - THETA_FLOOR, R, zb), axisAt(zEye), false, UP);
  }

  // --- end walls: the cabin's section on the same angles, closed by the floor
  for (const z of [z0, z1]) {
    const c = [0, AXIS, z], ref = axisAt(zEye);
    for (let k = 0; k < thetas.length - 1; k++) ends.tri(c, P(thetas[k], R, z), P(thetas[k + 1], R, z), ref);
    ends.tri(c, P(thetas[thetas.length - 1], R, z), P(thetas[0], R, z), ref);
  }

  // --- seats: the three on the seat's side of each nearby row, a back and a cushion each
  const box = (x0, x1, y0, y1, za, zb) => {
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (za + zb) / 2];
    const v = (i, j, k) => [i ? x1 : x0, j ? y1 : y0, k ? zb : za];
    for (const [a, b, d, e] of [[v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)], [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
      [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)], [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
      [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)]]) seats.quad(a, b, d, e, c, true);
  };
  const letters = seat.side === 'right' ? ['D', 'E', 'F'] : ['A', 'B', 'C'];
  for (let r = Math.max(1, seat.row - 5); r <= Math.min(ROWS, seat.row + 3); r++) {
    const front = rowFront(r);
    if (front + 1 < seat.eyeStation - HALF_LENGTH || front > seat.eyeStation + HALF_LENGTH - 1) continue;
    for (const l of letters) {
      const cx = seatCentreX(l);
      const hw = CABIN.seatWidth / 2 - 0.01;
      box(cx - hw, cx + hw, FLOOR + CABIN.seatHeight, FLOOR + CABIN.backTop, bodyZ(front + CABIN.backFace), bodyZ(front + CABIN.backFace + CABIN.backThickness));
      box(cx - hw, cx + hw, FLOOR + CABIN.seatHeight - 0.13, FLOOR + CABIN.seatHeight, bodyZ(front), bodyZ(front + CABIN.cushionDepth));
    }
  }

  const group = new Group();
  group.name = 'cabin';
  const parts = {};
  for (const [name, m, mat] of [['wall', wall, materials.wall], ['reveals', reveals, materials.reveal], ['seats', seats, materials.seat], ['ends', ends, materials.wall]]) {
    const mesh = new Mesh(m.geometry(), mat);
    mesh.name = `cabin-${name}`;
    mesh.layers.set(CABIN_LAYER);
    mesh.frustumCulled = false; // the camera is inside it
    mesh.receiveShadow = true; // in the app's shadow cascades the fuselage then keeps the sun off the inside
    group.add(mesh);
    parts[name] = mesh;
  }
  let triangles = 0;
  for (const m of Object.values(parts)) triangles += m.geometry.attributes.position.count / 3;
  return {
    group, parts, triangles, seat,
    windows: cells.map((c) => ({ station: c.station, open: c.open })),
    dispose() { for (const m of Object.values(parts)) m.geometry.dispose(); },
  };
}

/**
 * Dark, matte node materials for the cabin (both backends), shared by every cabin built with them. Dark, but not so
 * dark that a wall facing away from the sun, lit by sky light alone, falls into the tone curve's toe and goes black.
 */
export function cabinMaterials() {
  return {
    wall: new MeshStandardNodeMaterial({ color: 0x4a4d52, roughness: 0.95, metalness: 0 }),
    reveal: new MeshStandardNodeMaterial({ color: 0x5d6065, roughness: 0.9, metalness: 0 }),
    seat: new MeshStandardNodeMaterial({ color: 0x3a3e44, roughness: 1, metalness: 0 }),
  };
}

// ================================================================================================ the modelled cabin
//
// F3.5: public/models/aircraft/cabin.glb (models/aircraft/build_cabin.py) holds ONE window bay, a plain strip of
// sidewall, the shade, the three panes, one seat, an armrest and a metre of the bins' lower edge, all built for the
// right side with per-corner baked light (`_cabin`: occlusion, the window-wash strip, the window's form factor).
// cabinLayout() says where each goes for a seat; buildModelledCabin() instances them (mirrored for the left side) and
// closes the cabin with a code-built shell (floor, the far side and the ceiling, two end walls); createModelledCabin()
// shows the v0 cabin above at once and swaps the model in when it has loaded, keeping the v0 cabin if it fails.

/** Where the app serves the cabin model and how to place it (public/ at the site's root). */
export const CABIN_URL = '/models/aircraft/cabin.glb';
export const CABIN_INFO_URL = '/models/aircraft/cabin.json';

/** How far the modelled cabin runs fore and aft of the eye, metres. */
export const MODEL_HALF_LENGTH = 5;

/**
 * Where every part of the modelled cabin goes for a seat: pure, stations in metres aft of the nose.
 * Bays sit on the open windows that fit wholly inside the run; filler strips cover everything else (the blanks
 * included) so the sidewall is closed from end to end; seats and armrests fill the rows on the seat's side.
 * @param {ReturnType<import('./lopa.js').seat>} seat
 * @param {{ halfLength?: number }} [o]
 */
export function cabinLayout(seat, { halfLength = MODEL_HALF_LENGTH } = {}) {
  const half = CABIN.panelHalfLength;
  const from = seat.eyeStation - halfLength, to = seat.eyeStation + halfLength;
  const bays = windowStations(seat.side)
    .filter((w) => !w.blank && w.station - half >= from && w.station + half <= to)
    .map((w) => ({ station: w.station }));
  const fillers = [];
  let at = from;
  for (const b of bays) {
    if (b.station - half > at + 1e-6) fillers.push({ from: at, to: b.station - half });
    at = b.station + half;
  }
  if (to > at + 1e-6) fillers.push({ from: at, to });
  const own = seat.nearest.find((w) => !w.blank && bays.some((b) => b.station === w.station));
  const letters = seat.side === 'right' ? ['D', 'E', 'F'] : ['A', 'B', 'C'];
  const seats = [], armrests = [];
  const arm = (CABIN.tripleWidth - 3 * CABIN.seatWidth) / 4;
  const inner = CABIN.aisle / 2;
  for (let r = 1; r <= ROWS; r++) {
    const front = rowFront(r);
    if (front < from || front + 0.85 > to) continue;
    // not the passenger's own seat: the camera has no head in front of it, and its back 10 to 17 cm behind the eye
    // would fill the view aft
    for (const l of letters) if (!(r === seat.row && l === seat.letter)) seats.push({ row: r, letter: l, front, x: seatCentreX(l) });
    for (let k = 0; k < 4; k++) armrests.push({ row: r, front, x: seat.sign * (inner + arm / 2 + k * (CABIN.seatWidth + arm)) });
  }
  return { side: seat.side, sign: seat.sign, from, to, bays, fillers, seats, armrests, own: own ? own.station : null };
}

/** A geometry mirrored across x = 0 (the left side's parts from the right side's), its winding kept outward. */
export function mirrorGeometryX(g) {
  const m = g.clone();
  const p = m.getAttribute('position'), n = m.getAttribute('normal');
  for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i));
  if (n) for (let i = 0; i < n.count; i++) n.setX(i, -n.getX(i));
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  if (m.index) {
    const idx = m.index;
    for (let i = 0; i < idx.count; i += 3) { const b = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, b); }
    idx.needsUpdate = true;
  } else {
    for (const name of Object.keys(m.attributes)) {
      const a = m.getAttribute(name), k = a.itemSize, arr = a.array;
      for (let i = 0; i < a.count; i += 3) for (let c = 0; c < k; c++) { const t = arr[(i + 1) * k + c]; arr[(i + 1) * k + c] = arr[(i + 2) * k + c]; arr[(i + 2) * k + c] = t; }
      a.needsUpdate = true;
    }
  }
  m.computeBoundingBox(); // a clone carries the original's bounds
  m.computeBoundingSphere();
  return m;
}

/** Light the materials stand for (lux at a baked 1.0, cd/m^2 for the strip), and the share of the outdoor ambient that
 * reaches a corner by bouncing round the cabin: `bounce` times its local occlusion plus a `floor` (ESTIMATED: a
 * typical cabin's 100 to 300 lux of its own light; for daylight, the light-coloured trim, the ceiling and the sunlit
 * floor and seats near some forty windows, judged against photographs rather than computed). */
export const CABIN_LIGHT = Object.freeze({ washLux: 160, ambientLux: 70, stripCdM2: 450, bounce: 0.45, floor: 0.05 });
const DAY_TINT = [1.0, 0.97, 0.92], NIGHT_TINT = [1.0, 0.84, 0.66];

/**
 * Node materials for the model, one per source material, relit through uniforms: the window's form factor and the
 * occlusion gate the scene's ambient (sky light only enters through the windows); the cabin's own light (the
 * window-wash strip and the ceiling wash) is emitted in cd/m^2 through the environment's emissive().
 * @param {{ emissive: (cdM2: any) => any }} nodes  @param {Iterable<import('three').Material>} sources
 */
export function modelledMaterials(nodes, sources) {
  const uCabinLight = uniform(1), uNight = uniform(0);
  const tint = mix(vec3(...DAY_TINT), vec3(...NIGHT_TINT), uNight);
  const baked = attribute('_cabin', 'vec4');
  const made = new Map();
  for (const src of sources) {
    if (made.has(src.name)) continue;
    const glass = src.name === 'Glass';
    const m = new MeshStandardNodeMaterial({
      name: `cabin-${src.name}`, color: src.color, roughness: src.roughness ?? 0.8, metalness: 0,
      transparent: glass, opacity: glass ? 0.06 : 1, depthWrite: !glass, side: FrontSide,
    });
    if (src.name === 'Wash') {
      m.emissiveNode = nodes.emissive(tint.mul(uCabinLight.mul(CABIN_LIGHT.stripCdM2)));
    } else if (!glass) {
      m.aoNode = clamp(baked.z.add(baked.x.mul(CABIN_LIGHT.bounce)).add(CABIN_LIGHT.floor), 0, 1);
      const lux = baked.y.mul(CABIN_LIGHT.washLux).add(baked.x.mul(CABIN_LIGHT.ambientLux)).mul(uCabinLight);
      m.emissiveNode = nodes.emissive(tint.mul(materialColor).mul(lux).div(Math.PI));
    }
    made.set(src.name, m);
  }
  return {
    byName: made,
    set({ cabinLight = 1, night = false } = {}) {
      uCabinLight.value = Number.isFinite(cabinLight) ? Math.min(1, Math.max(0, cabinLight)) : 1;
      uNight.value = night ? 1 : 0;
    },
    get cabinLight() { return uCabinLight.value; },
    dispose() { for (const m of made.values()) m.dispose(); },
  };
}

/** The node's meshes of a loaded cabin.glb: name -> [{ geometry, material }] (a node of several primitives has several). */
function partsOf(scene) {
  const parts = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let node = o;
    while (node.parent && node.parent !== scene && !(node.parent.name === 'Cabin')) node = node.parent;
    const name = node.name || o.name;
    if (!parts.has(name)) parts.set(name, []);
    parts.get(name).push({ geometry: o.geometry, material: o.material });
  });
  return parts;
}

const RIGHT_SHADE_AXIS = (() => {
  const t = Math.asin((FUSELAGE.floorAtWing + WINDOW.centreAboveFloor - AXIS) / R) + Math.PI / 2;
  return [Math.cos(t), Math.sin(t), 0];
})();

/**
 * The cabin's shell around the run, in code: the floor, the cylinder of the trim from the top of the bins over the
 * ceiling and down the far side, and two end walls. The window side below the bins is the model's.
 */
function shellGeometries(seat, from, to, binTopY) {
  const s = seat.sign, z0 = bodyZ(from), z1 = bodyZ(to), zEye = bodyZ(seat.eyeStation);
  const P = (theta, z) => [s * R * Math.cos(theta), AXIS + R * Math.sin(theta), z];
  const tTop = Math.asin((binTopY - AXIS) / R), tFar = Math.PI - THETA_FLOOR;
  const n = Math.ceil((tFar - tTop) / STEP);
  const thetas = Array.from({ length: n + 1 }, (_, i) => tTop + ((tFar - tTop) * i) / n);
  const wall = mesher(), floor = mesher(), ends = mesher();
  const ref = (z) => [0, AXIS, z];
  for (let k = 0; k < n; k++) wall.quad(P(thetas[k], z0), P(thetas[k], z1), P(thetas[k + 1], z1), P(thetas[k + 1], z0), ref((z0 + z1) / 2), false, towardAxis);
  // the floor from the dado's foot on the window side to the far wall
  const near = s * (Math.sqrt(R * R - (FLOOR - AXIS) ** 2) - 0.03), far = -s * Math.sqrt(R * R - (FLOOR - AXIS) ** 2);
  floor.quad([near, FLOOR, z0], [near, FLOOR, z1], [far, FLOOR, z1], [far, FLOOR, z0], [0, FLOOR + 1, zEye], false, UP);
  // the end walls: the whole section, so nothing looks out of the run's ends
  const section = [];
  const all = Math.ceil((2 * Math.PI - 2 * (THETA_FLOOR + Math.PI / 2)) / STEP);
  for (let i = 0; i <= all; i++) { const t = THETA_FLOOR + ((Math.PI - 2 * THETA_FLOOR) * i) / all; section.push(t); }
  for (const z of [z0, z1]) {
    const c = [0, AXIS, z];
    for (let k = 0; k < section.length - 1; k++) ends.tri(c, P(section[k], z), P(section[k + 1], z), [0, AXIS, zEye]);
    ends.tri(c, P(section[section.length - 1], z), P(section[0], z), [0, AXIS, zEye]);
  }
  return { wall: wall.geometry(), floor: floor.geometry(), ends: ends.geometry() };
}

/**
 * The modelled cabin around one seat, from a loaded cabin.glb (its glTF scene) and cabin.json.
 * @param {{ scene: import('three').Object3D, info?: object }} model
 * @param {ReturnType<import('./lopa.js').seat>} seat
 * @param {{ nodes: object, materials?: ReturnType<typeof modelledMaterials>, shell?: object, panes?: boolean,
 *   halfLength?: number }} o
 */
export function buildModelledCabin(model, seat, { nodes, materials, shellMaterials = cabinShellMaterials(), panes = false, halfLength = MODEL_HALF_LENGTH } = {}) {
  const parts = partsOf(model.scene);
  const info = model.info || {};
  for (const need of ['Bay', 'Filler', 'Shade', 'Seat', 'Armrest', 'Bin']) if (!parts.has(need)) throw new Error(`cabin: node ${need} is missing from the model`);
  const sources = new Set();
  for (const list of parts.values()) for (const p of list) sources.add(p.material);
  const mats = materials ?? modelledMaterials(nodes, sources);
  const ownMats = !materials;
  const group = new Group();
  group.name = 'cabin-model';
  const travel = info.shade?.travel ?? CABIN.shadeTravel;
  const axisR = info.shade?.axis ?? RIGHT_SHADE_AXIS;
  const meshes = new Map(); // part name -> InstancedMesh[]
  const made = []; // geometries this cabin owns (mirrors)
  let layout = null, shells = null;
  /** The left side's mirror of a part's geometry, made once. */
  const mirrored = new Map();
  const geometryFor = (part, g) => {
    if (layout.sign > 0) return g;
    if (!mirrored.has(g)) { const m = mirrorGeometryX(g); mirrored.set(g, m); made.push(m); }
    return mirrored.get(g);
  };
  const shades = { closed: [], own: -1 };
  const _m = new Matrix4(), _p = new Vector3(), _q = new Quaternion(), _s = new Vector3();

  function instance(name, count, place, { mirror = true, visible = true } = {}) {
    for (const old of meshes.get(name) || []) { group.remove(old); old.dispose(); }
    const list = [];
    for (const p of parts.get(name) || []) {
      if (!count) continue;
      const g = mirror ? geometryFor(name, p.geometry) : p.geometry;
      const mesh = new InstancedMesh(g, mats.byName.get(p.material.name), count);
      mesh.name = `cabin-${name}`;
      mesh.layers.set(CABIN_LAYER);
      mesh.frustumCulled = false; // the camera is inside it
      mesh.receiveShadow = true;
      mesh.visible = visible;
      for (let i = 0; i < count; i++) { place(i, _m); mesh.setMatrixAt(i, _m); }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere?.();
      group.add(mesh);
      list.push(mesh);
    }
    meshes.set(name, list);
  }

  const at = (x, y, z, sz = 1) => _m.compose(_p.set(x, y, z), _q.identity(), _s.set(1, 1, sz));

  function placeShades() {
    const list = meshes.get('Shade') || [];
    const axis = [layout.sign * axisR[0], axisR[1], axisR[2]];
    for (const mesh of list) {
      layout.bays.forEach((b, i) => {
        const open = (1 - shades.closed[i]) * travel;
        mesh.setMatrixAt(i, at(axis[0] * open, axis[1] * open, bodyZ(b.station) + axis[2] * open));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function setSeat(s) {
    layout = cabinLayout(s, { halfLength });
    const { bays, fillers, seats, armrests } = layout;
    instance('Bay', bays.length, (i, m) => at(0, 0, bodyZ(bays[i].station)));
    instance('Filler', fillers.length, (i, m) => at(0, 0, bodyZ((fillers[i].from + fillers[i].to) / 2), fillers[i].to - fillers[i].from));
    instance('Bin', 1, (i, m) => at(0, 0, bodyZ((layout.from + layout.to) / 2), layout.to - layout.from));
    instance('Seat', seats.length, (i, m) => at(seats[i].x, 0, bodyZ(seats[i].front)), { mirror: false });
    instance('Armrest', armrests.length, (i, m) => at(armrests[i].x, 0, bodyZ(armrests[i].front)), { mirror: false });
    for (const pane of ['PaneInner', 'PaneMiddle', 'PaneOuter']) if (parts.has(pane)) instance(pane, bays.length, (i, m) => at(0, 0, bodyZ(bays[i].station)), { visible: panes });
    // shades: the passenger's own open; the others as a cabin's are, a few half or wholly closed (a fixed pattern)
    shades.closed = bays.map((b) => { const h = Math.abs(Math.sin(b.station * 12.9898) * 43758.5453) % 1; return h > 0.86 ? 1 : h > 0.74 ? 0.45 : 0; });
    shades.own = bays.findIndex((b) => b.station === layout.own);
    if (shades.own >= 0) shades.closed[shades.own] = 0;
    instance('Shade', bays.length, () => _m.identity());
    placeShades();
    // the shell
    if (shells) { for (const m of Object.values(shells)) { group.remove(m); m.geometry.dispose(); } }
    const binTop = FUSELAGE.floorAtWing + CABIN.binLip + 0.5;
    const g = shellGeometries(s, layout.from, layout.to, binTop);
    shells = {};
    for (const [name, geo] of Object.entries(g)) {
      const mesh = new Mesh(geo, name === 'floor' ? shellMaterials.floor : shellMaterials.wall);
      mesh.name = `cabin-shell-${name}`;
      mesh.layers.set(CABIN_LAYER);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      shells[name] = mesh;
    }
    api.seat = s;
    return api;
  }

  const api = {
    group, seat, info, materials: mats,
    get layout() { return layout; },
    /** Instanced meshes by part name. */
    meshes,
    get triangles() {
      let t = 0;
      for (const list of meshes.values()) for (const m of list) if (m.visible) t += m.count * (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
      for (const m of Object.values(shells || {})) t += m.geometry.getAttribute('position').count / 3;
      return t;
    },
    get drawCalls() {
      let n = Object.keys(shells || {}).length;
      for (const list of meshes.values()) for (const m of list) if (m.visible && m.count) n++;
      return n;
    },
    /** The windows along the drawn wall: { station, open }. */
    get windows() {
      const open = new Set(layout.bays.map((b) => b.station));
      return windowStations(layout.side).filter((w) => w.station >= layout.from && w.station <= layout.to).map((w) => ({ station: w.station, open: open.has(w.station) }));
    },
    /** The own window's shade, 0 open to 1 closed; others keep their own. */
    get shade() { return shades.own >= 0 ? shades.closed[shades.own] : 0; },
    setShade(v) {
      if (shades.own < 0) return api;
      shades.closed[shades.own] = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
      placeShades();
      return api;
    },
    setSeat,
    /** Show or hide the three panes (Phase 5 gives them their material). */
    showPanes(on) { for (const n of ['PaneInner', 'PaneMiddle', 'PaneOuter']) for (const m of meshes.get(n) || []) m.visible = !!on; return api; },
    dispose() {
      for (const list of meshes.values()) for (const m of list) { group.remove(m); m.dispose(); }
      for (const m of Object.values(shells || {})) m.geometry.dispose();
      for (const g of made) g.dispose();
      for (const list of parts.values()) for (const p of list) p.geometry.dispose();
      if (ownMats) mats.dispose();
    },
  };
  for (const s of sources) s.dispose?.(); // the file's own materials are replaced by the node materials above
  setSeat(seat);
  return api;
}

/** The shell's materials: the trim's colour and a dark carpet. */
export function cabinShellMaterials() {
  return {
    wall: new MeshStandardNodeMaterial({ color: 0xd8d5ce, roughness: 0.85, metalness: 0 }),
    floor: new MeshStandardNodeMaterial({ color: 0x2e3238, roughness: 1, metalness: 0 }),
  };
}

/**
 * Load cabin.glb and cabin.json.
 * @param {{ url?: string, infoUrl?: string, loader?: { loadAsync(url: string): Promise<{ scene: import('three').Object3D }> },
 *   fetch?: typeof fetch }} [o]
 */
export async function loadCabinModel({ url = CABIN_URL, infoUrl = CABIN_INFO_URL, loader = null, fetch: get = globalThis.fetch } = {}) {
  const gltfLoader = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
  const [gltf, info] = await Promise.all([
    gltfLoader.loadAsync(url),
    get(infoUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return { scene: gltf.scene, info };
}

/**
 * The cabin for the flight, in the shape the airframe uses: the code-built v0 cabin at once, the modelled one once it
 * has loaded (the v0 cabin stays if loading fails). One group for the session's layers, whatever is in it.
 *   update(state, { cabinLight, night, reducedMotion, dtS })   relight; move the own shade toward its target
 *   setSeat(seat)                                             re-place everything round another seat
 *   setShade(v) / toggleShade()                               the own window's shade, 0 open to 1 closed
 * @param {{ nodes: object, seat: object, load?: () => Promise<{ scene: object, info?: object }>, url?: string,
 *   infoUrl?: string, materials?: object, panes?: boolean }} o  materials: the v0 cabin's (cabinMaterials())
 */
export function createModelledCabin({ nodes, seat, load = null, url, infoUrl, materials, panes = false } = {}) {
  const standInMats = materials ?? cabinMaterials();
  let standIn = createCabin({ seat, materials: standInMats });
  const group = new Group();
  group.name = 'cabin';
  group.add(standIn.group);
  let model = null, error = null, disposed = false, current = seat;
  let shadeTarget = 0, shade = 0, light = { cabinLight: 1, night: false };
  const get = load ?? (() => loadCabinModel({ ...(url ? { url } : {}), ...(infoUrl ? { infoUrl } : {}) }));
  const api = {
    group,
    get seat() { return current; },
    get model() { return model; },
    get error() { return error; },
    get standIn() { return standIn; },
    /** The v0 cabin's parts until the model is in, then the model's instanced meshes by part name. */
    get parts() { return model ? Object.fromEntries([...model.meshes].map(([k, v]) => [k, v[0]])) : standIn.parts; },
    get triangles() { return model ? model.triangles : standIn.triangles; },
    get drawCalls() { return model ? model.drawCalls : Object.keys(standIn.parts).length; },
    get windows() { return model ? model.windows : standIn.windows; },
    get shade() { return shade; },
    ready: Promise.resolve()
      .then(() => get())
      .then((loaded) => {
        if (disposed) return null;
        const m = buildModelledCabin(loaded, current, { nodes, panes });
        model = m;
        m.materials.set(light);
        m.setShade(shade);
        group.remove(standIn.group);
        group.add(m.group);
        standIn.dispose();
        standIn = null;
        return m;
      }, (e) => { error = e; return null; })
      .catch((e) => { error = e; return null; }),
    /**
     * Relight and animate. cabinLight 0..1 (the flight file's channel), night picks the warmer tint; the own shade
     * slides toward its target at 0.8 of its travel a second (at once with reduced motion or without dtS).
     * @param {object} [state]  @param {{ cabinLight?: number, night?: boolean, reducedMotion?: boolean, dtS?: number }} [o]
     */
    update(state, { cabinLight = 1, night = false, reducedMotion = false, dtS } = {}) {
      light = { cabinLight, night };
      if (model) model.materials.set(light);
      if (shade !== shadeTarget) {
        const step = reducedMotion || !Number.isFinite(dtS) ? 1 : 0.8 * dtS;
        shade = shade < shadeTarget ? Math.min(shadeTarget, shade + step) : Math.max(shadeTarget, shade - step);
        if (model) model.setShade(shade);
      }
      return api;
    },
    /** Another seat: the same group, its contents placed round the new seat. */
    setSeat(s) {
      current = s;
      if (model) { model.setSeat(s); model.setShade(shade = shadeTarget = 0); } else {
        const next = createCabin({ seat: s, materials: standInMats });
        group.remove(standIn.group);
        standIn.dispose();
        standIn = next;
        group.add(next.group);
      }
      return api;
    },
    /** The own window's shade target, 0 open to 1 closed. */
    setShade(v) { shadeTarget = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)); return api; },
    /** Key V: close an open shade, open a closed one. */
    toggleShade() { return api.setShade(shadeTarget > 0.5 ? 0 : 1); },
    dispose() {
      disposed = true;
      if (model) model.dispose();
      if (standIn) standIn.dispose();
    },
  };
  return api;
}
