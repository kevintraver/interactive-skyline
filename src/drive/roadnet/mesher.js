/**
 * Meshes a stretch of road into chunk-local buffers ready to transfer from a worker. Pure; no three.
 *
 * Each row across the road is a run of strips, left to right: embankment skirt and slope, shoulder,
 * edge-line strip, lane, lane-line strip, ..., edge-line strip, shoulder, slope, skirt. Every strip
 * has its own two vertices so UVs and kinds can change between strips. Rows fall on every 1st, 4th
 * or 16th station (levels 0, 1, 2) plus the ends of the stretch, section boundaries, the ends and
 * middle of every taper, the ends of bridges and gores, and `split` points, so the ends of a chunk
 * are the same vertices at every level and neighbours never crack. Between two such cuts the strips
 * keep their number and kinds, and every row takes the cross-section at its own chainage (inside a
 * taper the widths change from row to row); a span's last row asks for the cross-section "just
 * before" its chainage, so the two rows at a cut have the same positions and may differ only in kinds.
 *
 * Interchanges (format.js, "junctions and gores", "structures"): on a deck the embankment gives way
 * to a slab with parapets; a carriageway that is itself a bridge gets parapets; where a ramp leaves
 * or joins, the road's shoulder on that side is hidden and the gore is filled; an embankment stops
 * where the road's `embankment` entries say; piers and abutments are boxes and wedges. All of it
 * goes into the same buffers, so a chunk stays one draw call.
 *
 * Barriers (src/drive/roadside/barrierFormat.js, attached to a road as `road.barriers`, the decoded
 * runs) are swept profiles from src/drive/roadside/sweep.js, written into the same buffers, with
 * their level of detail following the chunk's. Every vertex also carries `retro`, the sheeting of
 * a retroreflective element (src/drive/roadside/sheeting.js: 0 none, 1 white, 2 yellow, ...); only
 * barrier reflectors have one.
 */
import { createRefline } from './refline.js';
import { edgesAt, tapersOf } from './crosssection.js';
import { CYCLE, MARK_W, KIND, regionU, tileFor, surfaceAt, surfaceCuts } from './atlas.js';
import { sweepBarriers } from '../roadside/sweep.js';

export const LOD_STRIDE = [1, 4, 16]; // stations between rows, per level
export const CHUNK_STATIONS = 64; // 256 m at 4 m spacing
// Embankment, outward from each shoulder edge: [horizontal metres, drop metres] per piece.
export const EMBANKMENT = [[24, 6], [20, 40]];
const EMB_W = EMBANKMENT[0][0] + EMBANKMENT[1][0];
const FOLD = 0.8; // on the inside of a curve the embankment stops at this fraction of the radius
const WALL = 4; // m: an embankment held to less than this is drawn as a concrete wall
// Decks and parapets, metres
export const DECK = 1.2; // surface to soffit
export const PARAPET = { h: 0.85, w: 0.4 };

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
  const keepAll = !!cs.taper; // in a taper strips come and go through zero width: keep them all
  strips.forEach((st, i) => {
    const l = st.left - (i > 0 ? reach[i - 1][1] : 0);
    const r = st.right + (i < lines.length ? reach[i][0] : 0);
    if (keepAll || l - r > 1e-6) {
      const region = st.kind === 'lane' ? 'lane' : 'shoulder';
      pieces.push({ dl: l, dr: r, tl: 0, tr: 1, region, kind: st.kind === 'lane' ? KIND.lane : KIND.shoulder, side: st.side });
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

/** The edge of the marking strip that borders a shoulder: where a gore begins (format.js). */
export function goreEdge(cs, side) {
  const { strips, lines } = cs;
  if (side === 'left') {
    const ln = lines[0];
    return ln.kind === 'none' ? ln.d : ln.d + Math.min(MARK_W / 2, strips[0].left - strips[0].right);
  }
  const ln = lines[lines.length - 1], sh = strips[strips.length - 1];
  return ln.kind === 'none' ? ln.d : ln.d - Math.min(MARK_W / 2, sh.left - sh.right);
}

const S = (dl, dr, zl, zr) => ({ dl, dr, zl, zr, tl: 0, tr: 1, region: 'concrete', kind: KIND.structure });
/** Parapet faces on one edge: left side outer face up, top inward, inner face down; mirrored on the right. */
function parapet(edge, side, down) {
  const { h, w } = PARAPET;
  if (side === 'left') return [S(edge, edge, -down, h), S(edge, edge - w, h, h), S(edge - w, edge - w, h, 0)];
  return [S(edge + w, edge + w, 0, h), S(edge + w, edge, h, h), S(edge, edge, h, -down)];
}

const modeCache = new WeakMap(); // cross-section -> Map(modeKey -> pieces)
/**
 * The pieces of a row in a mode: { deck, parapet, hideL, hideR }. A hidden shoulder keeps its
 * vertices at zero width and the embankment starts from the gore edge; a deck replaces the
 * embankments with parapets, fascias and a soffit; parapets alone sit between pavement and embankment.
 */
export function modePieces(cs, mode) {
  const base = rowPieces(cs);
  if (!mode || (!mode.deck && !mode.parapet && !mode.hideL && !mode.hideR)) return base;
  const key = `${mode.deck ? 1 : 0}${mode.parapet ? 1 : 0}${mode.hideL ? 1 : 0}${mode.hideR ? 1 : 0}`;
  let byMode = modeCache.get(cs);
  if (!byMode) { byMode = new Map(); modeCache.set(cs, byMode); }
  let out = byMode.get(key);
  if (out) return out;
  let pave = base.slice(2, base.length - 2);
  let edgeL = cs.left, edgeR = cs.right;
  if (mode.hideR) {
    const k = pave.length - 1;
    if (pave[k].kind === KIND.shoulder && pave[k].side === 'right') { edgeR = goreEdge(cs, 'right'); pave = [...pave.slice(0, k), { ...pave[k], dl: edgeR, dr: edgeR }]; }
  }
  if (mode.hideL) {
    if (pave[0].kind === KIND.shoulder && pave[0].side === 'left') { edgeL = goreEdge(cs, 'left'); pave = [{ ...pave[0], dl: edgeL, dr: edgeL }, ...pave.slice(1)]; }
  }
  const embL = base.slice(0, 2).map((pc) => ({ ...pc, edgeD: edgeL }));
  const embR = base.slice(base.length - 2).map((pc) => ({ ...pc, edgeD: edgeR }));
  if (mode.deck) {
    // the soffit is lit as a side face: the desert floor throws light up under a deck, which the
    // hemisphere light alone (its ground colour) leaves near black
    out = [...parapet(edgeL, 'left', DECK), ...pave, ...parapet(edgeR, 'right', DECK), { ...S(edgeR, edgeL, -DECK, -DECK), soffit: true }];
  } else if (mode.parapet) {
    // no parapet on a side whose shoulder a gore hides: the pavement runs on there to the ramp beside it, and a wall
    // would stand in the middle of the gore (I-15 north's short bridge over a wash at Exit 25)
    out = [...embL, ...(mode.hideL ? [] : parapet(edgeL, 'left', 0)), ...pave, ...(mode.hideR ? [] : parapet(edgeR, 'right', 0)), ...embR];
  } else {
    out = [...embL, ...pave, ...embR];
  }
  byMode.set(key, out);
  return out;
}

/** Drop below the shoulder edge at horizontal distance e outward. */
function embDrop(e) {
  const [[w1, d1], [w2, d2]] = EMBANKMENT;
  return e <= w1 ? (e * d1) / w1 : d1 + (Math.min(e, w1 + w2) - w1) * (d2 / w2);
}

/** The mode of a row at s (a span's middle). */
export function modeAt(road, s) {
  const mode = { deck: false, parapet: false, hideL: false, hideR: false };
  for (const b of road.bridges || []) if (s > b.s0 && s < b.s1) { if (b.deck) mode.deck = true; else mode.parapet = true; }
  for (const h of road.hides || []) if (s > h.s0 && s < h.s1) mode[h.side === 'left' ? 'hideL' : 'hideR'] = true;
  return mode;
}

/** How far the embankment may reach on `side` at s (EMB_W where the road says nothing). */
function roomAt(road, s, side) {
  let w = EMB_W;
  for (const e of road.embankment || []) if (e.side === side && s >= e.s0 && s <= e.s1 && e.w < w) w = e.w;
  return w;
}

/**
 * Row chainages for [s0, s1] at a level: stride stations, plus the ends, section boundaries, the
 * ends and middle of every taper, the ends of bridges and hidden shoulders, and split points.
 */
export function rowStations(road, s0, s1, lod, split = 0) {
  const step = LOD_STRIDE[lod] * road.spacing;
  const cuts = new Set([s0, s1]);
  const add = (s) => { if (s > s0 && s < s1) cuts.add(s); };
  for (const sec of road.sections) add(sec.s0);
  for (const tp of tapersOf(road)) { add(tp.s0); add((tp.s0 + tp.s1) / 2); add(tp.s1); }
  for (const b of road.bridges || []) { add(b.s0); add(b.s1); }
  for (const h of road.hides || []) { add(h.s0); add(h.s1); }
  for (const c of surfaceCuts(road)) add(c); // asphalt to concrete, and bridge expansion joints (atlas.js)
  if (split > 0) for (let s = Math.ceil(s0 / split + 1e-9) * split; s < s1 - 1e-9; s += split) cuts.add(s);
  const ends = [...cuts].sort((a, b) => a - b);
  const spans = [];
  for (let k = 0; k + 1 < ends.length; k++) {
    const a = ends[k], b = ends[k + 1];
    const rows = [a];
    for (let s = (Math.floor(a / step + 1e-9) + 1) * step; s < b - 1e-6; s += step) rows.push(s);
    rows.push(b);
    spans.push({ s0: a, s1: b, rows, mode: modeAt(road, (a + b) / 2), surface: surfaceAt(road, (a + b) / 2) });
  }
  return spans;
}

/** Growable buffers for the geometry that is not a strip of the road itself. */
function extraBuffers() {
  return { p: [], n: [], uv: [], k: [], r: [], idx: [], v: 0 };
}

/**
 * How much of its full width the embankment keeps on each side at a row: squeezed on the inside of
 * a tight curve so it does not fold, and short of other roads where the road's `embankment` says.
 */
export function embScales(road, p, L, R, s) {
  const inner = Math.abs(p.curvature) > 1e-9 ? FOLD / Math.abs(p.curvature) : Infinity;
  let scaleL = p.curvature > 0 ? Math.max(0.05, Math.min(1, (inner - L) / EMB_W)) : 1;
  let scaleR = p.curvature < 0 ? Math.max(0.05, Math.min(1, (inner + R) / EMB_W)) : 1;
  if (road.embankment?.length) {
    scaleL = Math.min(scaleL, roomAt(road, s, 'left') / EMB_W);
    scaleR = Math.min(scaleR, roomAt(road, s, 'right') / EMB_W);
  }
  return [scaleL, scaleR];
}

/**
 * Mesh road stretch [s0, s1] at level `lod`.
 * @param {{ road: object, s0: number, s1: number, lod: 0|1|2, base: number, earthR: number,
 *   split?: number, origin?: number[], roads?: object[] }} args  split: also cut rows every `split`
 *   metres and report index ranges per piece (for batches); origin: scene origin to use (default:
 *   the reference line at the middle of the stretch, rounded to whole metres, so every level of a
 *   chunk shares it); roads: every road of the network (decoded), for the gores of this road
 * @returns {{ origin: Float64Array, positions: Float32Array, normals: Float32Array, uvs: Float32Array,
 *   kind: Uint8Array, retro: Uint8Array, indices: Uint16Array|Uint32Array, ranges: { s0: number, s1: number, start: number, count: number }[],
 *   sphere: Float32Array, lod: number, s0: number, s1: number }}
 *   positions are scene metres relative to origin, curvature drop included; `kind` is KIND per vertex;
 *   `ranges` are index ranges per split piece (one range without split); sphere is [cx, cy, cz, r] local.
 */
export function meshChunk({ road, s0, s1, lod, base, earthR, split = 0, origin, roads }) {
  const ref = reflineOf(road);
  s0 = Math.max(0, s0); s1 = Math.min(ref.length, s1);
  const spans = rowStations(road, s0, s1, lod, split);
  const p = {};
  let vCount = 0, iCount = 0;
  // a row's cross-section: the span's last row asks for the one that holds up to its chainage
  const csAt = (sp, r) => edgesAt(road, sp.rows[r], r === sp.rows.length - 1 ? 'before' : 'after');
  const rowsOf = spans.map((sp) => {
    const n = modePieces(csAt(sp, 0), sp.mode).length;
    vCount += sp.rows.length * n * 2;
    iCount += (sp.rows.length - 1) * n * 6;
    return n;
  });
  if (!origin) {
    ref.at((s0 + s1) / 2, p);
    origin = [Math.round(p.x), Math.round(p.h - base - (p.x * p.x + p.y * p.y) / (2 * earthR)), Math.round(-p.y)];
  }
  const [ox, oy, oz] = origin;
  const positions = new Float32Array(vCount * 3), normals = new Float32Array(vCount * 3), uvs = new Float32Array(vCount * 2);
  const kind = new Uint8Array(vCount);
  const stripIdx = new Uint32Array(iCount);
  const vBase = Math.floor(s0 / CYCLE) * CYCLE; // keeps v small; the texture repeats on whole cycles
  const twoR = 2 * earthR;
  const rangeParts = [];
  let v = 0, ii = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const grow = (lx, ly, lz) => {
    if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
    if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
    if (lz < minZ) minZ = lz; if (lz > maxZ) maxZ = lz;
  };
  let rangeStart = 0, rangeS0 = s0;
  const scratch = new Float64Array(6);
  const ex = extraBuffers();
  let exStart = 0;

  spans.forEach((sp, k) => {
    const np = rowsOf[k];
    const lastLane = modePieces(csAt(sp, 0), sp.mode).findLastIndex((pc) => pc.kind === KIND.lane); // the right-hand lane wears most
    sp.rows.forEach((s, r) => {
      const cs = csAt(sp, r);
      const pieces = modePieces(cs, sp.mode);
      if (pieces.length !== np) throw new Error(`mesher: the cross-section changes structure inside a span at s = ${s}`);
      const { left: L, right: R } = cs;
      ref.at(s, p);
      const c = Math.cos(p.heading), sn = Math.sin(p.heading);
      // keep the inside embankment from folding over itself on tight curves, and short of other roads
      const [scaleL, scaleR] = embScales(road, p, L, R, s);
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
            const edge = pc.edgeD ?? (pc.emb[0] < 0 ? L : R);
            d = edge - pc.emb[0] * out * sc;
            hh = p.h + p.crossfall * edge - embDrop(out); // squeezed to nothing it is a wall
          } else {
            hh = p.h + p.crossfall * d + (pc.zl !== undefined ? (e ? pc.zr : pc.zl) : 0);
          }
          const mx = p.x - d * sn, my = p.y + d * c;
          const X = mx, Y = hh - base - (mx * mx + my * my) / twoR, Z = -my;
          scratch[e * 3] = X; scratch[e * 3 + 1] = Y; scratch[e * 3 + 2] = Z;
          const lx = X - ox, ly = Y - oy, lz = Z - oz;
          positions[v * 3] = lx; positions[v * 3 + 1] = ly; positions[v * 3 + 2] = lz;
          grow(lx, ly, lz);
          // an embankment squeezed into a few metres is a retaining wall: concrete, not dirt
          uvs[v * 2] = pc.emb && (pc.emb[0] < 0 ? scaleL : scaleR) * EMB_W < WALL ? regionU('concrete', e ? pc.tr : pc.tl) : regionU(tileFor(pc.region, { ...sp.surface, right: q === lastLane }), e ? pc.tr : pc.tl);
          uvs[v * 2 + 1] = vv;
          kind[v] = pc.kind;
          v++;
        }
        // normal = across x along, across running left to right
        let bx = scratch[3] - scratch[0], by = scratch[4] - scratch[1], bz = scratch[5] - scratch[2];
        // a strip of no width (a lane opening in a taper) takes the pavement's own across direction
        if (bx * bx + by * by + bz * bz < 1e-12) { bx = sn; by = -p.crossfall - (p.x * sn - p.y * c) / earthR; bz = c; }
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        if (pc.soffit) { nx = bx; ny = 0; nz = bz; }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const w = (v - 2) * 3;
        normals[w] = normals[w + 3] = nx; normals[w + 1] = normals[w + 4] = ny; normals[w + 2] = normals[w + 5] = nz;
      }
      if (r > 0) {
        const prev = rowBase - np * 2;
        for (let q = 0; q < np; q++) {
          const a = prev + 2 * q, b = a + 1, a2 = rowBase + 2 * q, b2 = a2 + 1;
          stripIdx[ii++] = a; stripIdx[ii++] = b; stripIdx[ii++] = a2;
          stripIdx[ii++] = b; stripIdx[ii++] = b2; stripIdx[ii++] = a2;
        }
      }
    });
    // close a range at each split point and at the end, with the extras that fall inside it
    const atSplit = split > 0 && Math.abs(sp.s1 / split - Math.round(sp.s1 / split)) < 1e-9;
    if (atSplit || k === spans.length - 1) {
      const last = k === spans.length - 1 && sp.s1 >= ref.length - 1e-9;
      extras(ex, road, roads, rangeS0, sp.s1, last, { base, earthR, origin, vBase, grow, lod });
      rangeParts.push({ s0: rangeS0, s1: sp.s1, strip: [rangeStart, ii - rangeStart], extra: [exStart, ex.idx.length - exStart] });
      rangeStart = ii; rangeS0 = sp.s1; exStart = ex.idx.length;
    }
  });

  // join the strips and the extras: vertices one after the other, indices range by range
  const total = v + ex.v;
  const out = {
    positions: v === total ? positions : concatF32(positions, ex.p, total * 3),
    normals: v === total ? normals : concatF32(normals, ex.n, total * 3),
    uvs: v === total ? uvs : concatF32(uvs, ex.uv, total * 2),
    kind: v === total ? kind : concatU8(kind, ex.k, total),
    retro: concatU8(new Uint8Array(v), ex.r, total),
  };
  const indices = total < 65536 ? new Uint16Array(ii + ex.idx.length) : new Uint32Array(ii + ex.idx.length);
  const ranges = [];
  let at = 0;
  for (const rp of rangeParts) {
    const start = at;
    indices.set(stripIdx.subarray(rp.strip[0], rp.strip[0] + rp.strip[1]), at);
    at += rp.strip[1];
    for (let j = 0; j < rp.extra[1]; j++) indices[at++] = ex.idx[rp.extra[0] + j] + v;
    ranges.push({ s0: rp.s0, s1: rp.s1, start, count: at - start });
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const sphere = new Float32Array([cx, cy, cz, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2]);
  return { origin: Float64Array.from(origin), ...out, indices, ranges, sphere, lod, s0, s1 };
}

function concatF32(a, extra, n) { const out = new Float32Array(n); out.set(a); out.set(extra, a.length); return out; }
function concatU8(a, extra, n) { const out = new Uint8Array(n); out.set(a); out.set(extra, a.length); return out; }

/**
 * Gores, deck ends, piers and abutments of `road` within [s0, s1) ([s0, s1] at the road's end),
 * appended to the growable buffers `ex` (indices relative to ex's own vertices).
 */
function extras(ex, road, roads, s0, s1, last, ctx) {
  const inRange = (s) => s >= s0 && (s < s1 || (last && s <= s1));
  const { base, earthR, origin, vBase, grow, lod = 0 } = ctx;
  const twoR = 2 * earthR;
  const put = (mx, my, hh, u, vv, k, retro = 0) => {
    const X = mx, Y = hh - base - (mx * mx + my * my) / twoR, Z = -my;
    const lx = X - origin[0], ly = Y - origin[1], lz = Z - origin[2];
    ex.p.push(lx, ly, lz); ex.uv.push(u, vv); ex.k.push(k); ex.r.push(retro);
    grow(lx, ly, lz);
    return ex.v++;
  };
  const p = {};
  const ref = reflineOf(road);
  // a flat quad (corners as [mx, my, h]) with its own normal, wound so the normal faces `n`
  const quad = (pts, n, region = 'concrete', k = KIND.structure) => {
    const i0 = ex.v;
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    pts.forEach(([mx, my, h], j) => { put(mx, my, h, regionU(region, uvs[j][0]), uvs[j][1], k); ex.n.push(n[0], n[1], n[2]); });
    if (pts.length === 4) ex.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3); else ex.idx.push(i0, i0 + 1, i0 + 2);
  };
  // scene normal of a face from three map-space corners, oriented by the winding
  const faceN = (a, b, c) => {
    const A = [a[0], a[2], -a[1]], B = [b[0], b[2], -b[1]], C = [c[0], c[2], -c[1]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const face = (pts) => quad(pts, faceN(pts[0], pts[1], pts[2]));

  // gores: from the road's gore edge to the other road's pavement edge, at this road's stations
  for (const g of road.gores || []) {
    const ga = g.gore.a, gb = g.gore.b;
    const a0 = Math.max(s0, ga[0]), a1 = Math.min(s1, ga[ga.length - 1]);
    if (!(a1 > a0) || !roads) continue;
    const other = roads[g.b.index];
    const oref = reflineOf(other);
    const rows = [a0];
    for (let s = Math.floor(a0 / road.spacing + 1e-9) * road.spacing + road.spacing; s < a1 - 1e-6; s += road.spacing) rows.push(s);
    rows.push(a1);
    let prev = -1;
    const q = {};
    for (const s of rows) {
      let k = 1;
      while (k < ga.length - 1 && ga[k] < s) k++;
      const t = Math.min(1, Math.max(0, (s - ga[k - 1]) / (ga[k] - ga[k - 1])));
      const rs = gb[k - 1] + t * (gb[k] - gb[k - 1]);
      const cs = edgesAt(road, s, s >= a1 ? 'before' : 'after');
      const da = goreEdge(cs, g.side);
      ref.at(s, p);
      const ocs = edgesAt(other, rs);
      const db = g.side === 'right' ? ocs.left : ocs.right;
      oref.at(rs, q);
      const A = [p.x - da * Math.sin(p.heading), p.y + da * Math.cos(p.heading), p.h + p.crossfall * da];
      const B = [q.x - db * Math.sin(q.heading), q.y + db * Math.cos(q.heading), q.h + q.crossfall * db];
      const [lp, rp] = g.side === 'right' ? [A, B] : [B, A];
      const vv = (s - vBase) / CYCLE;
      const i0 = put(lp[0], lp[1], lp[2], regionU('gore', 0), vv, KIND.shoulder);
      put(rp[0], rp[1], rp[2], regionU('gore', 1), vv, KIND.shoulder);
      // normal: up, tilted by the crossfall of the strip
      const ax = Math.cos(p.heading), az = -Math.sin(p.heading), ay = p.grade;
      const bx = rp[0] - lp[0], by = rp[2] - lp[2], bz = -(rp[1] - lp[1]);
      let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
      if (bx * bx + bz * bz < 1e-8) { nx = 0; ny = 1; nz = 0; }
      const l = Math.hypot(nx, ny, nz) || 1;
      ex.n.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
      if (prev >= 0) ex.idx.push(prev, prev + 1, i0, prev + 1, i0 + 1, i0);
      prev = i0;
    }
  }

  // barriers: swept profiles, posts and reflectors (src/drive/roadside/sweep.js)
  if (road.barriers?.length) {
    const q = {};
    const BK = { barrier: KIND.barrier, reflector: KIND.reflector };
    sweepBarriers(road.barriers, s0, s1, last, {
      lod,
      step: LOD_STRIDE[lod] * road.spacing,
      vAt: (s) => (s - vBase) / CYCLE,
      frameAt(s, side, o, wallZ) {
        ref.at(s, q);
        const cs = edgesAt(road, s);
        const left = side === 'left';
        const edge = left ? cs.left : cs.right, sgn = left ? 1 : -1;
        const d = edge + sgn * o;
        const sn = Math.sin(q.heading), c = Math.cos(q.heading);
        const hEdge = q.h + q.crossfall * edge;
        let h;
        if (wallZ !== null) h = hEdge + wallZ;
        else if (o <= 0) h = q.h + q.crossfall * d;
        else {
          const [scL, scR] = embScales(road, q, cs.left, cs.right, s);
          const sc = left ? scL : scR;
          // over an embankment squeezed into a wall the barrier stands at the edge, on top of it
          h = sc * EMB_W < WALL ? hEdge : hEdge - embDrop(o / sc);
        }
        return { x: q.x - d * sn, y: q.y + d * c, h, ox: -sn * sgn, oy: c * sgn, fx: c, fy: sn };
      },
      put: (mx, my, h, region, tt, vv, kind, retro) => put(mx, my, h, regionU(region, tt), vv, BK[kind], retro),
      normal: (nx, ny, nz) => { ex.n.push(nx, ny, nz); },
      tri: (a, b, c) => { ex.idx.push(a, b, c); },
    });
  }

  // deck ends: close the slab where a deck begins and ends
  for (const b of road.bridges || []) {
    if (!b.deck) continue;
    for (const [s, dir] of [[b.s0, -1], [b.s1, 1]]) {
      if (!inRange(s)) continue;
      const cs = edgesAt(road, s, dir < 0 ? 'after' : 'before');
      ref.at(s, p);
      const c = Math.cos(p.heading), sn = Math.sin(p.heading);
      const at = (d, z) => [p.x - d * sn, p.y + d * c, p.h + p.crossfall * d + z];
      const L = cs.left, R = cs.right;
      const pts = dir > 0 ? [at(L, -DECK), at(L, PARAPET.h), at(R, PARAPET.h), at(R, -DECK)] : [at(R, -DECK), at(R, PARAPET.h), at(L, PARAPET.h), at(L, -DECK)];
      face(pts);
    }
  }

  // piers and abutments
  for (const st of road.structures || []) {
    if (!inRange(st.s)) continue;
    ref.at(st.s, p);
    const c = Math.cos(p.heading), sn = Math.sin(p.heading);
    // map point at (along a, across d) from the structure's station
    const at = (a, d, h) => [p.x + a * c - d * sn, p.y + a * sn + d * c, h];
    if (st.kind === 'pier') {
      const t = st.t / 2, wl = st.d + st.w / 2, wr = st.d - st.w / 2;
      const lo = st.h0, hi = st.h1;
      // four sides and a cap, each wound to face outward
      face([at(-t, wr, lo), at(t, wr, lo), at(t, wr, hi), at(-t, wr, hi)]); // right
      face([at(t, wl, lo), at(-t, wl, lo), at(-t, wl, hi), at(t, wl, hi)]); // left
      face([at(t, wr, lo), at(t, wl, lo), at(t, wl, hi), at(t, wr, hi)]); // ahead
      face([at(-t, wl, lo), at(-t, wr, lo), at(-t, wr, hi), at(-t, wl, hi)]); // behind
      face([at(-t, wr, hi), at(t, wr, hi), at(t, wl, hi), at(-t, wl, hi)]); // cap
    } else if (st.kind === 'abutment') {
      const a1 = st.dir * st.len, wl = st.d + st.w / 2, wr = st.d - st.w / 2;
      const T0 = at(0, wr, st.h1), T1 = at(0, wl, st.h1), B0 = at(a1, wr, st.h0), B1 = at(a1, wl, st.h0);
      const G0 = at(0, wr, st.h0), G1 = at(0, wl, st.h0);
      if (st.dir > 0) {
        face([B0, B1, T1, T0]); // the slope, facing up and into the span
        face([G0, B0, T0]); // right side
        face([B1, G1, T1]); // left side
      } else {
        face([T0, T1, B1, B0]);
        face([B0, G0, T0]);
        face([G1, B1, T1]);
      }
    }
  }
}

/** The buffers of a meshChunk result, for postMessage's transfer list. */
export const transferablesOf = (m) => [m.origin.buffer, m.positions.buffer, m.normals.buffer, m.uvs.buffer, m.kind.buffer, m.retro.buffer, m.indices.buffer, m.sphere.buffer];

/**
 * Mesh several stretches (of any roads) into one set of buffers with one shared origin, with an
 * index range per group: parts = [{ road, s0, s1, group }], groups numbered 0..groups-1 in order.
 * For the chunks that gather the small roads of an interchange.
 */
export function meshParts({ parts, groups, lod, base, earthR, origin, roads }) {
  if (!origin && parts.length) {
    // one origin for all: the first part's middle, rounded to whole metres
    const p = {};
    reflineOf(roads[parts[0].road]).at((parts[0].s0 + parts[0].s1) / 2, p);
    origin = [Math.round(p.x), Math.round(p.h - base - (p.x * p.x + p.y * p.y) / (2 * earthR)), Math.round(-p.y)];
  }
  const fixed = parts.map((pt) => meshChunk({ road: roads[pt.road], s0: pt.s0, s1: pt.s1, lod, base, earthR, origin, roads }));
  let nv = 0, ni = 0;
  for (const m of fixed) { nv += m.kind.length; ni += m.indices.length; }
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2), kind = new Uint8Array(nv), retro = new Uint8Array(nv);
  const indices = nv < 65536 ? new Uint16Array(ni) : new Uint32Array(ni);
  const ranges = Array.from({ length: groups }, (_, g) => ({ group: g, start: 0, count: 0 }));
  let v = 0, at = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let g = 0; g < groups; g++) {
    ranges[g].start = at;
    fixed.forEach((m, i) => {
      if (parts[i].group !== g) return;
      positions.set(m.positions, v * 3); normals.set(m.normals, v * 3); uvs.set(m.uvs, v * 2); kind.set(m.kind, v); retro.set(m.retro, v);
      for (let j = 0; j < m.indices.length; j++) indices[at++] = m.indices[j] + v;
      const [cx, cy, cz, r] = m.sphere;
      minX = Math.min(minX, cx - r); maxX = Math.max(maxX, cx + r);
      minY = Math.min(minY, cy - r); maxY = Math.max(maxY, cy + r);
      minZ = Math.min(minZ, cz - r); maxZ = Math.max(maxZ, cz + r);
      v += m.kind.length;
    });
    ranges[g].count = at - ranges[g].start;
  }
  const sphere = new Float32Array(nv ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2] : [0, 0, 0, 0]);
  return { origin: Float64Array.from(origin || [0, 0, 0]), positions, normals, uvs, kind, retro, indices, ranges, sphere, lod, s0: 0, s1: 0 };
}
