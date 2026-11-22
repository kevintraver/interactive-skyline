/**
 * The cross-section of a road at a chainage: where every lane and shoulder edge is, and what lies
 * between them. Offsets are metres from the reference line, POSITIVE TO THE LEFT of travel.
 *
 * Outside a taper a section's cross-section is constant; inside one it blends from the previous
 * section's to the next one's as format.js specifies ("lanes and tapers"). Callers must ask again
 * for every s. scripts/lib/crosssection.py is the Python twin; tests hold the two to 1 mm.
 * Pure; no three.
 */

const cache = new WeakMap(); // section -> its constant cross-section
const unions = new WeakMap(); // section with a taper -> the union of lane ids across it

/** Index of the section containing s; at a boundary, the one starting there unless `side` is 'before'. */
export function sectionIndexAt(road, s, side = 'after') {
  const secs = road.sections;
  let lo = 0, hi = secs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (side === 'before' ? secs[mid].s0 < s : secs[mid].s0 <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Offset of lane 1's left edge from the reference line, from the section's placement. */
export function leftEdgeOffset(sec) {
  const widths = sec.lanes.map((l) => l.w);
  const total = widths.reduce((a, b) => a + b, 0);
  if (sec.placement === 'centre') return total / 2;
  const [kind, num] = sec.placement.split(':');
  const n = +num;
  const before = widths.slice(0, n - 1).reduce((a, b) => a + b, 0);
  if (kind === 'left_of') return before;
  if (kind === 'middle_of') return before + widths[n - 1] / 2;
  return before + widths[n - 1]; // right_of
}

/** Smootherstep, the taper blend. */
export const blend = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

/** Lane ids of two consecutive sections merged in order: previous-only first, then this-only, then shared. */
export function unionIds(a, b) {
  const inA = new Set(a), inB = new Set(b);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && !inB.has(a[i])) out.push(a[i++]);
    else if (j < b.length && !inA.has(b[j])) out.push(b[j++]);
    else { out.push(a[i]); i++; j++; }
  }
  return out;
}

/**
 * Assemble a cross-section from lanes { id, w, kind, line } left to right, the left edge offset,
 * the shoulders and the edge kinds. `hidden(i)` says whether the line right of lane i is hidden.
 */
function assemble({ index, sec, lanes, o, sl, sr, edgeL, edgeR, hidden, taper }) {
  const strips = [];
  const lines = [];
  let d = o;
  const leftOuter = d + sl;
  strips.push({ kind: 'shoulder', side: 'left', left: leftOuter, right: d });
  lines.push({ d, kind: edgeL, edge: 'left' });
  lanes.forEach((lane, i) => {
    const right = d - lane.w;
    strips.push({ kind: 'lane', lane: i, id: lane.id, laneKind: lane.kind, left: d, right });
    if (i < lanes.length - 1) lines.push({ d: right, kind: hidden && hidden(i) ? 'none' : lane.line, edge: 'lane' });
    d = right;
  });
  lines.push({ d, kind: edgeR, edge: 'right' });
  strips.push({ kind: 'shoulder', side: 'right', left: d, right: d - sr });
  const edges = [leftOuter, ...lines.map((l) => l.d), d - sr];
  return { sectionIndex: index, section: sec, strips, lines, edges, left: leftOuter, right: edges[edges.length - 1], taper };
}

function build(sec, index) {
  return assemble({ index, sec, lanes: sec.lanes, o: leftEdgeOffset(sec), sl: sec.left.shoulder, sr: sec.right.shoulder, edgeL: sec.left.edge, edgeR: sec.right.edge, taper: null });
}

const taperLists = new WeakMap(); // sections array -> [{ i, from, s0, s1 }] in order

/** The road's tapers in order: the section each belongs to and the section it blends from. */
export function tapersOf(road) {
  let list = taperLists.get(road.sections);
  if (!list) {
    list = [];
    road.sections.forEach((sec, i) => {
      if (!sec.taper) return;
      let from = i - 1;
      while (from > 0 && road.sections[from].s0 > sec.taper.s0) from--;
      list.push({ i, from, s0: sec.taper.s0, s1: sec.taper.s1 });
    });
    taperLists.set(road.sections, list);
  }
  return list;
}

/** The taper holding s ('after': s0 <= s < s1; 'before': s0 < s <= s1), or null. */
export function taperAt(road, s, side = 'after') {
  const list = tapersOf(road);
  let lo = 0, hi = list.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (side === 'before' ? list[mid].s0 < s : list[mid].s0 <= s) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0) return null;
  const tp = list[k];
  return (side === 'before' ? s <= tp.s1 : s < tp.s1) ? tp : null;
}

/** The blended cross-section inside taper tp. */
function blended(road, tp, s, side, index) {
  const prev = road.sections[tp.from], cur = road.sections[tp.i];
  let ids = unions.get(cur);
  if (!ids) { ids = unionIds(prev.lanes.map((l) => l.id), cur.lanes.map((l) => l.id)); unions.set(cur, ids); }
  const t = (s - tp.s0) / (tp.s1 - tp.s0);
  const u = blend(t);
  const mid = (tp.s0 + tp.s1) / 2; // kinds switch here; compared in s so the mesher's cut row agrees
  const late = side === 'before' ? s > mid : s >= mid;
  const byId = (sec) => new Map(sec.lanes.map((l) => [l.id, l]));
  const pa = byId(prev), pb = byId(cur);
  const lanes = ids.map((id) => {
    const a = pa.get(id), b = pb.get(id);
    return { id, w: (1 - u) * (a ? a.w : 0) + u * (b ? b.w : 0), kind: (b || a).kind, line: (b || a).line, onlyPrev: !b, onlyCur: !a };
  });
  const thin = (l) => (late ? l.onlyPrev : l.onlyCur);
  const from = late ? cur : prev;
  return assemble({
    index, sec: road.sections[index], lanes,
    o: (1 - u) * leftEdgeOffset(prev) + u * leftEdgeOffset(cur),
    sl: (1 - u) * prev.left.shoulder + u * cur.left.shoulder,
    sr: (1 - u) * prev.right.shoulder + u * cur.right.shoulder,
    edgeL: from.left.edge, edgeR: from.right.edge,
    hidden: (k) => thin(lanes[k]) || thin(lanes[k + 1]),
    taper: { index: tp.i, from: tp.from, t, u, half: late ? 1 : 0 },
  });
}

/**
 * Cross-section at s.
 * @param {object} road a decoded road
 * @param {number} s chainage, metres
 * @param {'after'|'before'} [side] 'after': the cross-section that holds from s on; 'before': the one
 *   that holds up to s. They differ only at a section boundary, at the ends of a taper and at its
 *   middle (where kinds change); the geometry is the same either way except at an abrupt boundary.
 * @returns {{ sectionIndex: number, section: object,
 *   strips: { kind: 'shoulder'|'lane', side?: 'left'|'right', lane?: number, id?: number, laneKind?: string, left: number, right: number }[],
 *   lines: { d: number, kind: 'yellow'|'white'|'broken'|'solid'|'none', edge: 'left'|'lane'|'right' }[],
 *   edges: number[], left: number, right: number, taper: { index: number, from: number, t: number, u: number, half: 0|1 }|null }}
 *   strips run left to right (left shoulder, lanes, right shoulder) with left >= right; in a taper
 *   the lanes are the union of both sections' (a lane may be very narrow) and `lane` is the index
 *   in that list, `id` the lane's identity. `lines` are the lane boundaries from the left pavement
 *   edge to the right one; `edges` are all strip boundaries left to right; `left` and `right` are
 *   the outer shoulder edges. The result may be shared: do not modify it.
 */
export function edgesAt(road, s, side = 'after') {
  const index = sectionIndexAt(road, s, side);
  const tp = taperAt(road, s, side);
  if (tp) return blended(road, tp, s, side, index);
  const sec = road.sections[index];
  let out = cache.get(sec);
  if (!out) { out = build(sec, index); cache.set(sec, out); }
  return out;
}

/** Centre offset of the lane with this id at s, or null where the road has no such lane there. */
export function laneCentreAt(road, id, s, side = 'after') {
  const st = edgesAt(road, s, side).strips.find((x) => x.kind === 'lane' && x.id === id);
  return st ? (st.left + st.right) / 2 : null;
}
