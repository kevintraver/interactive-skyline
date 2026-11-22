// Building volumes from buildings.json turned into triangles: walls, flat roofs, pyramids and domes, and
// hand-modelled pieces that lean or taper. Output goes into growable vertex arrays.
import * as THREE from 'three';

export function ring(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], flat[i + 1]));
  return pts;
}

/** Append one extruded footprint (walls + flat roof) to the output arrays. Heights are lowered by `BASE`. */
export function extrude(vol, out, tint, BASE) {
  const outer = ring(vol.o);
  if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
  const holes = vol.h.map(ring).map((h) => (THREE.ShapeUtils.isClockWise(h) ? h : h.reverse()));
  const bot = vol.b - BASE, roofTop = vol.t - BASE;
  const top = vol.r ? roofTop - vol.r[1] : roofTop; // where the walls stop
  const push = (x, y, mapY, nx, ny, nz, shade) => {
    if (out.n === out.cap) grow(out);
    const k = out.n++ * 3, { pos, nor, col } = out;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = -mapY;
    nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
    col[k] = tint[0] * shade; col[k + 1] = tint[1] * shade; col[k + 2] = tint[2] * shade;
  };
  for (const r of vol.u ? [] : [outer, ...holes]) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, nz = dx / l; // outward normal of a counter-clockwise ring, in world axes
      push(p.x, bot, p.y, nx, 0, nz, 1); push(q.x, bot, q.y, nx, 0, nz, 1); push(q.x, top, q.y, nx, 0, nz, 1);
      push(p.x, bot, p.y, nx, 0, nz, 1); push(q.x, top, q.y, nx, 0, nz, 1); push(p.x, top, p.y, nx, 0, nz, 1);
    }
  }
  if (vol.u) {
    // Hand-modelled piece: the walls run from the footprint to a second outline at the top,
    // so it can lean or taper.
    const up = ring(vol.u);
    if (THREE.ShapeUtils.isClockWise(up)) up.reverse();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3();
    const tri = (a, ya, b, yb, c, yc) => {
      A.set(a.x, ya, -a.y); B.set(b.x, yb, -b.y); C.set(c.x, yc, -c.y);
      n.subVectors(B, A).cross(C.sub(A));
      if (n.lengthSq() < 1e-6) return;
      n.normalize();
      push(a.x, ya, a.y, n.x, n.y, n.z, 1); push(b.x, yb, b.y, n.x, n.y, n.z, 1); push(c.x, yc, c.y, n.x, n.y, n.z, 1);
    };
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      tri(outer[i], bot, outer[j], bot, up[j], roofTop);
      tri(outer[i], bot, up[j], roofTop, up[i], roofTop);
    }
    for (const t of THREE.ShapeUtils.triangulateShape(up, [])) for (const i of t) push(up[i].x, roofTop, up[i].y, 0, 1, 0, 0.86);
    for (const t of THREE.ShapeUtils.triangulateShape(outer, [])) for (const i of [t[2], t[1], t[0]]) push(outer[i].x, bot, outer[i].y, 0, -1, 0, 0.8);
    return;
  }
  if (vol.r) {
    // Pyramid or dome: shrink the footprint toward its center in steps as it rises.
    const [kind, rh] = vol.r, steps = kind === 'd' ? 7 : 1;
    const cx = outer.reduce((a, p) => a + p.x, 0) / outer.length, cy = outer.reduce((a, p) => a + p.y, 0) / outer.length;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3();
    const tri = (a, ya, b, yb, c, yc) => {
      A.set(a.x, ya, -a.y); B.set(b.x, yb, -b.y); C.set(c.x, yc, -c.y);
      n.subVectors(B, A).cross(C.sub(A));
      if (n.lengthSq() < 1e-6) return;
      n.normalize();
      push(a.x, ya, a.y, n.x, n.y, n.z, 0.93); push(b.x, yb, b.y, n.x, n.y, n.z, 0.93); push(c.x, yc, c.y, n.x, n.y, n.z, 0.93);
    };
    let prev = outer, prevY = top;
    for (let s = 1; s <= steps; s++) {
      const a = (s / steps) * Math.PI / 2;
      const k = kind === 'd' ? Math.cos(a) : 0, y = top + rh * (kind === 'd' ? Math.sin(a) : 1);
      const cur = outer.map((p) => new THREE.Vector2(cx + (p.x - cx) * k, cy + (p.y - cy) * k));
      for (let i = 0; i < outer.length; i++) {
        const j = (i + 1) % outer.length;
        tri(prev[i], prevY, prev[j], prevY, cur[j], y);
        tri(prev[i], prevY, cur[j], y, cur[i], y);
      }
      prev = cur; prevY = y;
    }
    return;
  }
  const all = [outer, ...holes].flat();
  for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) {
    for (const i of tri) push(all[i].x, top, all[i].y, 0, 1, 0, 0.86);
  }
}

export function toGeometry(out) {
  const geo = new THREE.BufferGeometry();
  for (const [name, key] of [['position', 'pos'], ['normal', 'nor'], ['color', 'col']]) {
    geo.setAttribute(name, new THREE.BufferAttribute(out[key].slice(0, out.n * 3), 3));
  }
  // night light baked into a hand-made model; extruded buildings have none and read as zero
  if (out.glow) geo.setAttribute('glow', new THREE.BufferAttribute(out.glow, 3));
  if (out.win) geo.setAttribute('windows', new THREE.BufferAttribute(out.win, 1));
  if (out.led) geo.setAttribute('led', new THREE.BufferAttribute(out.led, 1));
  return geo;
}

/** Vertex arrays that double in size as they fill. `n` vertices are in use out of `cap`. */
export const fresh = (cap = 256) => ({ n: 0, cap, pos: new Float32Array(cap * 3), nor: new Float32Array(cap * 3), col: new Float32Array(cap * 3) });
export function grow(out) {
  out.cap *= 2;
  for (const key of ['pos', 'nor', 'col']) {
    const bigger = new Float32Array(out.cap * 3);
    bigger.set(out[key]);
    out[key] = bigger;
  }
}
