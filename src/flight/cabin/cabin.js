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

import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { FUSELAGE, WINDOW, CABIN, bodyZ } from '../aircraft/dimensions.js';
import { windowStations, rowFront, seatCentreX, ROWS } from './lopa.js';

/** The cabin's layer (plan 7.6's table: CABIN 11). */
export const CABIN_LAYER = 11;

/** How far the cabin runs fore and aft of the eye, metres. */
const HALF_LENGTH = 5;
/** The trim's opening is larger than the window by this much on every side: a bevelled reveal (ESTIMATED). */
export const REVEAL_FLARE = 0.035;
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
