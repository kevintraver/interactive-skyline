// The airport's surfaces (plan 03, section 7.10; F4.2): the pavement as one mesh and its paint as another, both in the
// app's scene axes (x east, y up, z south) on the height model of geometry.js, plus the light the apron floodlights
// throw on them at night.
//
// Pavement. Runways are rectangles between the FAA's end points at the published width on the published profile;
// taxiways and aprons are the FAA's surveyed polygons, cut on a CELL_M grid so that they follow the ground. The
// classes overlap where they meet, and each sits a little higher than the one under it (LIFT), so the overlaps never
// fight for depth: apron, then taxiway, then runway. The material is procedural (per class colour, low-contrast slabs and
// joints, weathering patches), so the ground photograph shows through nowhere.
//
// Paint. Every mark is a rectangle drawn as a quad PAINT_LIFT above the runway (or the taxiway) under it: 2 cm on a
// runway, where the eye comes within 4 m at touchdown and a larger lift would show as parallax. Depth holds it there:
// reversed float depth on WebGPU and logarithmic depth on WebGL2 resolve millimetres at a kilometre, and at the grazing
// angle of a window seat the paint is metres nearer along the ray than the pavement under it. A quad narrower than a
// pixel is widened in the vertex stage to 0.6 px and made as much more transparent, so thin lines keep their average
// brightness at any distance instead of breaking into crawling dashes (the rule plan 1's point sprites use for flux).
// Rubber is drawn first in the same draw, so the paint lies on top of it.

import { BufferGeometry, BufferAttribute, Mesh, Vector2, ShapeUtils, FrontSide } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, uniform, vec2, vec3, vec4, float, floor, fract, sin, dot, mix, max, min, abs, sqrt, smoothstep, clamp,
  fwidth, normalize, length, cameraPosition, cameraProjectionMatrix, screenSize, positionLocal,
} from 'three/tsl';
import { lobe } from './lightLayout.js';
import { splitMark } from './markings.js';

/** Grid the taxiway and apron polygons are cut on, so that they follow the ground (m). */
export const CELL_M = 25;
/** Height of each class above the height model (m): the higher class wins where two overlap. */
export const LIFT = Object.freeze({ apron: 0.04, taxiway: 0.08, runway: 0.12 });
/** Paint above the pavement it lies on (m): runway paint 3 cm above the runway, taxiway paint above the taxiway. */
export const PAINT_LIFT = Object.freeze({ runway: LIFT.runway + 0.03, rubber: LIFT.runway + 0.015, taxiway: LIFT.runway + 0.04 });
const CLASS_ID = { apron: 0, taxiway: 1, runway: 2 };

/**
 * Albedo, linear. ESTIMATED from photographs: weathered Portland cement concrete about 0.30, a little lighter on aprons
 * and a little darker on taxiways; runway paint about 0.6 (white traffic paint with glass beads is 0.75 new); FAA
 * yellow; rubber deposits near black.
 */
export const ALBEDO = Object.freeze({
  runway: [0.30, 0.29, 0.27], taxiway: [0.25, 0.24, 0.225], apron: [0.33, 0.32, 0.30],
  white: [0.62, 0.62, 0.6], yellow: [0.72, 0.5, 0.05], rubber: [0.035, 0.035, 0.035],
});

// ---- polygon cutting

/** Sutherland-Hodgman: the part of `pts` ([[x, y], ...]) on the side of the line where sign * (coord - v) >= 0. */
function clipHalf(pts, axis, v, sign) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const da = sign * (a[axis] - v), db = sign * (b[axis] - v);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const k = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}

/** A polygon ring ([x0, y0, ...]) cut on a grid of `cell` metres: a list of rings ([[x, y], ...]). */
export function cutOnGrid(ring, cell) {
  const pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const out = [];
  for (let i = Math.floor(x0 / cell); i * cell < x1; i++) {
    const col = clipHalf(clipHalf(pts, 0, i * cell, 1), 0, (i + 1) * cell, -1);
    if (col.length < 3) continue;
    for (let j = Math.floor(y0 / cell); j * cell < y1; j++) {
      const c = clipHalf(clipHalf(col, 1, j * cell, 1), 1, (j + 1) * cell, -1);
      if (c.length >= 3) out.push(c);
    }
  }
  return out;
}

/** Signed area of [[x, y], ...] (positive counter-clockwise). */
const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
};

/** Apron floodlights' illuminance on the ground at map (x, y, z), lux: each mast's beam toward the point, times the
 * cosine on a level surface, over the distance squared; masts beyond 200 m are left out. */
export function createFloodField(floods) {
  const cell = 200, buckets = new Map();
  for (const l of floods) {
    const k = `${Math.floor(l.x / cell)},${Math.floor(l.y / cell)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }
  return (x, y, z) => {
    let lux = 0;
    const i0 = Math.floor(x / cell), j0 = Math.floor(y / cell);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const l of buckets.get(`${i},${j}`) || []) {
        const dx = l.x - x, dy = l.y - y, dz = l.z - z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > cell * cell || dz <= 0) continue;
        lux += (lobe(l, [x, y, z]) * (dz / Math.sqrt(r2))) / r2;
      }
    }
    return lux;
  };
}

/**
 * @param {{ data: object, frames: object, marks: object[], heightAt: (x: number, y: number) => number,
 *   frame: { sceneY: (h: number, x: number, y: number) => number }, nodes: { emissive: Function }, floods?: object[] }} o
 *   marks: runwayMarkings() then taxiwayMarkings(), rubber first; floods: the layout's floodlights
 */
export function createSurfaces({ data, frames, marks, heightAt, frame, nodes, floods = [] }) {
  const floodAt = createFloodField(floods);
  const uFlood = uniform(0);

  // ---- pavement
  const P = [], A = [], I = [];
  const vertex = (x, y, cls, u, v) => {
    const h = heightAt(x, y);
    P.push(x, frame.sceneY(h + LIFT[cls], x, y), -y);
    A.push(CLASS_ID[cls], u, v, floodAt(x, y, h));
    return P.length / 3 - 1;
  };
  // runways: a grid 25 m along and four strips across, on the profile
  for (const r of frames.runways) {
    const n = Math.max(1, Math.ceil(r.length / CELL_M)), m = 4;
    const base = P.length / 3;
    for (let i = 0; i <= n; i++) {
      const s = (r.length * i) / n;
      for (let j = 0; j <= m; j++) {
        const t = -r.width / 2 + (r.width * j) / m;
        vertex(r.a[0] + r.u[0] * s + r.u[1] * t, r.a[1] + r.u[1] * s - r.u[0] * t, 'runway', s, t);
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const a = base + i * (m + 1) + j, b = a + 1, c = a + m + 1, d = c + 1;
      // b is to the right of a, c ahead of it: counter-clockwise seen from above in map axes, which faces up (+y) in
      // the scene's x, y, -z
      I.push(a, b, c, b, d, c);
    }
  }
  // taxiways and aprons: the FAA's polygons cut on the grid
  let pieces = 0;
  for (const cls of ['apron', 'taxiway']) {
    for (const poly of data.pavement?.[cls] || []) {
      for (const pts of cutOnGrid(poly.ring, CELL_M)) {
        if (Math.abs(area(pts)) < 0.01) continue;
        const contour = pts.map(([x, y]) => new Vector2(x, y));
        const tris = ShapeUtils.triangulateShape(contour, []);
        const base = P.length / 3;
        for (const [x, y] of pts) vertex(x, y, cls, x, y);
        for (const [a, b, c] of tris) {
          // keep each triangle facing up in the scene (counter-clockwise in map axes faces +y)
          const [pa, pb, pc] = [pts[a], pts[b], pts[c]];
          const ccw = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]) > 0;
          if (ccw) I.push(base + a, base + b, base + c); else I.push(base + a, base + c, base + b);
        }
        pieces++;
      }
    }
  }
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  pg.setAttribute('pave', new BufferAttribute(new Float32Array(A), 4));
  pg.setIndex(I);
  pg.computeVertexNormals();
  pg.computeBoundingSphere();
  const pavementMat = pavementMaterial({ nodes, uFlood });
  const pavement = new Mesh(pg, pavementMat);
  pavement.name = 'airport-pavement';
  pavement.receiveShadow = true;

  // ---- paint
  const pp = [], pax = [], pco = [], pcl = [];
  const pi = [];
  let quads = 0;
  for (const mark of marks) {
    for (const m of splitMark(mark, CELL_M)) {
      const cls = m.colour === 'rubber' ? 'rubber' : m.runway ? 'runway' : 'taxiway';
      const vx = m.uy, vy = -m.ux;
      const col = ALBEDO[m.colour];
      const base = pp.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = m.cx + a * m.hl * m.ux + b * m.hw * vx, y = m.cy + a * m.hl * m.uy + b * m.hw * vy;
        const h = heightAt(x, y);
        pp.push(x, frame.sceneY(h + PAINT_LIFT[cls], x, y), -y);
        // the mark's axis in scene axes (x, -y), its half extents
        pax.push(m.ux, -m.uy, m.hl, m.hw);
        pco.push(a, b, m.soft || 0, floodAt(x, y, h));
        pcl.push(col[0], col[1], col[2], m.alpha ?? 1);
      }
      pi.push(base, base + 2, base + 1, base, base + 3, base + 2);
      quads++;
    }
  }
  const qg = new BufferGeometry();
  qg.setAttribute('position', new BufferAttribute(new Float32Array(pp), 3));
  qg.setAttribute('paintAxis', new BufferAttribute(new Float32Array(pax), 4));
  qg.setAttribute('paintCorner', new BufferAttribute(new Float32Array(pco), 4));
  qg.setAttribute('paintColour', new BufferAttribute(new Float32Array(pcl), 4));
  qg.setIndex(pi);
  const normals = new Float32Array(pp.length);
  for (let k = 1; k < normals.length; k += 3) normals[k] = 1;
  qg.setAttribute('normal', new BufferAttribute(normals, 3));
  qg.computeBoundingSphere();
  const paintMat = paintMaterial({ nodes, uFlood });
  const paint = new Mesh(qg, paintMat);
  paint.name = 'airport-paint';
  paint.renderOrder = 1;
  paint.receiveShadow = true;

  return {
    pavement, paint,
    stats: () => ({ pavementTriangles: I.length / 3, paintQuads: quads, paintTriangles: quads * 2, polygonPieces: pieces }),
    /** Night: the floodlights' light on the pavement. */
    setNight(on) { uFlood.value = on ? 1 : 0; },
    dispose() { pg.dispose(); qg.dispose(); pavementMat.dispose(); paintMat.dispose(); },
  };
}

const hash = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
const col3 = (c) => vec3(c[0], c[1], c[2]);

/** The pavement: per class colour, slabs and joints, patches of weathering; the floods' light by night. */
function pavementMaterial({ nodes, uFlood }) {
  const m = new MeshStandardNodeMaterial({ name: 'airport-pavement', roughness: 0.92, metalness: 0 });
  const pave = attribute('pave', 'vec4');
  const cls = pave.x, uv = vec2(pave.y, pave.z);
  const base = mix(mix(col3(ALBEDO.apron), col3(ALBEDO.taxiway), smoothstep(0.5, 0.5001, cls)), col3(ALBEDO.runway), smoothstep(1.5, 1.5001, cls));
  // concrete slabs 25 ft (7.62 m) square, each a shade lighter or darker, and dark joints that fade before they alias
  const slab = uv.div(7.62);
  const cell = floor(slab);
  const shade = hash(cell).sub(0.5).mul(0.08);
  const f = fract(slab), fw = max(fwidth(slab), vec2(1e-4));
  const jointW = vec2(0.006);
  const jx = smoothstep(jointW.x.add(fw.x), jointW.x, min(f.x, float(1).sub(f.x)));
  const jy = smoothstep(jointW.y.add(fw.y), jointW.y, min(f.y, float(1).sub(f.y)));
  const fade = float(1).sub(smoothstep(0.08, 0.35, max(fw.x, fw.y)));
  const joint = max(jx, jy).mul(fade).mul(0.15);
  // weathering in patches of 40 m and 9 m
  const patch = hash(floor(uv.div(40))).sub(0.5).mul(0.1).add(hash(floor(uv.div(9)).add(7.3)).sub(0.5).mul(0.05));
  const albedo = base.mul(float(1).add(shade).add(patch).sub(joint));
  m.colorNode = albedo;
  // floodlight illuminance (lux) x albedo / pi = cd/m^2, at night
  m.emissiveNode = nodes.emissive(albedo.mul(varying(pave.w)).mul(uFlood).div(Math.PI), { artificial: true });
  return m;
}

/** The paint: coverage-preserving widening below a pixel, soft edges for rubber, the floods' light by night. */
function paintMaterial({ nodes, uFlood }) {
  const m = new MeshStandardNodeMaterial({ name: 'airport-paint', roughness: 0.8, metalness: 0, transparent: true, depthWrite: false, side: FrontSide });
  const axis = attribute('paintAxis', 'vec4'), corner = attribute('paintCorner', 'vec4'), colour = attribute('paintColour', 'vec4');
  const a = normalize(vec3(axis.x, 0, axis.y)), b = vec3(axis.y, 0, axis.x.negate());
  const toP = positionLocal.sub(cameraPosition);
  const d = max(length(toP), 1e-3);
  const v = toP.div(d);
  // metres per pixel at that distance, and how much each of the mark's axes is foreshortened
  const pm = d.mul(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y).max(1));
  const fa = sqrt(max(float(1).sub(dot(a, v).mul(dot(a, v))), 1e-4)), fb = sqrt(max(float(1).sub(dot(b, v).mul(dot(b, v))), 1e-4));
  const minHalf = pm.mul(0.6);
  const hl = max(axis.z, minHalf.div(fa)), hw = max(axis.w, minHalf.div(fb));
  m.positionNode = positionLocal.add(a.mul(corner.x.mul(hl.sub(axis.z)))).add(b.mul(corner.y.mul(hw.sub(axis.w))));
  const coverage = varying(axis.z.div(hl).mul(axis.w.div(hw)));
  const vCorner = varying(corner.xy);
  const soft = corner.z;
  const edge = mix(float(1), float(1).sub(smoothstep(0.35, 1, abs(vCorner.y))), soft);
  m.colorNode = colour.xyz;
  m.opacityNode = clamp(colour.w.mul(coverage).mul(edge), 0, 1);
  m.emissiveNode = nodes.emissive(colour.xyz.mul(varying(corner.w)).mul(uFlood).div(Math.PI), { artificial: true });
  return m;
}
