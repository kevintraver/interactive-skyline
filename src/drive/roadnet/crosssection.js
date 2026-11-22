/**
 * The cross-section of a road at a chainage: where every lane and shoulder edge is, and what lies
 * between them. Offsets are metres from the reference line, POSITIVE TO THE LEFT of travel.
 *
 * Today a section's cross-section is constant and sections change abruptly at their s0. Lane-count
 * tapers will arrive through this same function, so callers must ask again for every s rather than
 * assume the answer holds along a section. Pure; no three.
 */

const cache = new WeakMap(); // section -> cross-section; valid only while sections are constant

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
function leftEdgeOffset(sec) {
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

function build(sec, index) {
  const strips = [];
  const lines = [];
  let d = leftEdgeOffset(sec);
  const leftOuter = d + sec.left.shoulder;
  strips.push({ kind: 'shoulder', side: 'left', left: leftOuter, right: d });
  lines.push({ d, kind: sec.left.edge, edge: 'left' });
  sec.lanes.forEach((lane, i) => {
    const right = d - lane.w;
    strips.push({ kind: 'lane', lane: i, laneKind: lane.kind, left: d, right });
    if (i < sec.lanes.length - 1) lines.push({ d: right, kind: lane.line, edge: 'lane' });
    d = right;
  });
  lines.push({ d, kind: sec.right.edge, edge: 'right' });
  strips.push({ kind: 'shoulder', side: 'right', left: d, right: d - sec.right.shoulder });
  const edges = [leftOuter, ...lines.map((l) => l.d), d - sec.right.shoulder];
  return { sectionIndex: index, section: sec, strips, lines, edges, left: leftOuter, right: edges[edges.length - 1] };
}

/**
 * Cross-section at s.
 * @param {object} road a decoded road
 * @param {number} s chainage, metres
 * @param {'after'|'before'} [side] at a section boundary, which section to describe
 * @returns {{ sectionIndex: number, section: object,
 *   strips: { kind: 'shoulder'|'lane', side?: 'left'|'right', lane?: number, laneKind?: string, left: number, right: number }[],
 *   lines: { d: number, kind: 'yellow'|'white'|'broken'|'solid'|'none', edge: 'left'|'lane'|'right' }[],
 *   edges: number[], left: number, right: number }}
 *   strips run left to right (left shoulder, lanes 1..n, right shoulder) with left > right;
 *   `lines` are the lane boundaries from the left pavement edge to the right one; `edges` are all
 *   strip boundaries left to right; `left` and `right` are the outer shoulder edges.
 *   The result is shared: do not modify it.
 */
export function edgesAt(road, s, side = 'after') {
  const index = sectionIndexAt(road, s, side);
  const sec = road.sections[index];
  let out = cache.get(sec);
  if (!out) { out = build(sec, index); cache.set(sec, out); }
  return out;
}
