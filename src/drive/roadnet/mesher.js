/**
 * Meshes a stretch of road into chunk-local buffers ready to transfer from a worker. Pure; no three.
 *
 * Each row across the road is a run of strips, left to right: embankment skirt and slope, shoulder,
 * edge-line strip, lane, lane-line strip, ..., edge-line strip, shoulder, slope, skirt. Every strip
 * has its own two vertices so UVs and kinds can change between strips. Rows fall on every 1st, 4th
 * or 16th station (levels 0, 1, 2) plus the ends of the stretch, section boundaries and `split`
 * points, so the ends of a chunk are the same vertices at every level and neighbours never crack.
 */
import { createRefline } from './refline.js';
import { edgesAt } from './crosssection.js';
import { CYCLE, MARK_W, KIND, regionU } from './atlas.js';

export const LOD_STRIDE = [1, 4, 16]; // stations between rows, per level
export const CHUNK_STATIONS = 64; // 256 m at 4 m spacing
// Embankment, outward from each shoulder edge: [horizontal metres, drop metres] per piece.
export const EMBANKMENT = [[24, 6], [20, 40]];
const EMB_W = EMBANKMENT[0][0] + EMBANKMENT[1][0];
const FOLD = 0.8; // on the inside of a curve the embankment stops at this fraction of the radius

const reflines = new WeakMap();
/** The road's refline, built once per road object. */
export function reflineOf(road) {
  let r = reflines.get(road);
  if (!r) { r = createRefline(road); reflines.set(road, r); }
  return r;
}

const layouts = new WeakMap(); // cross-section -> pieces
/**
 * Strips of one row as pieces { dl, dr, tl, tr, region, kind, emb } left to right: lateral
 * offsets, the fraction across the atlas region at each side, and for embankment pieces which
 * side (-1 left, 1 right) with the horizontal distance and drop from the shoulder edge.
 */
export function rowPieces(cs) {
  let pieces = layouts.get(cs);
  if (pieces) return pieces;
  pieces = [];
  const { strips, lines } = cs;
  const half = MARK_W / 2;
  // how far each line's marking strip reaches into the strip on its left and on its right
  const reach = lines.map((ln, i) => {
    if (ln.kind === 'none') return [0, 0];
    const leftW = strips[i].left - strips[i].right, rightW = strips[i + 1].left - strips[i + 1].right;
    return [Math.min(half, i === 0 ? leftW : leftW / 2), Math.min(half, i === lines.length - 1 ? rightW : rightW / 2)];
  });
  // left embankment, outer piece first
  const L = cs.left, R = cs.right;
  pieces.push({ dl: L + EMB_W, dr: L + EMBANKMENT[0][0], tl: 1, tr: EMBANKMENT[0][0] / EMB_W, region: 'dirt', kind: KIND.embankment, emb: [-1, EMB_W, EMBANKMENT[0][0]] });
  pieces.push({ dl: L + EMBANKMENT[0][0], dr: L, tl: EMBANKMENT[0][0] / EMB_W, tr: 0, region: 'dirt', kind: KIND.embankment, emb: [-1, EMBANKMENT[0][0], 0] });
  strips.forEach((st, i) => {
    const l = st.left - (i > 0 ? reach[i - 1][1] : 0);
    const r = st.right + (i < lines.length ? reach[i][0] : 0);
    if (l - r > 1e-6) {
      const region = st.kind === 'lane' ? 'lane' : 'shoulder';
      pieces.push({ dl: l, dr: r, tl: 0, tr: 1, region, kind: st.kind === 'lane' ? KIND.lane : KIND.shoulder });
    }
    if (i < lines.length && lines[i].kind !== 'none') {
      const ln = lines[i];
      const [a, b] = reach[i];
      let tl = 0.5 - a / MARK_W, tr = 0.5 + b / MARK_W;
      // edge regions run from the lane side (t = 0) to the shoulder side (t = 1)
      if (ln.edge === 'left') { tl = 0.5 + a / MARK_W; tr = 0.5 - b / MARK_W; }
      pieces.push({ dl: ln.d + a, dr: ln.d - b, tl, tr, region: ln.kind, kind: KIND.marking });
    }
  });
  pieces.push({ dl: R, dr: R - EMBANKMENT[0][0], tl: 0, tr: EMBANKMENT[0][0] / EMB_W, region: 'dirt', kind: KIND.embankment, emb: [1, 0, EMBANKMENT[0][0]] });
  pieces.push({ dl: R - EMBANKMENT[0][0], dr: R - EMB_W, tl: EMBANKMENT[0][0] / EMB_W, tr: 1, region: 'dirt', kind: KIND.embankment, emb: [1, EMBANKMENT[0][0], EMB_W] });
  layouts.set(cs, pieces);
  return pieces;
}

/** Drop below the shoulder edge at horizontal distance e outward. */
function embDrop(e) {
  const [[w1, d1], [w2, d2]] = EMBANKMENT;
  return e <= w1 ? (e * d1) / w1 : d1 + (Math.min(e, w1 + w2) - w1) * (d2 / w2);
}

/** Row chainages for [s0, s1] at a level: stride stations, plus the ends, section boundaries and split points. */
export function rowStations(road, s0, s1, lod, split = 0) {
  const step = LOD_STRIDE[lod] * road.spacing;
  const cuts = new Set([s0, s1]);
  for (const sec of road.sections) if (sec.s0 > s0 && sec.s0 < s1) cuts.add(sec.s0);
  if (split > 0) for (let s = Math.ceil(s0 / split + 1e-9) * split; s < s1 - 1e-9; s += split) cuts.add(s);
  const ends = [...cuts].sort((a, b) => a - b);
  const spans = [];
  for (let k = 0; k + 1 < ends.length; k++) {
    const a = ends[k], b = ends[k + 1];
    const rows = [a];
    for (let s = (Math.floor(a / step + 1e-9) + 1) * step; s < b - 1e-6; s += step) rows.push(s);
    rows.push(b);
    spans.push({ s0: a, s1: b, rows });
  }
  return spans;
}

/**
 * Mesh road stretch [s0, s1] at level `lod`.
 * @param {{ road: object, s0: number, s1: number, lod: 0|1|2, base: number, earthR: number,
 *   split?: number, origin?: number[] }} args  split: also cut rows every `split` metres and report
 *   index ranges per piece (for batches); origin: scene origin to use (default: the reference line at
 *   the middle of the stretch, rounded to whole metres, so every level of a chunk shares it)
 * @returns {{ origin: Float64Array, positions: Float32Array, normals: Float32Array, uvs: Float32Array,
 *   kind: Uint8Array, indices: Uint16Array|Uint32Array, ranges: { s0: number, s1: number, start: number, count: number }[],
 *   sphere: Float32Array, lod: number, s0: number, s1: number }}
 *   positions are scene metres relative to origin, curvature drop included; `kind` is KIND per vertex;
 *   `ranges` are index ranges per split piece (one range without split); sphere is [cx, cy, cz, r] local.
 */
export function meshChunk({ road, s0, s1, lod, base, earthR, split = 0, origin }) {
  const ref = reflineOf(road);
  s0 = Math.max(0, s0); s1 = Math.min(ref.length, s1);
  const spans = rowStations(road, s0, s1, lod, split);
  const p = {};
  let vCount = 0, iCount = 0;
  const rowsOf = spans.map((sp) => {
    const pieces = rowPieces(edgesAt(road, (sp.s0 + sp.s1) / 2));
    vCount += sp.rows.length * pieces.length * 2;
    iCount += (sp.rows.length - 1) * pieces.length * 6;
    return pieces;
  });
  if (!origin) {
    ref.at((s0 + s1) / 2, p);
    origin = [Math.round(p.x), Math.round(p.h - base - (p.x * p.x + p.y * p.y) / (2 * earthR)), Math.round(-p.y)];
  }
  const [ox, oy, oz] = origin;
  const positions = new Float32Array(vCount * 3), normals = new Float32Array(vCount * 3), uvs = new Float32Array(vCount * 2);
  const kind = new Uint8Array(vCount);
  const indices = vCount < 65536 ? new Uint16Array(iCount) : new Uint32Array(iCount);
  const vBase = Math.floor(s0 / CYCLE) * CYCLE; // keeps v small; the texture repeats on whole cycles
  const twoR = 2 * earthR;
  const ranges = [];
  let v = 0, ii = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let rangeStart = 0, rangeS0 = s0;
  const scratch = new Float64Array(6);

  spans.forEach((sp, k) => {
    const pieces = rowsOf[k];
    const np = pieces.length;
    const { left: L, right: R } = edgesAt(road, (sp.s0 + sp.s1) / 2);
    sp.rows.forEach((s, r) => {
      ref.at(s, p);
      const c = Math.cos(p.heading), sn = Math.sin(p.heading);
      // keep the inside embankment from folding over itself on tight curves
      const inner = Math.abs(p.curvature) > 1e-9 ? FOLD / Math.abs(p.curvature) : Infinity;
      const scaleL = p.curvature > 0 ? Math.max(0.05, Math.min(1, (inner - L) / EMB_W)) : 1;
      const scaleR = p.curvature < 0 ? Math.max(0.05, Math.min(1, (inner + R) / EMB_W)) : 1;
      // scene tangent of the reference line, for normals
      const ax = c, ay = p.grade - (p.x * c + p.y * sn) / earthR, az = -sn;
      const vv = (s - vBase) / CYCLE;
      const rowBase = v;
      for (let q = 0; q < np; q++) {
        const pc = pieces[q];
        for (let e = 0; e < 2; e++) {
          let d = e ? pc.dr : pc.dl;
          let hh;
          if (pc.emb) {
            const out = e ? pc.emb[2] : pc.emb[1];
            const sc = pc.emb[0] < 0 ? scaleL : scaleR;
            const edge = pc.emb[0] < 0 ? L : R;
            d = edge - pc.emb[0] * out * sc;
            hh = p.h + p.crossfall * edge - embDrop(out);
          } else {
            hh = p.h + p.crossfall * d;
          }
          const mx = p.x - d * sn, my = p.y + d * c;
          const X = mx, Y = hh - base - (mx * mx + my * my) / twoR, Z = -my;
          scratch[e * 3] = X; scratch[e * 3 + 1] = Y; scratch[e * 3 + 2] = Z;
          const lx = X - ox, ly = Y - oy, lz = Z - oz;
          positions[v * 3] = lx; positions[v * 3 + 1] = ly; positions[v * 3 + 2] = lz;
          if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
          if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
          if (lz < minZ) minZ = lz; if (lz > maxZ) maxZ = lz;
          uvs[v * 2] = regionU(pc.region, e ? pc.tr : pc.tl);
          uvs[v * 2 + 1] = vv;
          kind[v] = pc.kind;
          v++;
        }
        // normal = across x along, across running left to right
        const bx = scratch[3] - scratch[0], by = scratch[4] - scratch[1], bz = scratch[5] - scratch[2];
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const w = (v - 2) * 3;
        normals[w] = normals[w + 3] = nx; normals[w + 1] = normals[w + 4] = ny; normals[w + 2] = normals[w + 5] = nz;
      }
      if (r > 0) {
        const prev = rowBase - np * 2;
        for (let q = 0; q < np; q++) {
          const a = prev + 2 * q, b = a + 1, a2 = rowBase + 2 * q, b2 = a2 + 1;
          indices[ii++] = a; indices[ii++] = b; indices[ii++] = a2;
          indices[ii++] = b; indices[ii++] = b2; indices[ii++] = a2;
        }
      }
    });
    // close a range at each split point and at the end
    const atSplit = split > 0 && Math.abs(sp.s1 / split - Math.round(sp.s1 / split)) < 1e-9;
    if (atSplit || k === spans.length - 1) {
      ranges.push({ s0: rangeS0, s1: sp.s1, start: rangeStart, count: ii - rangeStart });
      rangeStart = ii; rangeS0 = sp.s1;
    }
  });

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const sphere = new Float32Array([cx, cy, cz, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2]);
  return { origin: Float64Array.from(origin), positions, normals, uvs, kind, indices, ranges, sphere, lod, s0, s1 };
}

/** The buffers of a meshChunk result, for postMessage's transfer list. */
export const transferablesOf = (m) => [m.origin.buffer, m.positions.buffer, m.normals.buffer, m.uvs.buffer, m.kind.buffer, m.indices.buffer, m.sphere.buffer];
