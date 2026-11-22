// Pure layout for the route bar's track: one tick per exit and named place, the reveal, the next exit
// ahead and the words a screen reader hears for the car's place. Positions are fractions of the route,
// so the DOM only multiplies by the track's width.

import { formatDistance } from './format.js';

/** Markers this close together (metres) are one tick: an exit and the place it serves. */
const SAME_PLACE = 50;
/** The car counts as at a point within this distance (metres). */
const AT = 150;

/** How a marker reads: "Exit 38 · Flamingo Road", "Harmon Avenue", "Jean", "Exit". */
export function markerLabel(m) {
  if (m.kind === 'exit') {
    const name = m.label && m.label !== 'Exit' ? m.label : '';
    if (m.ref) return name ? `Exit ${m.ref} · ${name}` : `Exit ${m.ref}`;
    return name || 'Exit';
  }
  return m.label || '';
}

/**
 * The track's ticks, in order along the route.
 * @param {{ s0: number, s1: number, markers: object[], reveal?: { s: number, label?: string } | null }} route
 * @returns {{ s: number, at: number, kind: 'exit'|'place'|'reveal', label: string }[]}
 *   at is the fraction of the way from s0 to s1; kind 'place' wins over 'exit' when they share a spot
 */
export function layoutTicks({ s0, s1, markers, reveal }) {
  const span = Math.max(1, s1 - s0);
  const ticks = [];
  const list = [...(markers || [])];
  if (reveal && Number.isFinite(reveal.s) && !list.some((m) => m.kind === 'reveal')) list.push({ s: reveal.s, kind: 'reveal', label: reveal.label });
  list.sort((a, b) => a.s - b.s);
  for (const m of list) {
    if (!Number.isFinite(m.s) || m.s < s0 - 1 || m.s > s1 + 1) continue;
    const label = m.kind === 'reveal' ? (reveal?.label || m.label || 'The view opens') : markerLabel(m);
    const kind = m.kind === 'reveal' ? 'reveal' : m.kind === 'place' ? 'place' : 'exit';
    const prev = ticks[ticks.length - 1];
    if (prev && kind !== 'reveal' && prev.kind !== 'reveal' && Math.abs(m.s - prev.s) < SAME_PLACE) {
      // an exit and its place: keep the exit's fuller name, but draw it as a place
      if (kind === 'place') { prev.kind = 'place'; if (!prev.label) prev.label = label; }
      else if (prev.kind === 'place' && label) prev.label = label;
      continue;
    }
    ticks.push({ s: m.s, at: Math.min(1, Math.max(0, (m.s - s0) / span)), kind, label });
  }
  return ticks;
}

/** The first exit strictly ahead of s (more than a few metres), or null past the last one. */
export function nextExit(markers, s) {
  let best = null;
  for (const m of markers || []) if (m.kind === 'exit' && m.s > s + 5 && (!best || m.s < best.s)) best = m;
  return best;
}

/** The tick nearest to s, or null when there are none. */
export function nearestTick(ticks, s) {
  let best = null;
  for (const t of ticks) if (!best || Math.abs(t.s - s) < Math.abs(best.s - s)) best = t;
  return best;
}

/**
 * The tick whose drawn position lies within `px` pixels of x on a track `width` pixels wide, or null.
 * The nearest wins, so a pointer among the city's bunched exits picks the one under it.
 */
export function tickAtPixel(ticks, x, width, px = 8) {
  let best = null, bestD = Infinity;
  for (const t of ticks) {
    const d = Math.abs(t.at * width - x);
    if (d <= px && d < bestD) { best = t; bestD = d; }
  }
  return best;
}

/**
 * What the bar says about the road ahead: the next exit and how far, the destination after the last
 * exit, or that the car has arrived.
 * @param {{ s: number, s1: number, markers: object[], to?: string, units: 'ft'|'m' }} o
 */
export function aheadText({ s, s1, markers, to, units }) {
  const end = to || 'the end of the route';
  if (s >= s1 - 1) return { arrived: true, text: `Arrived at ${end}` };
  const m = nextExit(markers, s);
  if (m) return { arrived: false, text: `Next: ${markerLabel(m)}`, dist: formatDistance(m.s - s, units) };
  return { arrived: false, text: `Next: ${end}`, dist: formatDistance(s1 - s, units) };
}

/**
 * The slider's aria-valuetext: how far along, and the nearest named point.
 * "26.4 of 42.5 mi, 0.4 mi past Exit 25 · Sloan"
 */
export function placeText({ s, s0, s1, ticks, units }) {
  const along = formatDistance(s - s0, units), total = formatDistance(s1 - s0, units);
  const unit = (t) => t.slice(t.lastIndexOf(' '));
  const head = `${unit(along) === unit(total) ? along.slice(0, -unit(along).length) : along} of ${total}`;
  const near = nearestTick(ticks, s);
  if (!near) return head;
  const d = s - near.s;
  if (Math.abs(d) <= AT) return `${head}, at ${near.label}`;
  return `${head}, ${formatDistance(Math.abs(d), units)} ${d > 0 ? 'past' : 'before'} ${near.label}`;
}
