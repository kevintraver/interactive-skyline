/**
 * The geometry of one sign, in scene coordinates as doubles: its face quads (one per plate: the
 * panel, and the exit number plaque above it) and its supports (panel backs and edges, posts).
 * Pure, no three: positions are plain arrays so they can be shifted to any local origin before
 * they become float32.
 *
 * A sign stands beside the pavement at its chainage, `offset` metres outside the outer shoulder
 * edge that edgesAt gives there, facing oncoming traffic and upright along true vertical (localUp).
 * Its posts run from the panel down past the embankment surface, so it never floats.
 */
import { localUp } from '../../world/frame.js';
import { EMBANKMENT } from '../roadnet/mesher.js';
import { sheetingCode, sheetingOfColour } from './sheeting.js';

/** [background, legend] sheeting codes of a plate: the record's `sheeting`, else its colours; the exit plaque is a white legend on green. */
function sheetingOf(rec, plate) {
  if (plate === 'tab') return [sheetingCode('green'), sheetingCode('white')];
  const [bg, fg] = rec.sheeting || [sheetingOfColour(rec.bg), sheetingOfColour(rec.fg)];
  return [sheetingCode(bg), sheetingCode(fg)];
}

const THICK = 0.06; // panel thickness, m
const BURY = 0.8; // posts go this far below the embankment surface
const POST_LARGE = 0.2, POST_SMALL = 0.09, POST_MILE = 0.06;
const TWO_POSTS = 2.0; // panels at least this wide stand on two posts
export const POST_COLOUR = [0.62, 0.64, 0.65];
export const BACK_COLOUR = [0.66, 0.68, 0.7];

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; }, normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; } });
const add = (o, a, k) => [o[0] + a[0] * k, o[1] + a[1] * k, o[2] + a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Metres the embankment surface lies below the shoulder edge, `lateral` metres outside it (mesher.js). */
export function embankmentDrop(lateral) {
  const [[w1, d1], [w2, d2]] = EMBANKMENT;
  const l = Math.max(0, lateral);
  return l <= w1 ? (l * d1) / w1 : d1 + ((l - w1) * d2) / w2;
}

/**
 * Where a sign stands: the frame every part of it is built in.
 * @param {object} rec a signs.json record
 * @param {{ at: (s: number) => object, edges: (s: number) => { left: number, right: number }, base: number, earthR: number }} road
 * @returns {{ base: number[], up: number[], face: number[], right: number[], edgeH: number, map: number[], sideSign: number }}
 *   base: the scene point at the pavement edge's height below the panel's centre; up: true
 *   vertical there; face: the face normal, against the direction of travel; right: the viewer's
 *   right as they face the sign; sideSign: +1 when the viewer's right points away from the road
 */
export function signFrame(rec, road) {
  const p = road.at(rec.s);
  const e = road.edges(rec.s);
  const left = rec.side === 'left';
  const dEdge = left ? e.left : e.right;
  // an overhead panel hangs over the lanes at offset d, its height measured from the pavement under it
  const dCentre = rec.over ? rec.d : dEdge + (left ? 1 : -1) * (rec.offset + rec.w / 2);
  const sn = Math.sin(p.heading), cs = Math.cos(p.heading);
  const mx = p.x - sn * dCentre, my = p.y + cs * dCentre;
  const edgeH = p.h + p.crossfall * (rec.over ? rec.d : dEdge);
  const base = [mx, edgeH - road.base - (mx * mx + my * my) / (2 * road.earthR), -my];
  const u = localUp(base[0], base[2], v3());
  const up = [u.x, u.y, u.z];
  const travel = [cs, 0, -sn];
  const face = norm(add([-travel[0], -travel[1], -travel[2]], up, dot(travel, up))); // -travel, made level
  const right = norm(cross(up, face));
  return { base, up, face, right, edgeH, map: [mx, my], sideSign: left ? -1 : 1, d: dCentre, p, edges: e };
}

/** The plates of a sign in its own frame: x along `right` from the panel centre, y up from the pavement edge. */
export function platesOf(rec, tab) {
  const plates = [{ plate: 'panel', x: 0, y: rec.mount, w: rec.w, h: rec.h }];
  if (tab) {
    const x = tab.left ? -rec.w / 2 + tab.w / 2 : rec.w / 2 - tab.w / 2;
    plates.push({ plate: 'tab', x, y: rec.mount + rec.h, w: tab.w, h: tab.h });
  }
  return plates;
}

/** Posts in the sign's frame: [{ x, w }] (x along `right` from the panel centre). */
export function postsOf(rec) {
  const w = rec.kind === 'mile' ? POST_MILE : rec.w >= TWO_POSTS ? POST_LARGE : POST_SMALL;
  if (rec.w < TWO_POSTS) return [{ x: 0, w }];
  const k = Math.min(0.3 * rec.w, rec.w / 2 - 0.4);
  return [{ x: -k, w }, { x: k, w }];
}

/**
 * Build one sign.
 * @param {object} rec signs.json record  @param {object|null} tab its exit's plaque, if it shows one
 * @param {object} road as for signFrame
 * @param {(plate: string) => { page: number, u0: number, v0: number, u1: number, v1: number }} uvOf
 * @returns {{ frame: object, faces: { page: number, pos: number[], uv: number[], normal: number[] }[],
 *   support: { pos: number[], nor: number[], col: number[], idx: number[] }, posts: { top: number[], foot: number[], lateral: number }[] }}
 *   face quads are four corners (bottom-left, bottom-right, top-right, top-left as the driver sees
 *   them); support triangles index its own vertex list
 */
export function buildSign(rec, tab, road, uvOf) {
  const f = signFrame(rec, road);
  const at = (x, y, z) => add(add(add(f.base, f.right, x), f.up, y), f.face, z);
  const faces = [];
  const sup = { pos: [], nor: [], col: [], idx: [] };
  const quad = (a, b, c, d, n, col) => {
    const i0 = sup.pos.length / 3;
    for (const p of [a, b, c, d]) { sup.pos.push(...p); sup.nor.push(...n); sup.col.push(...col); }
    sup.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const neg = (a) => [-a[0], -a[1], -a[2]];
  let top = 0;
  for (const pl of platesOf(rec, tab)) {
    const x0 = pl.x - pl.w / 2, x1 = pl.x + pl.w / 2, y0 = pl.y, y1 = pl.y + pl.h;
    top = Math.max(top, y1);
    const uv = uvOf(pl.plate);
    faces.push({
      page: uv.page, normal: f.face, retro: sheetingOf(rec, pl.plate),
      pos: [...at(x0, y0, 0), ...at(x1, y0, 0), ...at(x1, y1, 0), ...at(x0, y1, 0)],
      uv: [uv.u0, uv.v1, uv.u1, uv.v1, uv.u1, uv.v0, uv.u0, uv.v0],
    });
    // back and the four edges, in the supports' plain material
    const b = -THICK;
    quad(at(x1, y0, b), at(x0, y0, b), at(x0, y1, b), at(x1, y1, b), neg(f.face), BACK_COLOUR);
    quad(at(x0, y1, 0), at(x1, y1, 0), at(x1, y1, b), at(x0, y1, b), f.up, BACK_COLOUR);
    quad(at(x1, y0, 0), at(x0, y0, 0), at(x0, y0, b), at(x1, y0, b), neg(f.up), BACK_COLOUR);
    quad(at(x1, y0, 0), at(x1, y0, b), at(x1, y1, b), at(x1, y1, 0), f.right, BACK_COLOUR);
    quad(at(x0, y0, b), at(x0, y0, 0), at(x0, y1, 0), at(x0, y1, b), neg(f.right), BACK_COLOUR);
  }
  const posts = [];
  for (const p of rec.over ? [] : postsOf(rec)) { // an overhead panel hangs from its structure
    // how far outside the shoulder edge this post stands, and the embankment surface there
    const lateral = rec.offset + rec.w / 2 + f.sideSign * p.x;
    const yFoot = -embankmentDrop(lateral) - BURY;
    const yTop = Math.max(rec.mount + 0.3 * rec.h, top - 0.15);
    const z0 = -THICK, z1 = -THICK - p.w, xa = p.x - p.w / 2, xb = p.x + p.w / 2;
    quad(at(xa, yFoot, z0), at(xb, yFoot, z0), at(xb, yTop, z0), at(xa, yTop, z0), f.face, POST_COLOUR);
    quad(at(xb, yFoot, z1), at(xa, yFoot, z1), at(xa, yTop, z1), at(xb, yTop, z1), neg(f.face), POST_COLOUR);
    quad(at(xb, yFoot, z0), at(xb, yFoot, z1), at(xb, yTop, z1), at(xb, yTop, z0), f.right, POST_COLOUR);
    quad(at(xa, yFoot, z1), at(xa, yFoot, z0), at(xa, yTop, z0), at(xa, yTop, z1), neg(f.right), POST_COLOUR);
    quad(at(xa, yTop, z0), at(xb, yTop, z0), at(xb, yTop, z1), at(xa, yTop, z1), f.up, POST_COLOUR);
    posts.push({ top: at(p.x, yTop, z0), foot: at(p.x, yFoot, z0), lateral, yFoot });
  }
  return { frame: f, faces, support: sup, posts };
}
